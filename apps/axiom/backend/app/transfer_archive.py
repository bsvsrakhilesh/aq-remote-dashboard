"""Durable inbox for dashboard snapshots. Manifests are written after their CSV."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from .config import APP_DATA_DIR

INBOX = APP_DATA_DIR / "dashboard"
MAX_BYTES = 40 * 1024 * 1024


class ArchiveFull(OSError):
    pass


def inbox_directory(job_id: str) -> Path:
    return INBOX / str(uuid.UUID(job_id))


def manifest(job_id: str) -> dict | None:
    folder = inbox_directory(job_id)
    path = folder / "manifest.json"
    if not path.is_file() or not (folder / "source.csv").is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def source(upload_id: str) -> tuple[Path, dict]:
    if not upload_id.startswith("axiom_"):
        raise ValueError("Invalid dashboard source")
    job_id = str(uuid.UUID(upload_id.removeprefix("axiom_")))
    metadata = manifest(job_id)
    if not metadata:
        raise ValueError("Dashboard snapshot is not available on this machine")
    return inbox_directory(job_id) / "source.csv", metadata


def mark_acknowledged(job_id: str) -> None:
    folder = inbox_directory(job_id)
    (folder / "acknowledged").touch()
    sync_directory(folder)


def unacknowledged() -> Iterable[dict]:
    for folder in INBOX.iterdir() if INBOX.exists() else []:
        if folder.is_dir() and not (folder / "acknowledged").exists():
            try:
                if item := manifest(folder.name):
                    yield item
            except ValueError:
                continue


def require_space(path: Path, extra_bytes: int) -> None:
    disk = shutil.disk_usage(path)
    if disk.free - extra_bytes < disk.total * 0.20:
        raise ArchiveFull("Archive disk has less than 20% space available")


def sync_directory(folder: Path) -> None:
    if os.name != "nt":
        fd = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def persist_snapshot(job: dict, chunks: Iterable[bytes]) -> dict:
    job_id = str(uuid.UUID(job["id"]))
    folder = inbox_directory(job_id)
    if existing := manifest(job_id):
        return existing
    size = job["bytes"]
    if type(size) is not int or not 0 < size <= MAX_BYTES or job["kind"] not in {"raw", "minute"}:
        raise ValueError("Invalid dashboard snapshot metadata")
    folder.mkdir(parents=True, exist_ok=True)
    require_space(folder, size)
    tmp_csv = folder / ".source.tmp"
    tmp_manifest = folder / ".manifest.tmp"
    digest = hashlib.sha256()
    written = 0
    try:
        with tmp_csv.open("wb") as handle:
            for chunk in chunks:
                written += len(chunk)
                if written > size:
                    raise ValueError("Snapshot exceeds its declared size")
                digest.update(chunk)
                handle.write(chunk)
            if written != size:
                raise ValueError("Snapshot does not match its declared size")
            handle.flush()
            os.fsync(handle.fileno())
        metadata = {
            "job_id": job_id,
            "kind": job["kind"],
            "device": job["device"],
            "filename": Path(job["filename"]).name,
            "bytes": written,
            "sha256": digest.hexdigest(),
            "captured_at": job.get("captured_at") or datetime.now(UTC).isoformat(),
        }
        with tmp_manifest.open("w", encoding="utf-8") as handle:
            json.dump(metadata, handle)
            handle.flush()
            os.fsync(handle.fileno())
        tmp_csv.replace(folder / "source.csv")
        tmp_manifest.replace(folder / "manifest.json")
        sync_directory(folder)
        sync_directory(INBOX)
        return metadata
    finally:
        tmp_csv.unlink(missing_ok=True)
        tmp_manifest.unlink(missing_ok=True)
