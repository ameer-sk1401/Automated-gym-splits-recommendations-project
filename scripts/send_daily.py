#!/usr/bin/env python3
# scripts/send_daily.py

import os
import json
import time
import hmac
import base64
import hashlib
import smtplib
from pathlib import Path
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from jinja2 import Template
from datetime import date, timedelta

# ----- project libs -----
from scripts.lib.utils import BASE, load_json, today_local_iso
from scripts.lib.templates import load_email_template

# ---------- ENV ----------
SUBMIT_BASE_URL = os.environ.get("SUBMIT_BASE_URL", "").strip()    # e.g. https://gym-data-submission.netlify.app/submit
NETLIFY_BASE    = os.environ.get("NETLIFY_BASE", "").strip()       # e.g. https://gym-data-submission.netlify.app
SIGNING_SECRET  = os.environ.get("SIGNING_SECRET", "").strip()

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USERNAME = os.environ.get("SMTP_USERNAME", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
FROM_EMAIL    = os.environ.get("FROM_EMAIL", SMTP_USERNAME)

# ---------- PATHS ----------
CONFIG         = BASE / "config"
RECIPIENTS_FN  = CONFIG / "recipients.json"
SPLITS_DIR     = BASE / "splits"                 # default rotation split JSONs
WORKOUT_SPLITS = BASE / "workout_splits"         # per-user plans -> workout_splits/<username>/plan.json
SCHEDULES_DIR  = BASE / "schedules"              # per-user rotation state -> schedules/<username>.json
OUT_DIR        = BASE / ".out"                   # preview copies (optional)

# Default rotation titles (must map to files in SPLITS_DIR via slug)
DEFAULT_ROTATION = ["Push day", "Pull day", "Leg day"]


# ========= helpers =========

def slug(s: str) -> str:
    return "".join([c.lower() if c.isalnum() else "-" for c in s]).strip("-").replace("--", "-")

def weekday_name_iso(d: str) -> str:
    y, m, dd = map(int, d.split("-"))
    return date(y, m, dd).strftime("%A")

def load_user_plan(username: str):
    p = WORKOUT_SPLITS / username / "plan.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return None

def load_split_by_title(title: str) -> dict:
    """
    Reads a split JSON by human title.
    Expect files like splits/push-day.json, splits/pull-day.json, splits/leg-day.json
    with schema:
      { "title": "Push day", "exercises": [ {"id":"bench_press","name":"Bench Press","sets":3,"reps":"8-10"}, ... ] }
    """
    fn = SPLITS_DIR / f"{slug(title)}.json"
    if not fn.exists():
        raise FileNotFoundError(f"Missing split file: {fn}")
    return json.loads(fn.read_text(encoding="utf-8"))

def load_sched(username: str) -> dict:
    SCHEDULES_DIR.mkdir(parents=True, exist_ok=True)
    p = SCHEDULES_DIR / f"{username}.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"current_index": 0, "last_action_date": None, "last_action": "NONE"}

def save_sched(username: str, sched: dict):
    SCHEDULES_DIR.mkdir(parents=True, exist_ok=True)
    p = SCHEDULES_DIR / f"{username}.json"
    p.write_text(json.dumps(sched, indent=2), encoding="utf-8")

def pick_today_index(username: str, today: str, total: int) -> int:
    """
    Rotation rule:
      - If last_action == "SKIPPED" and last_action_date is yesterday or today -> DO NOT advance (freeze)
      - Else (COMPLETED or NONE) -> ADVANCE by 1 (wrap)
    Set today's baseline to "NONE" (submit endpoint will update it after clicks).
    """
    sched = load_sched(username)
    idx = int(sched.get("current_index", 0)) % max(1, total)
    last_action = sched.get("last_action", "NONE")
    last_date   = sched.get("last_action_date")

    yd = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    freeze = (last_action == "SKIPPED") and (last_date is not None) and (last_date >= yd)

    if not freeze:
        idx = (idx + 1) % max(1, total)

    # baseline for today; submit function will flip action
    sched.update({"current_index": idx, "last_action": "NONE", "last_action_date": today})
    save_sched(username, sched)
    return idx

def build_link(base_url: str, params: dict) -> str:
    """
    Build a signed URL for /submit clicks.
    Signs the given params (expects at least u,d,ex,ts) with SIGNING_SECRET
    and appends t=<signature>. Uses URL-safe base64 without padding.
    """
    if not base_url:
        raise RuntimeError("SUBMIT_BASE_URL is empty")
    if not SIGNING_SECRET:
        raise RuntimeError("SIGNING_SECRET not set")

    # canonicalize without 't'
    canon_keys = sorted(k for k in params.keys() if k != "t")
    canonical = "&".join(f"{k}={quote_plus(params[k])}" for k in canon_keys)

    mac = hmac.new(SIGNING_SECRET.encode("utf-8"),
                   canonical.encode("utf-8"),
                   hashlib.sha256).digest()
    sig = base64.urlsafe_b64encode(mac).decode("ascii").rstrip("=")

    # full query incl. signature
    full = dict(params)
    full["t"] = sig
    qs = "&".join(f"{k}={quote_plus(v)}" for k, v in full.items())
    return f"{base_url}?{qs}"

def sign_params_simple(params: dict) -> str:
    """
    Sign with URL-safe base64 HMAC-SHA256 (same as submit/customize functions).
    Only used here for the /customize link (we sign u+ts).
    """
    if not SIGNING_SECRET:
        raise RuntimeError("SIGNING_SECRET not set")
    keys = sorted(params.keys())
    canonical = "&".join([f"{k}={quote_plus(params[k])}" for k in keys])
    mac = hmac.new(SIGNING_SECRET.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode("ascii").rstrip("=")

def quote_plus(s: str) -> str:
    from urllib.parse import quote_plus as qp
    return qp(str(s), safe="")

def build_signed_url(base: str, params: dict) -> str:
    """Builds a URL with t=signature appended."""
    p = dict(params)
    p["t"] = sign_params_simple(params)
    qs = "&".join([f"{k}={quote_plus(v)}" for k, v in p.items()])
    return f"{base}?{qs}"

def render_email_html(recipient: dict, split: dict, date_str: str) -> str:
    tmpl = Template(load_email_template())

    user = recipient.get("username") or recipient["id"]

    # Per-exercise links
    items = []
    now_ts = str(int(time.time()))
    for ex in split.get("exercises", []):
        params = {"u": user, "d": date_str, "ex": ex["id"], "ts": now_ts}
        items.append({
            "name": ex.get("name"),
            "sets": ex.get("sets"),
            "reps": ex.get("reps"),
            "link": build_link(SUBMIT_BASE_URL, params),   # your signed helper
        })

    # Complete ALL link
    complete_all_link = build_link(SUBMIT_BASE_URL, {"u": user, "d": date_str, "ex": "ALL", "ts": now_ts})

    # Activity link (no signature required)
    my_activity_link = f"{NETLIFY_BASE}/activity?u={quote_plus(user)}" if NETLIFY_BASE else ""

    # Skip link (signed)
    skip_today_link = build_link(SUBMIT_BASE_URL, {"u": user, "d": date_str, "ex": "SKIP", "ts": now_ts})

    # Customized Session link (signed with u+ts)
    customized_session_link = (
        build_signed_url(f"{NETLIFY_BASE}/customize", {"u": user, "ts": now_ts})
        if NETLIFY_BASE else ""
    )

    return tmpl.render(
        name=recipient.get("name", user),
        title=split.get("title", "Today's Workout"),
        date=date_str,
        items=items,
        complete_all_link=complete_all_link,
        my_activity_link=my_activity_link,
        skip_today_link=skip_today_link,
        customized_session_link=customized_session_link,
    )

def pick_plan_and_split_for_today(username: str, today: str) -> dict:
    """
    Returns the split dict for today, preferring user plan.
    - If workout_splits/<username>/plan.json exists, use that plan's days.
    - Else use DEFAULT_ROTATION and load JSON files from SPLITS_DIR.
    """
    user_plan = load_user_plan(username)
    if user_plan and isinstance(user_plan.get("days"), list) and user_plan["days"]:
        idx = pick_today_index(username, today, total=len(user_plan["days"]))
        day = user_plan["days"][idx]
        # Ensure expected schema for renderer
        return {"title": day.get("title", f"Day {idx+1}"), "exercises": day.get("exercises", [])}

    # fallback to defaults
    idx = pick_today_index(username, today, total=len(DEFAULT_ROTATION))
    title = DEFAULT_ROTATION[idx]
    return load_split_by_title(title)

def build_message_html(recipient: dict, split: dict, date_str: str) -> MIMEMultipart:
    html = render_email_html(recipient, split, date_str)
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"{split.get('title', 'Today')} — {date_str}"
    msg["From"] = FROM_EMAIL
    msg["To"] = recipient["email"]
    msg.attach(MIMEText(html, "html", "utf-8"))
    return msg

def smtp_send(msg: MIMEMultipart, to_addr: str):
    last_err = None
    for _ in range(2):
        try:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=25) as server:
                server.ehlo()
                if SMTP_PORT == 587:
                    server.starttls()
                if SMTP_USERNAME and SMTP_PASSWORD:
                    server.login(SMTP_USERNAME, SMTP_PASSWORD)
                server.sendmail(msg["From"], [to_addr], msg.as_string())
            return
        except Exception as e:
            last_err = e
            time.sleep(1.5)
    raise RuntimeError(f"Failed to send to {to_addr}: {last_err}")

# ========= main =========

def main():
    if not SUBMIT_BASE_URL:
        raise SystemExit("SUBMIT_BASE_URL is not set")
    if not NETLIFY_BASE:
        print("[warn] NETLIFY_BASE is empty; 'My Activity' and 'Customized Session' links will be blank.")

    recipients = load_json(RECIPIENTS_FN)
    date_str = today_local_iso()

    for r in recipients:
        user = r.get("username") or r["id"]
        split = pick_plan_and_split_for_today(user, date_str)

        msg = build_message_html(r, split, date_str)
        print(f"→ Sending to {r['email']} ...")
        smtp_send(msg, r["email"])

        # Optional: write preview copy (full MIME email)
        try:
            OUT_DIR.mkdir(exist_ok=True, parents=True)
            (OUT_DIR / f"{user}-{date_str}.eml").write_text(msg.as_string(), encoding="utf-8")
        except Exception:
            pass

if __name__ == "__main__":
    main()