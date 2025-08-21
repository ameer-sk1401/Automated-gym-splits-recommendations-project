#!/usr/bin/env python3
from __future__ import annotations
from pathlib import Path
import os, json, datetime
from zoneinfo import ZoneInfo
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import smtplib, ssl

# local imports
from scripts.lib.utils import BASE, load_json

STATE = BASE / "state"
CONFIG = BASE / "config"

SMTP_HOST       = os.environ.get("SMTP_HOST", "").strip()
SMTP_PORT       = int(str(os.environ.get("SMTP_PORT", "587")).strip())
SMTP_USERNAME   = os.environ.get("SMTP_USERNAME", "").strip()
SMTP_PASSWORD   = os.environ.get("SMTP_PASSWORD", "").strip()
FROM_EMAIL      = os.environ.get("FROM_EMAIL", "").strip()

def daterange_days(end: datetime.date, days: int):
    return [(end - datetime.timedelta(days=i)).isoformat() for i in range(days)][::-1]

def summarize_week(days: list[str]):
    per_user = {}   # uid -> {sent, done}
    per_ex   = {}   # ex  -> count
    for d in days:
        p = STATE / f"{d}.json"
        if not p.exists(): 
            continue
        j = json.loads(p.read_text(encoding="utf-8"))
        comp = j.get("completions", {})
        for uid, exmap in comp.items():
            st = per_user.setdefault(uid, {"sent": 0, "done": 0})
            st["sent"] += 1
            if any(exmap.values()):
                st["done"] += 1
            for ex, val in exmap.items():
                if val: per_ex[ex] = per_ex.get(ex, 0) + 1
    return per_user, per_ex

def build_html(per_user, per_ex, start, end):
    rows_users = "\n".join(
        f"<tr><td>{uid}</td><td>{v['sent']}</td><td>{v['done']}</td><td>{round((v['done']/v['sent']*100) if v['sent'] else 0)}%</td></tr>"
        for uid, v in per_user.items()
    ) or '<tr><td colspan="4">No data</td></tr>'
    rows_ex = "\n".join(
        f"<tr><td>{ex}</td><td>{cnt}</td></tr>" for ex, cnt in sorted(per_ex.items(), key=lambda x:-x[1])
    ) or '<tr><td colspan="2">No data</td></tr>'
    return f"""<!doctype html><meta charset="utf-8">
<style>
table{{border-collapse:collapse}}td,th{{border:1px solid #e5e7eb;padding:6px 8px}}th{{background:#f9fafb}}
body{{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial}}
</style>
<h2>Weekly Summary ({start} → {end})</h2>
<h3>Per user</h3>
<table><thead><tr><th>User</th><th>Days sent</th><th>Days completed ≥1</th><th>Rate</th></tr></thead><tbody>
{rows_users}
</tbody></table>
<h3>Per exercise</h3>
<table><thead><tr><th>Exercise</th><th>Times completed</th></tr></thead><tbody>
{rows_ex}
</tbody></table>
<p style="color:#6b7280">Dashboard: GitHub Pages → docs/index.html</p>
"""

def send_html(to_email, subject, html):
    msg = MIMEMultipart("alternative")
    msg["From"] = FROM_EMAIL
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText("View the weekly summary in an HTML-capable client.", "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))

    if SMTP_PORT == 465:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20, context=context) as s:
            if SMTP_USERNAME: s.login(SMTP_USERNAME, SMTP_PASSWORD)
            s.sendmail(FROM_EMAIL, [to_email], msg.as_string())
    else:
        context = ssl.create_default_context()
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
            s.starttls(context=context)
            if SMTP_USERNAME: s.login(SMTP_USERNAME, SMTP_PASSWORD)
            s.sendmail(FROM_EMAIL, [to_email], msg.as_string())

def main():
    tz = "America/New_York"
    today = datetime.datetime.now(ZoneInfo(tz)).date()
    # summarize last 7 days (Mon-Sun pattern not required)
    days = daterange_days(today, 7)
    start, end = days[0], days[-1]
    per_user, per_ex = summarize_week(days)

    html = build_html(per_user, per_ex, start, end)

    recipients = load_json(CONFIG / "recipients.json")
    subject = f"[Gym Split] Weekly Summary {start} → {end}"

    # send to each recipient (or change to send just to you)
    for r in recipients:
        send_html(r["email"], subject, html)
        print("sent to", r["email"])

if __name__ == "__main__":
    main()