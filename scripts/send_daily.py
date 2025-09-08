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
from urllib.parse import quote_plus as _quote_plus

# ----- project libs you already have -----
from scripts.lib.utils import BASE, load_json, today_local_iso
from scripts.lib.templates import load_email_template  # NOTE: no-arg function

# ================== ENV ==================
SUBMIT_BASE_URL = os.environ.get("SUBMIT_BASE_URL", "").strip()   # e.g. https://gym-data-submission.netlify.app/submit
NETLIFY_BASE    = os.environ.get("NETLIFY_BASE", "").strip()      # e.g. https://gym-data-submission.netlify.app
SIGNING_SECRET  = os.environ.get("SIGNING_SECRET", "").strip()

SMTP_HOST     = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT     = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USERNAME = os.environ.get("SMTP_USERNAME", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
FROM_EMAIL    = os.environ.get("FROM_EMAIL", SMTP_USERNAME or "no-reply@example.com")

# ================= PATHS =================
CONFIG          = BASE / "config"
RECIPIENTS_FN   = CONFIG / "recipients.json"
SPLITS_DIR      = BASE / "splits"                 # default rotation split JSONs
WORKOUT_SPLITS  = BASE / "workout_splits"         # (kept for backward-compat; not used here)
SCHEDULES_DIR   = BASE / "schedules"              # per-user rotation state: schedules/<username>.json
HISTORY_ROOT    = BASE / "User History"           # activity store: User History/<u>/<YYYY-MM>/<YYYY-MM-DD>.json
OUT_DIR         = BASE / ".out"                   # optional local preview output

# ====== default rotation and filename map (matches your repo) ======
DEFAULT_ROTATION_TITLES = [
    "Push Day",
    "Pull Day",
    "Leg + Abs Day",
    "Focus Day",
    "Full Body Power Day",
]

# Map human titles to your actual file names in /splits
TITLE_TO_FILE = {
    "Push Day": "Push_Day.json",
    "Pull Day": "Pull_Day.json",
    "Leg + Abs Day": "Leg_plus_Abs_Day.json",
    "Focus Day": "Focus_Day.json",
    "Full Body Power Day": "Full_Body_Power_Day.json",
}

# =============== helpers ===============

def quote_plus(s: str) -> str:
    return _quote_plus(str(s), safe="")

def slug(s: str) -> str:
    return "".join([c.lower() if c.isalnum() else "-" for c in s]).strip("-").replace("--", "-")

def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")

def sign_params(params: dict) -> str:
    """
    HMAC-SHA256 over canonical k=v sorted &-joined, url-encoded values.
    Matches the verifier used by your Netlify functions.
    """
    if not SIGNING_SECRET:
        raise RuntimeError("SIGNING_SECRET is not set")
    keys = sorted(params.keys())
    canonical = "&".join([f"{k}={quote_plus(params[k])}" for k in keys])
    mac = hmac.new(SIGNING_SECRET.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).digest()
    return b64url(mac)

def build_signed_url(base: str, params: dict) -> str:
    """Append t=signature to given params and return base?query."""
    p = dict(params)
    p["t"] = sign_params(params)
    qs = "&".join([f"{k}={quote_plus(v)}" for k, v in p.items()])
    joiner = "&" if ("?" in base) else "?"
    return f"{base}{joiner}{qs}"

def load_json_file(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))

def load_split_file(p: Path) -> dict:
    """Ensures expected schema exists."""
    data = load_json_file(p)
    if "title" not in data:
        data["title"] = p.stem.replace("-", " ").replace("_", " ")
    data["exercises"] = data.get("exercises", [])
    return data

def load_default_split_by_title(title: str) -> dict:
    """
    Loads a split from /splits using:
      1) explicit TITLE_TO_FILE mapping (matches your underscored files)
      2) fallback to slug(title).json (for any future files you might add)
    """
    if title in TITLE_TO_FILE:
        fn = SPLITS_DIR / TITLE_TO_FILE[title]
        if fn.exists():
            return load_split_file(fn)
    # fallback for any new titles you may add later
    fn = SPLITS_DIR / f"{slug(title)}.json"
    if fn.exists():
        return load_split_file(fn)
    raise FileNotFoundError(
        f"Missing split file for title '{title}'. Tried '{TITLE_TO_FILE.get(title)}' and '{fn.name}'."
    )

