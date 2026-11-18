"""Poll the dashboard queue without exposing the lab machine or its disk."""

from __future__ import annotations

import json
import logging
import os
import signal
import threading
import time
from collections.abc import Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .transfer_archive import (
    ArchiveFull,
    manifest,
    mark_acknowledged,
    persist_snapshot,
    unacknowledged,
)

LOG = logging.getLogger("axiom.worker")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TransferWorker:
    def __init__(self, base_url: str, secret: str):
        base = urlsplit(base_url)
        if (base.scheme != "https" or not base.hostname or base.username or base.password
                or base.query or base.fragment or base.path not in {"", "/"} or len(secret) < 32):
            raise ValueError("Configure the Supabase HTTPS origin and a worker secret")
        self.origin = (base.scheme, base.netloc)
        self.endpoint = base_url.rstrip("/") + "/functions/v1/axiom-transfers"
        self.authorization = f"Bearer {secret}"
        self.opener = build_opener(NoRedirect())

    def request(self, action: str, **fields):
        return self.opener.open(Request(
            self.endpoint,
            data=json.dumps({"action": action, **fields}).encode(),
            headers={"Content-Type": "application/json", "Authorization": self.authorization},
            method="POST",
        ), timeout=45)

    def call(self, action: str, **fields):
        with self.request(action, **fields) as response:
            return json.load(response)

    def chunks(self, job: dict) -> Iterator[bytes]:
        key = {"id": job["id"], "lease": job["lease"]}
        if job["kind"] == "minute":
            response = self.request("payload", **key)
        else:
            url = job.get("url") or ""
            parsed = urlsplit(url)
            if ((parsed.scheme, parsed.netloc) != self.origin
                    or not parsed.path.startswith("/storage/v1/object/sign/temporary-downloads/")):
                raise ValueError("Snapshot URL unavailable")
            response = self.opener.open(url, timeout=45)
        with response:
            heartbeat = time.monotonic() + 120
            while block := response.read(256 * 1024):
                if time.monotonic() >= heartbeat:
                    self.call("renew", **key)
                    heartbeat = time.monotonic() + 120
                yield block

    def tick(self) -> None:
        for item in unacknowledged():
            job_id = item["job_id"]
            response = self.call("recover", id=job_id, checksum=item["sha256"])
            if response["status"] not in {"ready", "missing"}:
                LOG.error("Transfer %s requires recovery review: %s", job_id, response["status"])
                continue
            mark_acknowledged(job_id)
        job = self.call("claim")["job"]
        if not job:
            return
        key = {"id": job["id"], "lease": job["lease"]}
        result = {}
        try:
            saved = manifest(job["id"]) or persist_snapshot(job, self.chunks(job))
            result = {"checksum": saved["sha256"]}
        except ArchiveFull:
            result = {"code": "archive_full", "retry": False}
        except ValueError:
            result = {"code": "source_unavailable", "retry": True}
        except (OSError, URLError):
            result = {"code": "source_unavailable", "retry": True}
        # If acknowledgement fails, the next lease can acknowledge the same durable file.
        self.call("finish", **key, **result)
        if "checksum" in result:
            mark_acknowledged(job["id"])
        LOG.info("Transfer %s: %s", job["id"], result.get("code", "ready"))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    worker = TransferWorker(os.environ["AXIOM_SUPABASE_URL"], os.environ["AXIOM_WORKER_SECRET"])
    closing = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: closing.set())
    signal.signal(signal.SIGINT, lambda *_: closing.set())
    LOG.info("Axiom worker started")
    while not closing.is_set():
        try:
            worker.tick()
        except HTTPError as error:
            LOG.warning("Transfer service returned HTTP %d", error.code)
        except (OSError, ValueError) as error:
            LOG.warning("Transfer worker will retry (%s)", type(error).__name__)
        closing.wait(60)


if __name__ == "__main__":
    main()
