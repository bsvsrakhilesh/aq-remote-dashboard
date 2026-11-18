from datetime import datetime, timedelta

import pandas as pd
import pytest
from app.collocation_service import _convert_unit, _relative_metric_context
from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def _sensor_csv(offset: float, scale: float = 1.0) -> bytes:
    start = datetime(2026, 1, 1, 0, 0)
    rows = ["observed_at,response,temp_c"]
    for index in range(180):
        timestamp = start + timedelta(minutes=index)
        shared_signal = 40 + (index % 45) * 0.4 + (index // 45) * 2
        value = offset + scale * shared_signal
        rows.append(f"{timestamp.isoformat()},{value:.3f},{20 + (index % 12) * 0.1:.1f}")
    return "\n".join(rows).encode()


def test_generic_collocation_reads_selected_columns_and_returns_corrections() -> None:
    uploads = []
    for index, (offset, scale) in enumerate(((0, 1), (2, 1.05), (-1, 0.96)), start=1):
        response = client.post(
            "/api/import/inspect",
            files={"file": (f"device-{index}.csv", _sensor_csv(offset, scale), "text/csv")},
        )
        assert response.status_code == 200
        inspection = response.json()
        assert {column["name"] for column in inspection["columns"]} == {
            "observed_at",
            "response",
            "temp_c",
        }
        uploads.append(inspection)

    response = client.post(
        "/api/collocation/analyze",
        json={
            "study_name": "Generic response study",
            "parameter_name": "Custom gas response",
            "unit": "ppb",
            "resolution": "1min",
            "minimum_duration_hours": 1,
            "members": [
                {
                    "upload_id": inspection["upload_id"],
                    "filename": f"anything-{index}.csv",
                    "sensor_name": f"Sensor {index}",
                    "date_column": "observed_at",
                    "measurement_column": "response",
                    "temperature_column": "temp_c",
                }
                for index, inspection in enumerate(uploads, start=1)
            ],
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["study"]["parameter"] == "Custom gas response"
    assert result["summary"]["sensor_count"] == 3
    assert result["summary"]["paired_bins"] == 180
    assert len(result["sensors"]) == 3
    assert len(result["corrections"]) == 3
    assert all(item["ccc"] > 0.6 for item in result["sensors"])
    assert all(item["temperature_residual_correlation"] is not None for item in result["sensors"])
    assert all(item["validation_folds"] == 5 for item in result["corrections"])
    assert result["summary"]["icc_single"] is not None
    assert all(item["bias_ci_low"] is not None for item in result["sensors"])
    assert all(len(item["range_bias"]) == 3 for item in result["sensors"])
    assert all(
        item["bias_ci_low"] <= item["bias"] <= item["bias_ci_high"]
        for item in result["sensors"]
    )
    assert all(item["agreement_limit_low_ci"][0] is not None for item in result["sensors"])

    insufficient_response = client.post(
        "/api/collocation/analyze",
        json={
            "parameter_name": "Custom gas response",
            "unit": "ppb",
            "minimum_duration_hours": 4,
            "members": [
                {
                    "upload_id": inspection["upload_id"],
                    "filename": f"anything-{index}.csv",
                    "sensor_name": f"Sensor {index}",
                    "date_column": "observed_at",
                    "measurement_column": "response",
                }
                for index, inspection in enumerate(uploads, start=1)
            ],
        },
    )
    assert insufficient_response.status_code == 200
    insufficient = insufficient_response.json()
    assert insufficient["summary"]["status"] == "Insufficient evidence"
    assert insufficient["corrections"] == []

    reference_response = client.post(
        "/api/collocation/analyze",
        json={
            "study_name": "Reference study",
            "parameter_name": "Temperature response",
            "unit": "custom",
            "scale_type": "interval",
            "comparison_mode": "reference",
            "minimum_duration_hours": 1,
            "minimum_paired_bins": 100,
            "members": [
                {
                    "upload_id": uploads[0]["upload_id"],
                    "filename": "reference.csv",
                    "sensor_name": "Traceable reference",
                    "role": "reference",
                    "date_column": "observed_at",
                    "measurement_column": "response",
                },
                {
                    "upload_id": uploads[1]["upload_id"],
                    "filename": "sensor.csv",
                    "sensor_name": "Sensor under test",
                    "role": "sensor",
                    "date_column": "observed_at",
                    "measurement_column": "response",
                },
            ],
        },
    )
    assert reference_response.status_code == 200, reference_response.text
    reference_result = reference_response.json()
    assert reference_result["summary"]["comparison_mode"] == "reference"
    assert reference_result["summary"]["reference"] == "Traceable reference"
    assert reference_result["summary"]["sensor_count"] == 1
    score = reference_result["sensors"][0]
    assert score["relative_bias"] is None
    assert "relative_bias" in score["not_applicable"]


def test_ensemble_collocation_requires_three_sensors() -> None:
    response = client.post(
        "/api/collocation/analyze",
        json={"parameter_name": "Any response", "members": []},
    )
    assert response.status_code == 400
    assert "at least three" in response.json()["detail"]


def test_ensemble_consensus_requires_configured_peer_count_for_each_bin() -> None:
    start = datetime(2026, 2, 1)
    upload_ids = []
    for sensor_index in range(3):
        rows = ["time,value"]
        for index in range(180):
            timestamp = start + timedelta(minutes=index)
            value = (
                ""
                if sensor_index == 2 and index % 3 == 0
                else f"{30 + index * 0.1 + sensor_index:.2f}"
            )
            rows.append(f"{timestamp.isoformat()},{value}")
        response = client.post(
            "/api/import/inspect",
            files={
                "file": (
                    f"peer-{sensor_index}.csv",
                    "\n".join(rows).encode(),
                    "text/csv",
                )
            },
        )
        assert response.status_code == 200
        upload_ids.append(response.json()["upload_id"])

    response = client.post(
        "/api/collocation/analyze",
        json={
            "parameter_name": "Generic signal",
            "minimum_duration_hours": 1,
            "minimum_paired_bins": 100,
            "minimum_peer_count": 2,
            "members": [
                {
                    "upload_id": upload_id,
                    "filename": f"arbitrary-{index}.csv",
                    "sensor_name": f"Device {index}",
                    "date_column": "time",
                    "measurement_column": "value",
                }
                for index, upload_id in enumerate(upload_ids)
            ],
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    first = next(item for item in result["sensors"] if item["sensor"] == "Device 0")
    assert first["paired_bins"] == 120
    assert first["peer_count_minimum"] == 2
    assert first["completeness"] == pytest.approx(66.7, abs=0.1)


def test_relative_metrics_require_a_stable_ratio_scale() -> None:
    applicable, _, denominator = _relative_metric_context(
        pd.Series([1.0, 2.0, 3.0]).to_numpy(), "ratio"
    )
    assert applicable is True
    assert denominator == pytest.approx(2.0)
    assert _relative_metric_context(pd.Series([-1.0, 2.0]).to_numpy(), "ratio")[0] is False
    assert _relative_metric_context(pd.Series([20.0, 21.0]).to_numpy(), "interval")[0] is False


def test_safe_unit_conversion_is_generic_and_rejects_ambiguous_gas_mass_conversion() -> None:
    values = pd.Series([1.0, 2.0])
    assert _convert_unit(values, "ppm", "ppb").tolist() == [1000.0, 2000.0]
    assert _convert_unit(values, "mg/m³", "µg/m³").tolist() == [1000.0, 2000.0]
    assert _convert_unit(pd.Series([32.0]), "°F", "°C").iloc[0] == pytest.approx(0.0)
    with pytest.raises(ValueError, match="Cannot safely convert"):
        _convert_unit(values, "ppm", "µg/m³")
