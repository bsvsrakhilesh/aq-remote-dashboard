from hashlib import sha256
from urllib.error import URLError
from uuid import uuid4

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend.app import data_service, import_service, main, transfer_archive
from backend.app.collocation_service import collocation_service
from backend.app.models import CollocationMember
from backend.app.transfer_worker import TransferWorker


@pytest.fixture
def storage(monkeypatch, tmp_path):
    monkeypatch.setattr(transfer_archive, "INBOX", tmp_path / "dashboard")
    monkeypatch.setattr(main, "INBOX", tmp_path / "dashboard")
    monkeypatch.setattr(transfer_archive, "require_space", lambda *_: None)
    monkeypatch.setattr(import_service, "require_space", lambda *_: None)
    monkeypatch.setattr(import_service, "IMPORTED_DIR", tmp_path)
    monkeypatch.setattr(import_service, "REGISTRY_PATH", tmp_path / "datasets.json")
    monkeypatch.setattr(data_service, "APP_DATA_DIR", tmp_path)
    return tmp_path


def job(csv: bytes, kind: str) -> dict:
    return {"id": str(uuid4()), "lease": str(uuid4()), "filename": "logger.csv",
            "kind": kind, "device": "TEST", "bytes": len(csv)}


@pytest.mark.parametrize(
    ("kind", "csv", "date", "time", "metric"),
    [
        ("raw", b"Date,Time,MC2.5,CO2\n31-10-2026,05:30:00,12.5,600\n", "Date", "Time", "MC2.5"),
        ("raw", b"Date,Time,MC2.5,Temp\n31-10-2026,05:30:00,12.5,25\n", "Date", "Time", "MC2.5"),
        ("minute", b"timestamp_utc,pm25_ug_m3,co2_ppm\n2026-10-31T00:00:00Z,12.5,\n",
         "timestamp_utc", None, "pm25_ug_m3"),
    ],
)
def test_received_snapshot_import_is_idempotent(storage, kind, csv, date, time, metric):
    spec = job(csv, kind)
    metadata = transfer_archive.persist_snapshot(spec, [csv[:11], csv[11:]])
    assert metadata["sha256"] == sha256(csv).hexdigest()
    client = TestClient(main.app)
    response = client.get(f"/api/transfers/{spec['id']}/inspect")
    assert response.status_code == 200
    preview = response.json()
    assert preview["suggestions"]["date_column"] == date
    config = {"upload_id": preview["upload_id"], "dataset_name": "Pilot snapshot",
              "date_column": date, "time_column": time, "measurements": [{"column": metric, "label": "PM2.5"}]}
    response = client.post("/api/import/commit", json=config)
    assert response.status_code == 200, response.text
    first = response.json()["dataset"]
    assert first["start"] == "2026-10-31T00:00:00"
    assert first["source"]["sha256"] == metadata["sha256"]
    timeseries = client.get("/api/timeseries", params={
        "monitors": first["id"], "metric": "pm25", "interval": "raw",
        "start": "2026-10-31T05:30:00+05:30", "end": "2026-10-31T05:30:00+05:30",
    })
    assert timeseries.status_code == 200, timeseries.text
    assert timeseries.json()["timestamp_zone"] == "UTC"
    assert timeseries.json()["series"][0]["points"] == [
        {"timestamp": int(pd.Timestamp("2026-10-31T00:00:00Z").timestamp() * 1000), "value": 12.5},
    ]
    assert client.post("/api/import/commit", json=config).json()["dataset"]["id"] == first["id"]
    assert len(import_service.load_registry()["datasets"]) == 1
    assert transfer_archive.source(preview["upload_id"])[0].read_bytes() == csv
    frame = import_service.import_service.load_staged_frame(preview["upload_id"])
    member = CollocationMember(upload_id=preview["upload_id"], filename="logger.csv", sensor_name="TEST",
                               date_column=date, time_column=time, measurement_column=metric)
    assert collocation_service._timestamps(frame, member).iloc[0] == pd.Timestamp("2026-10-31T00:00:00")


def test_interrupted_write_and_lost_acknowledgement(storage, monkeypatch):
    csv = b"Date,Time,MC2.5\n31-10-2026,05:30:00,12.5\n"
    spec = job(csv, "raw")
    with pytest.raises(ValueError, match="declared size"):
        transfer_archive.persist_snapshot(spec, [csv[:-1]])
    assert transfer_archive.manifest(spec["id"]) is None

    worker = TransferWorker("https://example.supabase.co", "test" * 8)
    monkeypatch.setattr(worker, "chunks", lambda _: iter([csv]))
    calls = []

    def transport(action, **values):
        calls.append((action, values))
        if action == "finish":
            raise URLError("connection closed after disk write")
        if action == "recover":
            return {"status": "ready"}
        return {"job": spec if len(calls) == 1 else None}

    monkeypatch.setattr(worker, "call", transport)
    with pytest.raises(URLError):
        worker.tick()
    assert len(list(transfer_archive.unacknowledged())) == 1
    worker.tick()
    assert calls[2] == ("recover", {"id": spec["id"], "checksum": sha256(csv).hexdigest()})
    assert not list(transfer_archive.unacknowledged())
    assert len(list((storage / "dashboard").iterdir())) == 1


def test_owner_check_protects_archive_apis(storage, monkeypatch):
    monkeypatch.setattr(main, "validate_access", lambda header: header == "Bearer owner")
    client = TestClient(main.app)
    assert client.get("/api/health").status_code == 200
    for path in ("/api/catalog", "/api/transfers", "/api/collocation/sessions"):
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"Authorization": "Bearer someone-else"}).status_code == 401
        assert client.get(path, headers={"Authorization": "Bearer owner"}).status_code == 200


def test_recovery_clocks_are_not_assumed_to_be_ist(storage):
    csv = b"Record,UptimeMs,Date,Time,MC2.5\n1,10000,31-10-2026,05:30:00,12.5\n"
    spec = job(csv, "raw")
    transfer_archive.persist_snapshot(spec, [csv])
    client = TestClient(main.app)
    preview = client.get(f"/api/transfers/{spec['id']}/inspect").json()
    response = client.post("/api/import/commit", json={
        "upload_id": preview["upload_id"], "dataset_name": "Offline logger",
        "date_column": "Date", "time_column": "Time", "measurements": [],
    })
    assert response.status_code == 400
    assert "verified clock reconstruction" in response.json()["detail"]
