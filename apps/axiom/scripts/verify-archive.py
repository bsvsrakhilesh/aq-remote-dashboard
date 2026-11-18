"""Verify a restored Axiom state directory before relying on it for retention."""

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def verify(root: Path, job_id: str | None) -> None:
    if not root.is_dir():
        raise ValueError("The restored state directory was not found")
    inbox = root / "dashboard"
    snapshots = list(inbox.glob("*/manifest.json"))
    if not snapshots and not any((root / name).is_file() for name in ("axiom.sqlite3", "datasets.json")):
        raise ValueError("The restore does not contain Axiom state")
    if job_id:
        snapshots = [path for path in snapshots if path.parent.name == job_id]
        if not snapshots:
            raise ValueError("The requested job was not found in this restore")
    for manifest_path in snapshots:
        metadata = json.loads(manifest_path.read_text(encoding="utf-8"))
        source = manifest_path.with_name("source.csv")
        with source.open("rb") as handle:
            checksum = hashlib.file_digest(handle, "sha256").hexdigest()
        if metadata["sha256"] != checksum or metadata["bytes"] != source.stat().st_size:
            raise ValueError(f"Archive checksum or size mismatch for {manifest_path.parent.name}")
        if job_id:
            print(f"Verified snapshot {job_id} SHA-256 {checksum}")
    if (database := root / "axiom.sqlite3").exists():
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise ValueError("The restored collocation database failed its integrity check")
    if (registry := root / "datasets.json").exists():
        for dataset in json.loads(registry.read_text(encoding="utf-8"))["datasets"]:
            if not (root / "imported" / Path(dataset["storage_path"]).name).is_file():
                raise ValueError(f"Missing working copy for dataset {dataset['id']}")
    print(f"Verified {len(snapshots)} dashboard snapshot(s) and available analysis state")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("restored_state", type=Path)
    parser.add_argument("--job-id")
    arguments = parser.parse_args()
    verify(arguments.restored_state.resolve(), arguments.job_id)