def load_sched(username: str) -> dict:
    SCHEDULES_DIR.mkdir(parents=True, exist_ok=True)
    p = SCHEDULES_DIR / f"{username}.json"
    if p.exists():
        return load_json_file(p)
    return {"current_index": 0, "last_action_date": None, "last_action": "NONE"}

def save_sched(username: str, sched: dict):
    SCHEDULES_DIR.mkdir(parents=True, exist_ok=True)
    p = SCHEDULES_DIR / f"{username}.json"
    p.write_text(json.dumps(sched, indent=2), encoding="utf-8")

def pick_today_index(username: str, today_iso: str, total: int) -> int:
    """
    Advance rotation **only when the calendar day changes**.
    Freeze (don't advance) if yesterday was SKIPPED.
    """
    sched = load_sched(username)
    idx = int(sched.get("current_index", 0)) % max(1, total)
    last_action = sched.get("last_action", "NONE")
    last_date   = sched.get("last_action_date")

    if last_date != today_iso:
        yd = (date.fromisoformat(today_iso) - timedelta(days=1)).isoformat()
        freeze = (last_action == "SKIPPED") and (last_date == yd)
        if not freeze:
            idx = (idx + 1) % max(1, total)

    # record “seen today”; submit endpoint will update last_action later
    sched.update({"current_index": idx, "last_action": sched.get("last_action", "NONE"), "last_action_date": today_iso})
    save_sched(username, sched)
    return idx

def load_custom_plan_for_today(username: str, today_iso: str):
    """
    Look for a one-day custom plan stored inside the user's activity JSON:
      User History/<username>/<YYYY-MM>/<YYYY-MM-DD>.json
    Return a split-like dict { title, exercises } or None.
    """
    yyyy, mm, _dd = today_iso.split("-")
    p = HISTORY_ROOT / username / f"{yyyy}-{mm}" / f"{today_iso}.json"
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    plan = data.get("custom_plan")
    if not plan:
        return None
    return {
        "title": plan.get("title", "Custom Session"),
        "exercises": plan.get("exercises", []),
    }

# --------- strict weekday schedule override ---------

def pick_scheduled_split_or_rest(today_iso: str):
    """
    Return (mode, payload)
      mode='split' -> payload is a split dict
      mode='rest'  -> payload is {title, message}
      mode=None    -> schedule.json missing -> let caller fall back
    Treat null/""/'rest' (any case) as Rest day.
    """
    sched_fn = CONFIG / "schedule.json"
    if not sched_fn.exists():
        return None, None

    sched = json.loads(sched_fn.read_text(encoding="utf-8"))
    weekday = date.fromisoformat(today_iso).strftime("%A")  # 'Monday'
    entry = sched.get(weekday)

    if entry is None or (isinstance(entry, str) and entry.strip() == "") or (
        isinstance(entry, str) and entry.strip().lower() == "rest"
    ):
        return "rest", {
            "title": "Rest Day",
            "message": "Today is a rest day. If you still want to train, use Customized Session to log a light or mobility workout."
        }

    if not isinstance(entry, str):
        raise ValueError(f"schedule.json entry for {weekday} must be a filename or null; got {entry!r}")

    split_path = SPLITS_DIR / entry
    if not split_path.exists():
        raise FileNotFoundError(f"Configured split '{entry}' not found in /splits for {weekday}.")
    return "split", load_split_file(split_path)

# --------- unified picker ---------

def pick_split_for_today(username: str, today_iso: str) -> dict:
    """
    Preference:
      0) If config/schedule.json exists => obey weekday:
         - filename -> that exact split
         - null/""/"rest" -> Rest Day email (no items)
      1) Else, if today's activity JSON has custom_plan -> use it only today
      2) Else rotate defaults from /splits
    """
    mode, payload = pick_scheduled_split_or_rest(today_iso)
    if mode == "rest":
        return {"__rest__": True, **payload}
    if mode == "split":
        return payload

    custom = load_custom_plan_for_today(username, today_iso)
    if custom and custom.get("exercises"):
        _ = pick_today_index(username, today_iso, total=len(DEFAULT_ROTATION_TITLES))
        return custom

    idx = pick_today_index(username, today_iso, total=len(DEFAULT_ROTATION_TITLES))
    return load_default_split_by_title(DEFAULT_ROTATION_TITLES[idx])

