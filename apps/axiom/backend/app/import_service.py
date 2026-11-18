from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Any

import pandas as pd
from fastapi import UploadFile
from starlette.concurrency import run_in_threadpool

from .config import (
    IMPORTED_DIR,
    MAX_UPLOAD_BYTES,
    REGISTRY_PATH,
    STAGING_DIR,
)
from .models import ImportConfig

ALLOWED_EXTENSIONS = {".csv", ".tsv", ".txt", ".json", ".xlsx", ".xls"}
EXCEL_EXTENSIONS = {".xlsx", ".xls"}
_REGISTRY_LOCK = Lock()

STANDARD_METRICS = {
    "mc10": ("pm1", "PM1.0", "µg/m³"),
    "pm1": ("pm1", "PM1.0", "µg/m³"),
    "pm10": ("pm10", "PM10", "µg/m³"),
    "mc25": ("pm25", "PM2.5", "µg/m³"),
    "pm25": ("pm25", "PM2.5", "µg/m³"),
    "mc40": ("pm4", "PM4.0", "µg/m³"),
    "pm40": ("pm4", "PM4.0", "µg/m³"),
    "mc100": ("pm10", "PM10", "µg/m³"),
    "pm100": ("pm10", "PM10", "µg/m³"),
    "co2": ("co2", "CO₂", "ppm"),
    "temperature": ("temperature", "Temperature", "°C"),
    "tempc": ("temperature", "Temperature", "°C"),
    "temp": ("temperature", "Temperature", "°C"),
    "humidity": ("humidity", "Humidity", "% RH"),
    "humidityrhpercent": ("humidity", "Humidity", "% RH"),
    "particlesize": ("particle_size", "Particle size", "µm"),
}


def _slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return normalized[:48] or "measurement"


def _normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def load_registry() -> dict[str, list[dict[str, Any]]]:
    if not REGISTRY_PATH.exists():
        return {"datasets": []}
    try:
        content = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"datasets": []}
    return content if isinstance(content.get("datasets"), list) else {"datasets": []}


