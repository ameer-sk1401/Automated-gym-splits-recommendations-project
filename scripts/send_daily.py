#!/usr/bin/env python3
from __future__ import annotations
from pathlib import Path
import os, json, time, smtplib, ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from jinja2 import Template
from urllib.parse import urlencode

# --- local imports ---
from scripts.lib.utils import BASE, load_json, today_local_iso, weekday_name
from scripts.lib.templates import load_email_template

CONFIG = BASE / "config"
SPLITS = BASE / "splits"

# ---- ENV (set these in GitHub Actions / local env) ----
SMTP_HOST      = os.environ.get("SMTP_HOST", "")
SMTP_PORT      = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USERNAME  = os.environ.get("SMTP_USERNAME", "")
SMTP_PASSWORD  = os.environ.get("SMTP_PASSWORD", "")
FROM_EMAIL     = os.environ.get("FROM_EMAIL", "")
SUBMIT_BASE_URL= os.environ.get("SUBMIT_BASE_URL", "https://example.com/submit")

# ---- Helpers ----
def build_link(base: str, params: dict) -> str:
    # Phase 2.5: still naive querystrings (we’ll HMAC‑sign in Phase 3)
    return f"{base}?{urlencode(params)}"

def render_email_html(recipient: dict, split: dict, date_str: str) -> str:
    tmpl = Template(load_email_template())
    items = []
    for ex in split["exercises"]:
        params = {"u": recipient["id"], "d": date_str, "ex": ex["id"]}
        items.append({
            "name": ex["name"],
            "sets": ex.get("sets"),
            "reps": ex.get("reps"),
            "link": build_link(SUBMIT_BASE_URL, params),
        })
    complete_all_link = build_link(SUBMIT_BASE_URL, {"u": recipient["id"], "d": date_str, "ex": "ALL"})

    return tmpl.render(
        name=recipient.get("name", recipient["id"]),
        title=split.get("title", "Today's Workout"),
        date=date_str,
        items=items,
        complete_all_link=complete_all_link
    )

def build_message(from_email: str, to_email: str, subject: str, html_body: str) -> MIMEMultipart:
    # Provide a minimal plain‑text alternative for deliverability
    text_fallback = "Open this email in an HTML-capable client to view your workout and completion links."

    msg = MIMEMultipart("alternative")
    msg["From"] = from_email
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(text_fallback, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))
    return msg

def smtp_send(msg: MIMEMultipart, to_addr: str, retries: int = 3, backoff: float = 1.5):
    attempt = 0
    last_err = None
    while attempt < retries:
        try:
            context = ssl.create_default_context()
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as server:
                server.ehlo()
                # Use STARTTLS on ports like 587; skip for 465 (implicit TLS)
                if SMTP_PORT != 465:
                    server.starttls(context=context)
                    server.ehlo()
                if SMTP_USERNAME:
                    server.login(SMTP_USERNAME, SMTP_PASSWORD)
                server.sendmail(msg["From"], [to_addr], msg.as_string())
            return
        except Exception as e:
            last_err = e
            attempt += 1
            if attempt < retries:
                time.sleep(backoff ** attempt)
    # If we got here, all retries failed
    raise RuntimeError(f"Failed to send to {to_addr}: {last_err}")

def main():
    # Sanity checks
    required = ["SMTP_HOST", "SMTP_PORT", "FROM_EMAIL"]
    missing = [k for k in required if not globals()[k]]
    if missing:
        raise SystemExit(f"Missing required env vars: {', '.join(missing)}")

    recipients = load_json(CONFIG / "recipients.json")
    schedule   = load_json(CONFIG / "schedule.json")

    day = weekday_name()
    date_str = today_local_iso()
    split_file = schedule.get(day) or schedule.get(day.lower())
    if not split_file:
        print(f"No split configured for {day}; nothing to send.")
        return
    split = load_json(SPLITS / split_file)

    for r in recipients:
        html = render_email_html(r, split, date_str)
        subject = f"[Gym Split] {split.get('title','Workout')} – {date_str}"
        msg = build_message(FROM_EMAIL, r["email"], subject, html)
        print(f"→ Sending to {r['email']} ...")
        smtp_send(msg, r["email"])
    print("✅ All emails sent.")

if __name__ == "__main__":
    main()