# ============ email building ============

def render_email_html(recipient: dict, split: dict, date_str: str) -> str:
    tmpl = Template(load_email_template())

    user = recipient.get("username") or recipient["id"]
    now_ts = str(int(time.time()))

    submit_base = f"{NETLIFY_BASE}/submit" if NETLIFY_BASE else SUBMIT_BASE_URL
    delete_func = f"{NETLIFY_BASE}/.netlify/functions/delete_activity" if NETLIFY_BASE else ""

    # ---- REST day email (no exercise buttons) ----
    if split.get("__rest__"):
        customized_session_link = (
            build_signed_url(f"{NETLIFY_BASE}/customize", {"u": user, "ts": now_ts})
            if NETLIFY_BASE else ""
        )
        return tmpl.render(
            name=recipient.get("name", user),
            title=split.get("title", "Rest Day"),
            date=date_str,
            items=[],                          # hide lists/buttons in template via condition
            complete_all_link="",
            my_activity_link=f"{NETLIFY_BASE}/activity?u={quote_plus(user)}" if NETLIFY_BASE else "",
            skip_today_link="",
            customized_session_link=customized_session_link,
            delete_activity_link="",
            delete_month_link="",
            delete_all_link="",
            rest_note=split.get("message", "Today is a rest day. If you want, you can log a custom session."),
        )

    # ---- Normal day ----
    items = []
    for ex in split.get("exercises", []):
        params = {"u": user, "d": date_str, "ex": ex.get("id", ""), "ts": now_ts}
        items.append({
            "name": ex.get("name", ex.get("id", "Exercise")),
            "sets": ex.get("sets"),
            "reps": ex.get("reps"),
            "link": build_signed_url(submit_base, params),
        })

    complete_all_link = build_signed_url(submit_base, {"u": user, "d": date_str, "ex": "ALL", "ts": now_ts})
    my_activity_link   = f"{NETLIFY_BASE}/activity?u={quote_plus(user)}" if NETLIFY_BASE else ""
    skip_today_link    = build_signed_url(submit_base, {"u": user, "d": date_str, "ex": "SKIP", "ts": now_ts})
    customized_session_link = (
        build_signed_url(f"{NETLIFY_BASE}/customize", {"u": user, "ts": now_ts})
        if NETLIFY_BASE else ""
    )
    delete_activity_link = (
        build_signed_url(delete_func, {"u": user, "scope": "day", "d": date_str, "ts": now_ts})
        if delete_func else ""
    )
    yyyy, mm, _dd = date_str.split("-")
    delete_month_link = (
        build_signed_url(delete_func, {"u": user, "scope": "month", "y": yyyy, "m": mm, "ts": now_ts})
        if delete_func else ""
    )
    delete_all_link = (
        build_signed_url(delete_func, {"u": user, "scope": "all", "ts": now_ts})
        if delete_func else ""
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
        delete_activity_link=delete_activity_link,
        delete_month_link=delete_month_link,
        delete_all_link=delete_all_link,
        rest_note=None,  # not a rest day
    )

def build_message_html(recipient: dict, split: dict, date_str: str) -> MIMEMultipart:
    html = render_email_html(recipient, split, date_str)
    msg = MIMEMultipart("alternative")
    subj_title = split.get("title", "Today")
    msg["Subject"] = f"{subj_title} — {date_str}"
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

# ================= main =================

def main():
    if not (SUBMIT_BASE_URL or NETLIFY_BASE):
        raise SystemExit("You must set NETLIFY_BASE or SUBMIT_BASE_URL for action links.")
    if not SIGNING_SECRET:
        raise SystemExit("SIGNING_SECRET is required to sign links.")

    recipients = load_json(RECIPIENTS_FN)
    date_str = today_local_iso()  # utils respects TZ (set TZ=America/New_York in workflow)

    for r in recipients:
        user = r.get("username") or r["id"]
        split = pick_split_for_today(user, date_str)

        msg = build_message_html(r, split, date_str)
        print(f"→ Sending to {r['email']} ...")
        smtp_send(msg, r["email"])

        # optional local preview for debugging
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / f"{user}-{date_str}.eml").write_text(msg.as_string(), encoding="utf-8")

if __name__ == "__main__":
    main()