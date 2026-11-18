import json

from app.config import REGISTRY_PATH
from app.data_service import data_service
from app.import_service import load_registry
from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_categorical_dataset_without_timestamp_supports_statistics() -> None:
    raw = (
        b"Region,Segment,Revenue,Cost,Satisfied\n"
        b"North,A,120,70,Yes\n"
        b"South,B,90,55,No\n"
        b"North,B,150,82,Yes\n"
        b"West,A,110,62,Yes\n"
        b"South,A,75,48,No\n"
        b"West,B,135,77,Yes\n"
    )
    inspection_response = client.post(
        "/api/import/inspect",
        files={"file": ("business.csv", raw, "text/csv")},
    )
    assert inspection_response.status_code == 200
    inspection = inspection_response.json()

    dataset_id = None
    storage_path = None
    try:
        import_response = client.post(
            "/api/import/commit",
            json={
                "upload_id": inspection["upload_id"],
                "dataset_name": "Business sample",
                "source_filename": "business.csv",
                "date_column": None,
                "time_column": None,
                "day_first": True,
                "measurements": [],
            },
        )
        assert import_response.status_code == 200
        dataset = import_response.json()["dataset"]
        dataset_id = dataset["id"]
        storage_path = dataset["storage_path"]
        assert dataset["has_time"] is False
        assert len(dataset["columns"]) == 5

        profile_response = client.get(f"/api/statistics/{dataset_id}/profile")
        assert profile_response.status_code == 200
        profile = profile_response.json()
        assert profile["rows"] == 6
        assert profile["type_counts"]["numeric"] == 2
        assert {column["name"] for column in profile["column_profiles"]} == {
            "Region",
            "Segment",
            "Revenue",
            "Cost",
            "Satisfied",
        }

        regression_response = client.post(
            "/api/statistics/test",
            json={
                "dataset_id": dataset_id,
                "test": "linear_regression",
                "columns": ["Cost", "Revenue"],
                "alpha": 0.05,
            },
        )
        assert regression_response.status_code == 200
        assert regression_response.json()["effect_size"] > 0.9
    finally:
        registry = load_registry()
        registry["datasets"] = [
            dataset for dataset in registry["datasets"] if dataset["id"] != dataset_id
        ]
        REGISTRY_PATH.write_text(json.dumps(registry, indent=2), encoding="utf-8")
        if storage_path:
            (REGISTRY_PATH.parents[1] / storage_path).unlink(missing_ok=True)
        data_service.clear_caches()
