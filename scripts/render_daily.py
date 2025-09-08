from __future__ import annotations
from pathlib import Path
import os, json
from jinja2 import Template
from lib.utils import BASE, load_json, today_local_iso, weekday_name
from lib.templates import load_email_template

CONFIG = BASE / "config"
SPLITS = BASE / "splits"
OUTDIR = BASE / ".out"

# For Phase 1 we don't sign links yet; use a placeholder base URL.
SUBMIT_BASE_URL = os.environ.get("SUBMIT_BASE_URL", "https://example.com/submit")

def build_link(base: str, params: dict) -> str:
    # Phase 1: naive querystring (not secure). We’ll replace with HMAC in Phase 3.
    from urllib.parse import urlencode
    return f"{base}?{urlencode(params)}"

def main():
    recipients = load_json(CONFIG / "recipients.json")
    schedule = load_json(CONFIG / "schedule.json")

    day = weekday_name()
    date_str = today_local_iso()

    split_file = schedule.get(day) or schedule.get(day.lower())
    if not split_file:
        print(f"No split configured for {day}; exiting.")
        return

    split = load_json(SPLITS / split_file)
    template = Template(load_email_template())

    (OUTDIR / date_str).mkdir(parents=True, exist_ok=True)

    for r in recipients:
        items = []
        for ex in split["exercises"]:
            params = {"u": r["id"], "d": date_str, "ex": ex["id"]}
            items.append({
                "name": ex["name"],
                "sets": ex.get("sets"),
                "reps": ex.get("reps"),
                "link": build_link(SUBMIT_BASE_URL, params),
            })
        complete_all_link = build_link(SUBMIT_BASE_URL, {"u": r["id"], "d": date_str, "ex": "ALL"})

        html = template.render(
            name=r.get("name", r["id"]),
            title=split.get("title", "Today's Workout"),
            date=date_str,
            items=items,
            complete_all_link=complete_all_link
        )

        out = OUTDIR / date_str / f"{r['id']}.html"
        out.write_text(html, encoding="utf-8")
        print(f"Wrote {out.relative_to(BASE)}")

if __name__ == "__main__":
    main()