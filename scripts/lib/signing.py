from __future__ import annotations
import base64, hashlib, hmac
from urllib.parse import quote_plus

def sign_params(params: dict, secret: str) -> str:
    """
    Deterministically sign params with HMAC-SHA256.
    - params: dict WITHOUT 't'
    - returns URL-safe base64 signature (no padding)
    """
    items = sorted((k, str(v)) for k, v in params.items() if k != "t")
    canonical = "&".join(f"{k}={quote_plus(v)}" for k, v in items)
    mac = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).digest()
    token = base64.urlsafe_b64encode(mac).decode().rstrip("=")
    return token