class ImportService:
    def __init__(self) -> None:
        STAGING_DIR.mkdir(parents=True, exist_ok=True)
        IMPORTED_DIR.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _stage_path(upload_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", upload_id):
            raise ValueError("Invalid upload session")
        matches = list(STAGING_DIR.glob(f"{upload_id}.*"))
        if len(matches) != 1:
            raise ValueError("Upload session was not found or has expired")
        return matches[0]

    @staticmethod
    def _cleanup_stale_uploads() -> None:
        cutoff = time.time() - 24 * 60 * 60
        for path in STAGING_DIR.iterdir():
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)

    @staticmethod
    def _read_table(path: Path, sheet: str | None = None, nrows: int | None = None) -> pd.DataFrame:
        if path.suffix.lower() in EXCEL_EXTENSIONS:
            return pd.read_excel(path, sheet_name=sheet or 0, nrows=nrows)
        if path.suffix.lower() == ".json":
            frame = pd.read_json(path)
            return frame.head(nrows) if nrows is not None else frame

        last_error: Exception | None = None
        for encoding in ("utf-8-sig", "utf-8", "latin-1"):
            try:
                return pd.read_csv(
                    path,
                    sep=None,
                    engine="python",
                    encoding=encoding,
                    nrows=nrows,
                )
            except UnicodeDecodeError as exc:
                last_error = exc
        raise ValueError("The text encoding could not be detected") from last_error

    @staticmethod
    def _sheets(path: Path) -> list[str]:
        if path.suffix.lower() not in EXCEL_EXTENSIONS:
            return []
        return [str(name) for name in pd.ExcelFile(path).sheet_names]

    @staticmethod
    def _column_profile(series: pd.Series) -> dict[str, Any]:
        non_null = series.dropna()
        sample = [str(value)[:80] for value in non_null.head(3).tolist()]
        if non_null.empty:
            detected_type = "empty"
        else:
            numeric_ratio = pd.to_numeric(non_null, errors="coerce").notna().mean()
            if numeric_ratio >= 0.8:
                detected_type = "number"
            else:
                parsed_dates = pd.to_datetime(non_null.head(100), errors="coerce", format="mixed")
                detected_type = "date/time" if parsed_dates.notna().mean() >= 0.8 else "text"
        return {
            "name": str(series.name),
            "type": detected_type,
            "sample": sample,
            "nulls_in_sample": int(series.isna().sum()),
        }

    @staticmethod
    def _suggestions(columns: list[dict[str, Any]]) -> dict[str, Any]:
        names = {item["name"]: _normalized(item["name"]) for item in columns}
        timestamp = next(
            (name for name, normalized in names.items() if normalized in {"timestamp", "datetime", "dateandtime"}),
            None,
        )
        date = timestamp or next(
            (name for name, normalized in names.items() if normalized == "date" or normalized.endswith("date")),
            None,
        )
        if date is None:
            date = next(
                (item["name"] for item in columns if item["type"] == "date/time" and _normalized(item["name"]) != "time"),
                None,
            )
        time = None if timestamp else next(
            (name for name, normalized in names.items() if normalized == "time" or normalized.endswith("time")),
            None,
        )
        measurements = [
            item["name"]
            for item in columns
            if item["type"] == "number" and item["name"] not in {date, time}
        ]
        return {"date_column": date, "time_column": time, "measurements": measurements}

    async def stage(self, upload: UploadFile) -> dict[str, Any]:
        self._cleanup_stale_uploads()
        original_name = Path(upload.filename or "upload").name
        extension = Path(original_name).suffix.lower()
        if extension not in ALLOWED_EXTENSIONS:
            raise ValueError("Use CSV, TSV, TXT, JSON, XLSX, or XLS files")

        upload_id = uuid.uuid4().hex
        path = STAGING_DIR / f"{upload_id}{extension}"
        size = 0
        try:
            with path.open("wb") as handle:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise ValueError("Files must be 100 MB or smaller")
                    handle.write(chunk)
            if size == 0:
                raise ValueError("The uploaded file is empty")
            result = await run_in_threadpool(self.inspect, upload_id)
            result.update({"filename": original_name, "size": size})
            return result
        except Exception:
            path.unlink(missing_ok=True)
            raise
        finally:
            await upload.close()

    def inspect(self, upload_id: str, sheet: str | None = None) -> dict[str, Any]:
        path = self._stage_path(upload_id)
        sheets = self._sheets(path)
        if sheet and sheets and sheet not in sheets:
            raise ValueError("The selected worksheet does not exist")
        frame = self._read_table(path, sheet=sheet, nrows=250)
        if frame.empty and len(frame.columns) == 0:
            raise ValueError("No columns were found in this file")
        frame.columns = [str(column).strip() for column in frame.columns]
        if len(set(frame.columns)) != len(frame.columns):
            raise ValueError("Column names must be unique")
        columns = [self._column_profile(frame[column]) for column in frame.columns]
        return {
            "upload_id": upload_id,
            "sheets": sheets,
            "selected_sheet": sheet or (sheets[0] if sheets else None),
            "columns": columns,
            "sample_rows": int(len(frame)),
            "suggestions": self._suggestions(columns),
        }

    def load_staged_frame(self, upload_id: str, sheet: str | None = None) -> pd.DataFrame:
        """Read a staged upload for a downstream, user-confirmed workflow."""
        path = self._stage_path(upload_id)
        frame = self._read_table(path, sheet=sheet)
        frame.columns = [str(column).strip() for column in frame.columns]
        if len(set(frame.columns)) != len(frame.columns):
            raise ValueError("Column names must be unique")
        return frame

    @staticmethod
    def _metric_definition(column: str, label: str, unit: str) -> tuple[str, str, str]:
        # Preserve the decimal distinction between PM1.0 and PM10.
        key = "pm1" if column.lower().strip() == "pm1.0" else _normalized(column)
        standard = STANDARD_METRICS.get(key)
        if standard:
            metric_id, standard_label, standard_unit = standard
            if not unit or unit.strip() == standard_unit:
                return metric_id, label or standard_label, unit or standard_unit
        unit_key = hashlib.sha256(unit.strip().encode()).hexdigest()[:8]
        return f"custom__{_slug(label or column)}_{unit_key}", label or column, unit

    def commit(self, config: ImportConfig) -> dict[str, Any]:
        if not config.dataset_name.strip():
            raise ValueError("Enter a dataset name")

        path = self._stage_path(config.upload_id)
        frame = self._read_table(path, sheet=config.sheet)
        frame.columns = [str(column).strip() for column in frame.columns]
        required = [*[item.column for item in config.measurements]]
        if config.date_column:
            required.append(config.date_column)
        if config.time_column:
            required.append(config.time_column)
        missing = [column for column in required if column not in frame.columns]
        if missing:
            raise ValueError(f"Columns not found: {', '.join(missing)}")

        timestamps: pd.Series | None = None
        if config.date_column:
            date_values = frame[config.date_column].astype("string")
            if config.time_column:
                date_values = date_values + " " + frame[config.time_column].astype("string")
            timestamps = pd.to_datetime(
                date_values,
                errors="coerce",
                dayfirst=config.day_first,
                format="mixed",
            )

        dataset_id = f"imported_{_slug(config.dataset_name)}_{uuid.uuid4().hex[:8]}"
        normalized = pd.DataFrame(index=frame.index)
        if timestamps is not None:
            normalized["timestamp"] = timestamps

        column_entries: list[dict[str, Any]] = []
        storage_by_source: dict[str, str] = {}
        for index, column in enumerate(frame.columns):
            storage_column = f"column_{index + 1}"
            profile = self._column_profile(frame[column])
            if profile["type"] == "number":
                normalized[storage_column] = pd.to_numeric(frame[column], errors="coerce")
            else:
                normalized[storage_column] = frame[column]
            storage_by_source[column] = storage_column
            column_entries.append(
                {
                    "name": column,
                    "storage_column": storage_column,
                    "type": profile["type"],
                }
            )

        metric_entries: list[dict[str, Any]] = []
        seen_metric_ids: set[str] = set()
        for index, mapping in enumerate(config.measurements):
            metric_id, label, unit = self._metric_definition(mapping.column, mapping.label, mapping.unit)
            if metric_id in seen_metric_ids:
                metric_id = f"{metric_id}_{index + 1}"
            seen_metric_ids.add(metric_id)
            storage_column = storage_by_source[mapping.column]
            normalized[storage_column] = pd.to_numeric(frame[mapping.column], errors="coerce")
            metric_entries.append(
                {
                    "id": metric_id,
                    "label": label,
                    "unit": unit,
                    "source_column": mapping.column,
                    "storage_column": storage_column,
                    "decimals": 2,
                }
            )

        invalid_timestamp_rows = int(timestamps.isna().sum()) if timestamps is not None else 0
        valid_timestamps = timestamps.dropna() if timestamps is not None else pd.Series(dtype="datetime64[ns]")
        if timestamps is not None:
            normalized["timestamp"] = normalized["timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%S")
        destination = IMPORTED_DIR / f"{dataset_id}.csv"
        normalized.to_csv(destination, index=False)

        dataset = {
            "id": dataset_id,
            "name": config.dataset_name.strip(),
            "filename": Path(config.source_filename or path.name).name,
            "storage_path": str(destination),
            "rows": int(len(normalized)),
            "invalid_rows": invalid_timestamp_rows,
            "start": valid_timestamps.min().isoformat() if not valid_timestamps.empty else None,
            "end": valid_timestamps.max().isoformat() if not valid_timestamps.empty else None,
            "has_time": timestamps is not None and not valid_timestamps.empty,
            "columns": column_entries,
            "metrics": metric_entries,
            "sheet": config.sheet,
        }
        # Serialize the read/modify/write operation within this local API process.
        # Atomic replacement also prevents readers seeing partially written JSON.
        with _REGISTRY_LOCK:
            registry = load_registry()
            registry["datasets"].append(dataset)
            REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
            temporary = REGISTRY_PATH.with_suffix(f".{uuid.uuid4().hex}.tmp")
            try:
                temporary.write_text(json.dumps(registry, indent=2), encoding="utf-8")
                temporary.replace(REGISTRY_PATH)
            finally:
                temporary.unlink(missing_ok=True)
        path.unlink(missing_ok=True)
        return {"dataset": dataset}


import_service = ImportService()
