from __future__ import annotations
from pathlib import Path
import json
import datetime
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parents[2]

def load_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def today_local_iso(tz="America/New_York") -> str:
    return datetime.datetime.now(ZoneInfo(tz)).date().isoformat()

def weekday_name(tz="America/New_York") -> str:
    return datetime.datetime.now(ZoneInfo(tz)).strftime("%A")  # Monday..Sunday