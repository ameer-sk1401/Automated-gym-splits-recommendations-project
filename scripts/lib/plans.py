# scripts/lib/plans.py

import json
import os
from pathlib import Path
from datetime import date, timedelta

# --- repo roots / paths ---
REPO_ROOT      = Path(__file__).resolve().parents[2]  # scripts/lib/*.py -> repo root
SPLITS_DIR     = REPO_ROOT / "splits"                 # default rotation JSONs
WORKOUT_SPLITS = REPO_ROOT / "workout_splits"         # per-user plans: workout_splits/<username>/plan.json
SCHEDULES_DIR  = REPO_ROOT / "schedules"              # rotation state per user

# --- default rotation titles (must map to files like splits/push-day.json, etc.) ---
ROTATION = ["Push day", "Pull day", "Leg day"]


# =============== public API ===============

def pick_plan_and_day(username: str, today: str):
    """
    Returns (plan_json_or_None, day_split_dict) for the given user and ISO date (YYYY-MM-DD).
    - If user has workout_splits/<username>/plan.json -> use that plan (days array)
    - Else -> fall back to default rotation loaded from splits/*.json
    Rotation index is chosen by pick_today_index() which freezes on SKIP.
    """
    user_plan = load_user_plan(username)
    if user_plan:
        days = user_plan.get("days", [])
        if not days:
            return user_plan, {"title": "No days configured", "exercises": []}
        idx = pick_today_index(username, today, total=len(days))
        day = normalize_user_day(days[idx], idx)
        return user_plan, day

    # fallback to defaults
    idx = pick_today_index(username, today, total=len(ROTATION))
    title = ROTATION[idx]
    return None, load_split_by_title(title)


# =============== rotation / schedule ===============

def pick_today_index(username: str, today: str, total: int) -> int:
    """
    Rule:
      - If last_action == "SKIPPED" and last_action_date is yesterday or today -> DO NOT advance (freeze)
      - Else (COMPLETED or NONE) -> ADVANCE by 1 (wrap)
    Sender marks today's baseline to "NONE"; your submit endpoint later flips it to SKIPPED/COMPLETED.
    """
    sched = load_sched(username)
    idx = int(sched.get("current_index", 0)) % max(1, total)
    last_action = sched.get("last_action", "NONE")
    last_date   = sched.get("last_action_date")

    yd = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    freeze = (last_action == "SKIPPED") and (last_date is not None) and (last_date >= yd)

    if not freeze:
        idx = (idx + 1) % max(1, total)

    # baseline for today
    sched.update({"current_index": idx, "last_action": "NONE", "last_action_date": today})
    save_sched(username, sched)
    return idx


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


# =============== plans / splits loading ===============

def load_user_plan(username: str):
    p = WORKOUT_SPLITS / username / "plan.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return None


def load_split_by_title(title: str) -> dict:
    """
    Loads a default split JSON from splits/<slug(title)>.json.
    Expected schema:
      { "title": "Push day", "exercises": [ {"id":"bench_press","name":"Bench Press","sets":3,"reps":"8-10"}, ... ] }
    """
    fn = SPLITS_DIR / f"{slug(title)}.json"
    if not fn.exists():
        raise FileNotFoundError(f"Missing split file: {fn}")
    data = json.loads(fn.read_text(encoding="utf-8"))
    # minimal normalization
    data.setdefault("title", title)
    data["exercises"] = [normalize_ex(e, i) for i, e in enumerate(data.get("exercises", []))]
    return data


# =============== normalization helpers ===============

def normalize_user_day(day: dict, idx: int) -> dict:
    """
    Converts a user plan 'day' object into the email renderer schema:
      { "title": "...", "exercises": [ {"id","name","sets","reps"}, ... ] }
    Accepts flexible input keys: name/title for day title; body_part ignored here.
    Exercises entries are normalized; IDs are generated when missing.
    """
    title = day.get("title") or day.get("name") or f"Day {idx+1}"
    raw_ex = day.get("exercises", [])
    ex_list = [normalize_ex(e, i) for i, e in enumerate(raw_ex)]
    return {"title": title, "exercises": ex_list}


def normalize_ex(e: dict, i: int) -> dict:
    name = (e.get("name") or e.get("exercise") or f"Exercise {i+1}").strip()
    ex_id = e.get("id") or slug(f"{name}-{i+1}")
    sets  = e.get("sets", None)
    reps  = e.get("reps", None)
    return {"id": ex_id, "name": name, "sets": sets, "reps": reps}


def slug(s: str) -> str:
    return "".join([c.lower() if c.isalnum() else "-" for c in str(s)]).strip("-").replace("--", "-")


# =============== (optional) convenience exports ===============

__all__ = [
    "ROTATION",
    "pick_plan_and_day",
    "pick_today_index",
    "load_split_by_title",
    "load_user_plan",
]