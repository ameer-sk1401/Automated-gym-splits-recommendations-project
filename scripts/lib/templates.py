from __future__ import annotations
from pathlib import Path

BASE = Path(__file__).resolve().parents[2]

def load_email_template() -> str:
    return (BASE / "email_templates" / "daily.html").read_text(encoding="utf-8")