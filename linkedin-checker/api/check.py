"""Vercel serverless endpoint: POST /api/check

Actions (JSON body):
  {"action": "ping"}                                  -> verify password
  {"action": "test",  "cookies": [...]}               -> validate cookie against /feed/
  {"action": "check", "url": "...", "cookies": [...]} -> classify ONE url

One URL per request keeps every call well inside Vercel's function time
limit. Delay / retry / batching live in the browser.
"""

import hmac
import json
import os
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

import requests

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

TIMEOUT = 9  # seconds; must stay below the function's maxDuration
MAX_BODY_BYTES = 200_000
MAX_COOKIES = 100

# ---- detection rules (same as the desktop script) -------------------------

# LinkedIn ships a big JS/JSON bundle inside <script> tags that contains every
# possible UI string, including the 404 copy, even on live profiles. Strip
# those blocks before matching text, otherwise live profiles look DEAD.
_SCRIPT_STYLE_RE = re.compile(r"<(script|style|noscript)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)

DEAD_URL_MARKERS = (
    "this page doesn't exist",
    "please check your url or return to linkedin home",
)

PROFILE_SIGNALS = (
    '"@type":"Person"',
    "pv-top-card",
    "top-card-layout",
    "profile-topcard",
    'property="og:type" content="profile"',
)

AUTHWALL_MARKERS = ("/authwall", "/uas/login", "/checkpoint/")


def _result(url, final_url="", status="ERROR", note="", http_status=0):
    return {
        "original_url": url,
        "final_url": final_url,
        "status": status,
        "note": note,
        "http_status": http_status,
    }


def classify(url, resp):
    final_url = resp.url
    http_status = resp.status_code

    if any(m in final_url for m in AUTHWALL_MARKERS):
        return _result(url, final_url, "ERROR",
                       "Redirected to login/authwall - cookie invalid or incomplete", http_status)

    if http_status == 999:
        return _result(url, final_url, "ERROR",
                       "LinkedIn blocked the request (999) - check cookie / rate limit", http_status)

    if http_status >= 400:
        return _result(url, final_url, "ERROR", f"HTTP {http_status}", http_status)

    if "/404/" in final_url:
        return _result(url, final_url, "DEAD", "Redirected to 404 page", http_status)

    raw_html = resp.text
    if any(sig in raw_html for sig in PROFILE_SIGNALS):
        note = "URL unchanged" if final_url.rstrip("/") == url.rstrip("/") else "URL changed but not 404"
        return _result(url, final_url, "LIVE", note, http_status)

    visible_text = _SCRIPT_STYLE_RE.sub(" ", raw_html).lower()
    if any(m in visible_text for m in DEAD_URL_MARKERS):
        return _result(url, final_url, "DEAD", "Page says it doesn't exist", http_status)

    note = ("URL unchanged (profile markup unclear)"
            if final_url.rstrip("/") == url.rstrip("/") else "URL changed but not 404")
    return _result(url, final_url, "LIVE", note, http_status)


def check_url(session, url):
    try:
        resp = session.get(url, allow_redirects=True, timeout=TIMEOUT)
    except requests.exceptions.RequestException as e:
        return _result(url, "", "ERROR", f"Network error: {e}")
    return classify(url, resp)


def test_session(session):
    try:
        resp = session.get("https://www.linkedin.com/feed/", allow_redirects=True, timeout=TIMEOUT)
    except requests.exceptions.RequestException as e:
        return False, f"Network error: {e}"

    if any(m in resp.url for m in AUTHWALL_MARKERS):
        return False, "Cookie did not log in - redirected to the login/authwall page."
    if resp.status_code == 999:
        return False, "LinkedIn blocked this request (999). Rate limited or cookie invalid."
    if resp.status_code >= 400:
        return False, f"Unexpected HTTP {resp.status_code}."
    return True, "Cookie looks valid - the feed page loaded."


# ---- helpers ---------------------------------------------------------------

def is_linkedin_url(url):
    """Only linkedin.com URLs are allowed, so this can't be used as an open proxy."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme in ("http", "https") and (host == "linkedin.com" or host.endswith(".linkedin.com"))


def build_session(cookies):
    session = requests.Session()
    session.headers.update(DEFAULT_HEADERS)
    if isinstance(cookies, list):
        for c in cookies[:MAX_COOKIES]:
            if not isinstance(c, dict):
                continue
            name, value = c.get("name"), c.get("value")
            if not isinstance(name, str) or not isinstance(value, str) or not name:
                continue
            domain = c.get("domain") if isinstance(c.get("domain"), str) and c.get("domain") else ".linkedin.com"
            session.cookies.set(name, value, domain=domain)
    return session


def _json_response(start_response, code, reason, payload):
    body = json.dumps(payload).encode("utf-8")
    start_response(
        f"{code} {reason}",
        [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
        ],
    )
    return [body]


def app(environ, start_response):
    """WSGI entrypoint. Vercel's Python runtime (and `vercel dev` locally)
    both detect and run a callable named `app` with this exact signature."""
    if environ.get("REQUEST_METHOD") != "POST":
        return _json_response(start_response, 405, "Method Not Allowed", {"error": "Use POST."})

    expected = os.environ.get("APP_PASSWORD", "")
    if not expected:
        return _json_response(start_response, 500, "Internal Server Error",
                              {"error": "APP_PASSWORD is not set on the server."})

    given = environ.get("HTTP_X_APP_PASSWORD", "")
    if not hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8")):
        return _json_response(start_response, 401, "Unauthorized", {"error": "Wrong password."})

    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    if length <= 0 or length > MAX_BODY_BYTES:
        return _json_response(start_response, 400, "Bad Request",
                              {"error": "Request body is missing or too large."})

    try:
        body = json.loads(environ["wsgi.input"].read(length))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_response(start_response, 400, "Bad Request", {"error": "Body must be valid JSON."})
    if not isinstance(body, dict):
        return _json_response(start_response, 400, "Bad Request", {"error": "Body must be a JSON object."})

    action = body.get("action")

    if action == "ping":
        return _json_response(start_response, 200, "OK", {"ok": True})

    if action == "test":
        ok, message = test_session(build_session(body.get("cookies")))
        return _json_response(start_response, 200, "OK", {"ok": ok, "message": message})

    if action == "check":
        url = body.get("url")
        if not isinstance(url, str) or not is_linkedin_url(url.strip()):
            return _json_response(start_response, 400, "Bad Request",
                                  {"error": "Only linkedin.com URLs can be checked."})
        result = check_url(build_session(body.get("cookies")), url.strip())
        result["checked_at"] = datetime.now(timezone.utc).isoformat()
        return _json_response(start_response, 200, "OK", result)

    return _json_response(start_response, 400, "Bad Request", {"error": "Unknown action."})
