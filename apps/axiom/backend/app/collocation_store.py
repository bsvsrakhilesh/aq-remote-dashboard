from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import STATE_DB_PATH
from .models import CollocationSessionCreate


class CollocationStore:
    def __init__(self, path: Path = STATE_DB_PATH) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with closing(self._connection()) as connection:
            with connection:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS collocation_sessions (
                        id TEXT PRIMARY KEY,
                        study_name TEXT NOT NULL,
                        parameter_name TEXT NOT NULL,
                        unit TEXT NOT NULL,
                        label TEXT NOT NULL,
                        role TEXT NOT NULL,
                        environment TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        result_json TEXT NOT NULL
                    )
                    """
                )

    @staticmethod
    def _validate_result(result: dict[str, Any]) -> None:
        if not isinstance(result.get("study"), dict) or not isinstance(result.get("summary"), dict):
            raise ValueError("The collocation result is incomplete")
        if not isinstance(result.get("sensors"), list) or not result["sensors"]:
            raise ValueError("The collocation result has no sensor scorecards")

    def save(self, request: CollocationSessionCreate) -> dict[str, Any]:
        self._validate_result(request.result)
        if request.role not in {"baseline", "follow_up", "post_deployment"}:
            raise ValueError("Choose a valid session role")
        if not request.label.strip():
            raise ValueError("Enter a session label")
        study = request.result["study"]
        compact_result = {
            "study": study,
            "summary": request.result["summary"],
            "sensors": request.result["sensors"],
            "corrections": request.result.get("corrections", []),
            "quality_gates": request.result.get("quality_gates", {}),
            "warnings": request.result.get("warnings", []),
        }
        session_id = uuid.uuid4().hex
        created_at = datetime.now(UTC).isoformat()
        with closing(self._connection()) as connection:
            with connection:
                connection.execute(
                    """
                    INSERT INTO collocation_sessions (
                        id, study_name, parameter_name, unit, label, role,
                        environment, created_at, result_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        str(study.get("name", "Untitled collocation")),
                        str(study.get("parameter", "")),
                        str(study.get("unit", "")),
                        request.label.strip(),
                        request.role,
                        request.environment.strip() or "unspecified",
                        created_at,
                        json.dumps(compact_result, separators=(",", ":")),
                    ),
                )
        return {
            "id": session_id,
            "study_name": study.get("name", "Untitled collocation"),
            "parameter": study.get("parameter", ""),
            "unit": study.get("unit", ""),
            "label": request.label.strip(),
            "role": request.role,
            "environment": request.environment.strip() or "unspecified",
            "created_at": created_at,
            "summary": compact_result["summary"],
        }

    def list(self) -> list[dict[str, Any]]:
        with closing(self._connection()) as connection:
            rows = connection.execute(
                "SELECT * FROM collocation_sessions ORDER BY created_at DESC"
            ).fetchall()
        return [self._metadata(row) for row in rows]

    @staticmethod
    def _metadata(row: sqlite3.Row) -> dict[str, Any]:
        result = json.loads(row["result_json"])
        return {
            "id": row["id"],
            "study_name": row["study_name"],
            "parameter": row["parameter_name"],
            "unit": row["unit"],
            "label": row["label"],
            "role": row["role"],
            "environment": row["environment"],
            "created_at": row["created_at"],
            "summary": result["summary"],
        }

    def _result(self, session_id: str) -> tuple[sqlite3.Row, dict[str, Any]]:
        with closing(self._connection()) as connection:
            row = connection.execute(
                "SELECT * FROM collocation_sessions WHERE id = ?", (session_id,)
            ).fetchone()
        if row is None:
            raise ValueError("The saved collocation session was not found")
        return row, json.loads(row["result_json"])

    def compare(self, baseline_id: str, follow_up_id: str) -> dict[str, Any]:
        baseline_row, baseline = self._result(baseline_id)
        follow_row, follow = self._result(follow_up_id)
        if baseline_row["parameter_name"] != follow_row["parameter_name"]:
            raise ValueError("Drift comparison requires the same parameter")
        if baseline_row["unit"] != follow_row["unit"]:
            raise ValueError("Drift comparison requires the same canonical unit")
        baseline_sensors = {item["sensor"]: item for item in baseline["sensors"]}
        follow_sensors = {item["sensor"]: item for item in follow["sensors"]}
        scale_type = baseline.get("study", {}).get("scale_type", "ratio")
        absolute_rmse_gate = baseline.get("quality_gates", {}).get("absolute_rmse")
        common = sorted(set(baseline_sensors) & set(follow_sensors))
        if not common:
            raise ValueError("No sensor names match between these sessions")
        comparisons = []
        for sensor in common:
            before, after = baseline_sensors[sensor], follow_sensors[sensor]
            relative_bias_change = _difference(after.get("relative_bias"), before.get("relative_bias"))
            nrmse_change = _difference(after.get("nrmse"), before.get("nrmse"))
            ccc_change = _difference(after.get("ccc"), before.get("ccc"))
            slope_change_percent = _percent_change(after.get("slope"), before.get("slope"))
            absolute_bias_change = _difference(after.get("bias"), before.get("bias"))
            rmse_change = _difference(after.get("rmse"), before.get("rmse"))
            if any(value is None for value in (ccc_change, slope_change_percent)):
                status = "Insufficient"
            elif scale_type == "ratio" and (
                relative_bias_change is None
                or nrmse_change is None
            ):
                status = "Insufficient"
            elif (
                scale_type == "ratio"
                and (
                    abs(relative_bias_change or 0) >= 10
                    or (after.get("nrmse") or 0) > 20
                )
            ) or abs(slope_change_percent) >= 15 or (
                scale_type != "ratio"
                and absolute_rmse_gate is not None
                and (after.get("rmse") or 0) > absolute_rmse_gate
            ):
                status = "Drift signal"
            elif ccc_change < -0.05 or after.get("status") == "Review":
                status = "Review"
            else:
                status = "Stable"
            comparisons.append(
                {
                    "sensor": sensor,
                    "status": status,
                    "relative_bias_change": relative_bias_change,
                    "absolute_bias_change": absolute_bias_change,
                    "nrmse_change": nrmse_change,
                    "rmse_change": rmse_change,
                    "ccc_change": ccc_change,
                    "slope_change_percent": slope_change_percent,
                    "baseline": before,
                    "follow_up": after,
                }
            )
        severity = {"Stable": 0, "Review": 1, "Drift signal": 2, "Insufficient": 3}
        overall = max((item["status"] for item in comparisons), key=severity.get)
        return {
            "baseline": self._metadata(baseline_row),
            "follow_up": self._metadata(follow_row),
            "parameter": baseline_row["parameter_name"],
            "unit": baseline_row["unit"],
            "scale_type": scale_type,
            "status": overall,
            "sensors": comparisons,
            "thresholds": {
                "relative_bias_change_percentage_points": 10,
                "slope_change_percent": 15,
                "follow_up_nrmse_percent": 20,
            },
        }


def _difference(after: Any, before: Any) -> float | None:
    if after is None or before is None:
        return None
    return round(float(after) - float(before), 3)


def _percent_change(after: Any, before: Any) -> float | None:
    if after is None or before is None or abs(float(before)) < 1e-12:
        return None
    return round((float(after) - float(before)) / abs(float(before)) * 100, 3)


collocation_store = CollocationStore()
