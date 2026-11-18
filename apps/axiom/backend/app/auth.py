"""Validate the single configured dashboard account against Supabase Auth."""

import json
import os
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_validator():
    if os.getenv("AXIOM_REQUIRE_AUTH", "").lower() != "true":
        return None
    base = os.environ["AXIOM_SUPABASE_URL"].rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Configure the exact Supabase HTTPS origin")
    owner = str(uuid.UUID(os.environ["AXIOM_OWNER_ID"]))
    key = os.environ["AXIOM_SUPABASE_ANON_KEY"]
    opener = build_opener(_NoRedirect())

    def allowed(authorization: str) -> bool:
        if not authorization.startswith("Bearer ") or len(authorization) > 4096:
            return False
        request = Request(base + "/auth/v1/user", headers={"apikey": key, "Authorization": authorization})
        try:
            with opener.open(request, timeout=8) as response:
                identity = json.load(response)
            return identity.get("id") == owner
        except HTTPError as error:
            if error.code in {400, 401, 403}:
                return False
            raise
        except (URLError, OSError, ValueError) as error:
            raise ConnectionError("Supabase Auth is unavailable") from error

    return allowed
