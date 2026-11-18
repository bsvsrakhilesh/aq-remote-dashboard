from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_health() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_catalog_is_valid_without_bundled_datasets() -> None:
    response = client.get("/api/catalog")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["monitors"], list)
    assert body["total_rows"] == sum(dataset["rows"] for dataset in body["monitors"])
    assert any(metric["id"] == "pm25" for metric in body["metrics"])


def test_import_rejects_unsupported_file_types() -> None:
    response = client.post(
        "/api/import/inspect",
        files={"file": ("unsafe.exe", b"not a dataset", "application/octet-stream")},
    )
    assert response.status_code == 400
    assert "CSV" in response.json()["detail"]
