from copy import deepcopy
from pathlib import Path
from uuid import uuid4

from app.collocation_store import CollocationStore
from app.models import CollocationSessionCreate


def _result(relative_bias: float, slope: float, nrmse: float, ccc: float) -> dict:
    return {
        "study": {
            "name": "Fleet",
            "parameter": "CO2",
            "unit": "ppm",
            "scale_type": "ratio",
        },
        "summary": {"status": "Ready", "sensor_count": 3},
        "sensors": [
            {
                "sensor": name,
                "relative_bias": relative_bias,
                "bias": relative_bias,
                "slope": slope,
                "nrmse": nrmse,
                "rmse": nrmse,
                "ccc": ccc,
                "status": "Ready",
            }
            for name in ("A", "B", "C")
        ],
        "corrections": [],
        "quality_gates": {},
        "warnings": [],
    }


def test_saved_sessions_support_longitudinal_drift_comparison() -> None:
    path = Path(".axiom") / "tests" / f"{uuid4().hex}.sqlite3"
    try:
        store = CollocationStore(path)
        baseline = store.save(
            CollocationSessionCreate(
                label="Baseline",
                role="baseline",
                environment="Indoor",
                result=_result(1, 1, 5, 0.98),
            )
        )
        changed = deepcopy(_result(13, 1.2, 24, 0.85))
        follow_up = store.save(
            CollocationSessionCreate(
                label="60-day follow-up",
                role="follow_up",
                environment="Indoor",
                result=changed,
            )
        )
        comparison = store.compare(baseline["id"], follow_up["id"])
        assert comparison["status"] == "Drift signal"
        assert len(comparison["sensors"]) == 3
        assert comparison["sensors"][0]["relative_bias_change"] == 12
        assert len(store.list()) == 2

        interval_baseline_result = _result(0, 1, 0, 0.98)
        interval_baseline_result["study"].update(
            {"parameter": "Temperature", "unit": "Â°C", "scale_type": "interval"}
        )
        interval_follow_result = deepcopy(interval_baseline_result)
        for sensor in interval_baseline_result["sensors"]:
            sensor.update({"relative_bias": None, "nrmse": None, "bias": 0.2, "rmse": 0.5})
        for sensor in interval_follow_result["sensors"]:
            sensor.update(
                {"relative_bias": None, "nrmse": None, "bias": 1.4, "rmse": 1.8, "slope": 1.2}
            )
        interval_baseline = store.save(
            CollocationSessionCreate(
                label="Temperature baseline",
                role="baseline",
                environment="Indoor",
                result=interval_baseline_result,
            )
        )
        interval_follow = store.save(
            CollocationSessionCreate(
                label="Temperature follow-up",
                role="follow_up",
                environment="Indoor",
                result=interval_follow_result,
            )
        )
        interval_comparison = store.compare(interval_baseline["id"], interval_follow["id"])
        assert interval_comparison["scale_type"] == "interval"
        assert interval_comparison["status"] == "Drift signal"
        assert interval_comparison["sensors"][0]["relative_bias_change"] is None
        assert interval_comparison["sensors"][0]["absolute_bias_change"] == 1.2
    finally:
        path.unlink(missing_ok=True)
