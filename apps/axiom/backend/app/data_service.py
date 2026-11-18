from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from .config import APP_DATA_DIR, DATA_DIR, MAX_CHART_POINTS, PROJECT_ROOT, REGISTRY_PATH
from .import_service import load_registry


@dataclass(frozen=True)
class Metric:
    id: str
    label: str
    unit: str
    aliases: tuple[str, ...]
    decimals: int = 1


METRICS = (
    Metric("pm1", "PM1.0", "µg/m³", ("MC1.0",)),
    Metric("pm25", "PM2.5", "µg/m³", ("MC2.5",)),
    Metric("pm4", "PM4.0", "µg/m³", ("MC4.0",)),
    Metric("pm10", "PM10", "µg/m³", ("MC10.0",)),
    Metric("co2", "CO₂", "ppm", ("CO2",)),
    Metric("temperature", "Temperature", "°C", ("Temp_C", "Temp")),
    Metric("humidity", "Humidity", "% RH", ("Humidity_RH_percent", "Humidity")),
    Metric("particle_size", "Particle size", "µm", ("ParticleSize",), 2),
)

INTERVALS = {
    "raw": None,
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "1h": "1h",
    "6h": "6h",
    "1d": "1D",
}

FRIENDLY_NAMES = {
    "Monitor1_neardoor": "Near door",
    "Monitor2_neardisplay": "Near display",
    "Monitor3_neardoorboard": "Near door board",
    "Monitor4_boardroom": "Boardroom",
    "aq01_2026-09-14_to_2026-09-20": "AQ 01",
    "aq02_2026-09-14_to_2026-09-20": "AQ 02",
    "aq03_2026-09-14_to_2026-09-20": "AQ 03",
    "aq04_2026-09-14_to_2026-09-20": "AQ 04",
    "aq05_2026-09-14_to_2026-09-20": "AQ 05",
    "aq06_2026-09-14_to_2026-09-20": "AQ 06",
}


def _round(value: float | int | None, decimals: int = 2) -> float | None:
    if value is None or pd.isna(value) or not math.isfinite(float(value)):
        return None
    return round(float(value), decimals)


class DataService:
    def __init__(self, data_dir: Path = DATA_DIR) -> None:
        self.data_dir = data_dir

    @staticmethod
    @lru_cache(maxsize=2)
    def _dataset_file(path: str, modified_ns: int, size: int) -> pd.DataFrame:
        # File identity participates in the cache key. Callers receive a copy so
        # transformations cannot mutate cached source data across requests.
        return pd.read_csv(path, low_memory=False)

    def _dataset_frame(self, path: Path) -> pd.DataFrame:
        identity = path.stat()
        # Large files are read directly to keep retained process memory bounded.
        if identity.st_size > 64 * 1024 * 1024:
            return pd.read_csv(path, low_memory=False)
        return self._dataset_file(str(path), identity.st_mtime_ns, identity.st_size).copy()

    @property
    def files(self) -> list[Path]:
        return sorted(self.data_dir.glob("*.csv"))

    @staticmethod
    def _header(path: Path) -> list[str]:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            return next(csv.reader(handle))

    @staticmethod
    def _imported_datasets() -> list[dict]:
        return load_registry()["datasets"]

    @staticmethod
    def _imported_path(storage_path: str) -> Path:
        configured = Path(storage_path)
        path = configured.resolve() if configured.is_absolute() else (PROJECT_ROOT / configured).resolve()
        allowed_roots = (APP_DATA_DIR.resolve(), PROJECT_ROOT.resolve())
        if not any(path.is_relative_to(root) for root in allowed_roots) or not path.exists():
            raise ValueError("The imported dataset file is unavailable")
        return path

    def _all_metrics(self) -> list[Metric]:
        metrics = list(METRICS)
        existing = {metric.id for metric in metrics}
        for dataset in self._imported_datasets():
            for item in dataset["metrics"]:
                if item["id"] not in existing:
                    metrics.append(
                        Metric(
                            item["id"],
                            item["label"],
                            item.get("unit", ""),
                            (),
                            item.get("decimals", 2),
                        )
                    )
                    existing.add(item["id"])
        return metrics

    def _metric(self, metric_id: str) -> Metric:
        try:
            return next(metric for metric in self._all_metrics() if metric.id == metric_id)
        except StopIteration as exc:
            raise ValueError(f"Unknown metric: {metric_id}") from exc

    @staticmethod
    def _metric_column(metric: Metric, header: list[str]) -> str | None:
        return next((name for name in metric.aliases if name in header), None)

    @staticmethod
    def _valid_timestamp_mask(timestamps: pd.Series) -> pd.Series:
        # Sensor clocks occasionally jump years ahead. Keep these readings visible as
        # quality issues, but out of normal analysis bounds.
        upper = pd.Timestamp.now(tz="UTC").tz_localize(None) + pd.Timedelta(days=14)
        return timestamps.between(pd.Timestamp("2020-01-01"), upper)

    @lru_cache(maxsize=32)
    def _bounds_for_file(self, path_text: str, modified_ns: int, size: int) -> dict:
        path = Path(path_text)
        frame = pd.read_csv(path, usecols=["Date", "Time"], dtype="string")
        timestamps = pd.to_datetime(
            frame["Date"] + " " + frame["Time"],
            format="%d-%m-%Y %H:%M:%S",
            errors="coerce",
        )
        valid_mask = self._valid_timestamp_mask(timestamps)
        valid = timestamps[valid_mask]
        return {
            "rows": int(len(frame)),
            "valid_rows": int(valid_mask.sum()),
            "invalid_rows": int((~valid_mask).sum()),
            "start": valid.min().isoformat() if not valid.empty else None,
            "end": valid.max().isoformat() if not valid.empty else None,
        }

    def catalog(self) -> dict:
        paths = self.files + ([REGISTRY_PATH] if REGISTRY_PATH.exists() else [])
        identity = tuple((str(path), path.stat().st_mtime_ns, path.stat().st_size) for path in paths)
        return self._catalog_cached(identity)

    @lru_cache(maxsize=1)
    def _catalog_cached(self, identity: tuple) -> dict:
        monitors = []
        starts: list[pd.Timestamp] = []
        ends: list[pd.Timestamp] = []

        for path in self.files:
            header = self._header(path)
            stat = path.stat()
            bounds = self._bounds_for_file(str(path), stat.st_mtime_ns, stat.st_size)
            if bounds["start"]:
                starts.append(pd.Timestamp(bounds["start"]))
                ends.append(pd.Timestamp(bounds["end"]))
            monitors.append(
                {
                    "id": path.stem,
                    "name": FRIENDLY_NAMES.get(path.stem, path.stem.replace("_", " ").title()),
                    "filename": path.name,
                    "rows": bounds["rows"],
                    "start": bounds["start"],
                    "end": bounds["end"],
                    "invalid_rows": bounds["invalid_rows"],
                    "metrics": [
                        metric.id for metric in METRICS if self._metric_column(metric, header)
                    ],
                }
            )

        for dataset in self._imported_datasets():
            if dataset.get("start"):
                starts.append(pd.Timestamp(dataset["start"]))
                ends.append(pd.Timestamp(dataset["end"]))
            monitors.append(
                {
                    "id": dataset["id"],
                    "name": dataset["name"],
                    "filename": dataset.get("filename", "Imported dataset"),
                    "rows": dataset["rows"],
                    "start": dataset["start"],
                    "end": dataset["end"],
                    "invalid_rows": dataset.get("invalid_rows", 0),
                    "metrics": [metric["id"] for metric in dataset["metrics"]],
                    "imported": True,
                }
            )

        all_metrics = self._all_metrics()

        return {
            "monitors": monitors,
            "metrics": [
                {
                    "id": metric.id,
                    "label": metric.label,
                    "unit": metric.unit,
                    "decimals": metric.decimals,
                }
                for metric in all_metrics
            ],
            "intervals": list(INTERVALS),
            "range": {
                "start": min(starts).isoformat() if starts else None,
                "end": max(ends).isoformat() if ends else None,
            },
            "total_rows": sum(monitor["rows"] for monitor in monitors),
            "invalid_rows": sum(monitor["invalid_rows"] for monitor in monitors),
            "updated_at": datetime.now(UTC).isoformat(),
        }

    def _read_metric(self, monitor_id: str, metric: Metric) -> pd.DataFrame:
        imported = next(
            (dataset for dataset in self._imported_datasets() if dataset["id"] == monitor_id),
            None,
        )
        if imported:
            if not imported.get("has_time", bool(imported.get("start"))):
                return pd.DataFrame(columns=["timestamp", "value"])
            metric_config = next(
                (item for item in imported["metrics"] if item["id"] == metric.id),
                None,
            )
            if metric_config is None:
                return pd.DataFrame(columns=["timestamp", "value"])
            path = self._imported_path(imported["storage_path"])
            frame = pd.read_csv(
                path,
                usecols=["timestamp", metric_config["storage_column"]],
            )
            result = pd.DataFrame(
                {
                    "timestamp": pd.to_datetime(frame["timestamp"], errors="coerce"),
                    "value": pd.to_numeric(frame[metric_config["storage_column"]], errors="coerce"),
                }
            )
            return result.dropna().sort_values("timestamp")

        path = self.data_dir / f"{monitor_id}.csv"
        if not path.exists() or path.parent.resolve() != self.data_dir.resolve():
            raise ValueError(f"Unknown monitor: {monitor_id}")

        header = self._header(path)
        metric_column = self._metric_column(metric, header)
        if metric_column is None:
            return pd.DataFrame(columns=["timestamp", "value"])

        frame = pd.read_csv(
            path,
            usecols=["Date", "Time", metric_column],
            dtype={"Date": "string", "Time": "string"},
        )
        timestamps = pd.to_datetime(
            frame["Date"] + " " + frame["Time"],
            format="%d-%m-%Y %H:%M:%S",
            errors="coerce",
        )
        values = pd.to_numeric(frame[metric_column], errors="coerce")
        result = pd.DataFrame({"timestamp": timestamps, "value": values})
        result = result[self._valid_timestamp_mask(result["timestamp"])]
        return result.dropna().sort_values("timestamp")

    def load_dataset(self, dataset_id: str) -> tuple[pd.DataFrame, dict]:
        imported = next(
            (dataset for dataset in self._imported_datasets() if dataset["id"] == dataset_id),
            None,
        )
        if imported:
            path = self._imported_path(imported["storage_path"])
            frame = self._dataset_frame(path)
            rename = {
                item["storage_column"]: item["name"]
                for item in imported.get("columns", [])
                if item["storage_column"] in frame.columns
            }
            if not rename:
                rename = {
                    item["storage_column"]: item["label"]
                    for item in imported.get("metrics", [])
                    if item["storage_column"] in frame.columns
                }
            if "timestamp" in rename.values() and "timestamp" in frame.columns:
                derived_name = "Parsed timestamp"
                while derived_name in rename.values():
                    derived_name = f"_{derived_name}"
                frame = frame.rename(columns={"timestamp": derived_name})
            frame = frame.rename(columns=rename)
            return frame, imported

        path = self.data_dir / f"{dataset_id}.csv"
        if not path.exists() or path.parent.resolve() != self.data_dir.resolve():
            raise ValueError(f"Unknown dataset: {dataset_id}")
        frame = self._dataset_frame(path)
        if {"Date", "Time"}.issubset(frame.columns):
            frame.insert(
                0,
                "timestamp",
                pd.to_datetime(
                    frame["Date"].astype("string") + " " + frame["Time"].astype("string"),
                    format="%d-%m-%Y %H:%M:%S",
                    errors="coerce",
                ),
            )
        metadata = next(
            item for item in self.catalog()["monitors"] if item["id"] == dataset_id
        )
        return frame, metadata

    def clear_caches(self) -> None:
        self._catalog_cached.cache_clear()
        self._bounds_for_file.cache_clear()
        self._dataset_file.cache_clear()

    @staticmethod
    def _auto_frequency(frame: pd.DataFrame, max_points: int) -> str | None:
        if len(frame) <= max_points or frame.empty:
            return None
        duration = frame["timestamp"].iloc[-1] - frame["timestamp"].iloc[0]
        seconds = max(duration.total_seconds() / max_points, 1)
        candidates = [1, 5, 10, 30, 60, 300, 900, 3600, 21600, 86400]
        bucket = next((candidate for candidate in candidates if candidate >= seconds), 86400)
        return f"{bucket}s"

    @staticmethod
    def _aggregate(frame: pd.DataFrame, frequency: str | None) -> pd.DataFrame:
        if frame.empty or frequency is None:
            return frame
        return (
            frame.set_index("timestamp")["value"]
            .resample(frequency)
            .mean()
            .reset_index()
        )

    def timeseries(
        self,
        monitor_ids: list[str],
        metric_id: str,
        start: datetime | None,
        end: datetime | None,
        interval: str,
        smoothing: int,
    ) -> dict:
        metric = self._metric(metric_id)
        if interval not in INTERVALS:
            raise ValueError(f"Unknown interval: {interval}")
        if not monitor_ids:
            raise ValueError("Choose at least one monitor")
        if len(monitor_ids) > 10:
            raise ValueError("A maximum of 10 monitors can be compared")
        if len(set(monitor_ids)) != len(monitor_ids):
            raise ValueError("Choose distinct monitors")
        if start and end and pd.Timestamp(start).tz_localize(None) >= pd.Timestamp(end).tz_localize(None):
            raise ValueError("The start date must be before the end date")
        if not 1 <= smoothing <= 60:
            raise ValueError("Smoothing must be between 1 and 60 points")

        catalog_by_id = {item["id"]: item for item in self.catalog()["monitors"]}
        response_series = []
        actual_interval = interval

        for monitor_id in monitor_ids:
            if monitor_id not in catalog_by_id:
                raise ValueError(f"Unknown monitor: {monitor_id}")
            frame = self._read_metric(monitor_id, metric)
            if start:
                frame = frame[frame["timestamp"] >= pd.Timestamp(start).tz_localize(None)]
            if end:
                frame = frame[frame["timestamp"] <= pd.Timestamp(end).tz_localize(None)]

            frame = frame[np.isfinite(frame["value"])]
            original = frame
            frequency = INTERVALS[interval]
            if frequency is None:
                frequency = self._auto_frequency(frame, MAX_CHART_POINTS)
                if frequency:
                    actual_interval = "auto"
            frame = self._aggregate(frame, frequency)
            if len(frame) > MAX_CHART_POINTS:
                duration = (frame["timestamp"].iloc[-1] - frame["timestamp"].iloc[0]).total_seconds()
                frequency = f"{max(1, math.ceil(duration / max(MAX_CHART_POINTS - 1, 1)))}s"
                frame = self._aggregate(original, frequency)
                actual_interval = "auto"

            if smoothing > 1 and not frame.empty:
                frame = frame.assign(value=frame["value"].rolling(smoothing, min_periods=1).mean().where(frame["value"].notna()))

            values = original["value"]
            stats = {
                "latest": _round(values.iloc[-1], metric.decimals) if not values.empty else None,
                "average": _round(values.mean(), 8),
                "minimum": _round(values.min(), metric.decimals),
                "maximum": _round(values.max(), metric.decimals),
                "p95": _round(values.quantile(0.95), metric.decimals),
                "points": int(len(values)),
            }
            points = [
                {
                    "timestamp": int(timestamp.timestamp() * 1000),
                    "value": _round(value, metric.decimals + 1),
                }
                for timestamp, value in frame.itertuples(index=False, name=None)
            ]
            response_series.append(
                {
                    "monitor_id": monitor_id,
                    "monitor_name": catalog_by_id[monitor_id]["name"],
                    "points": points,
                    "stats": stats,
                }
            )

        fallback_start = start or datetime.now() - timedelta(days=1)
        fallback_end = end or datetime.now()
        return {
            "metric": metric.label,
            "unit": metric.unit,
            "interval": actual_interval,
            "start": fallback_start.isoformat(),
            "end": fallback_end.isoformat(),
            "total_points": sum(item["stats"]["points"] for item in response_series),
            "series": response_series,
        }


data_service = DataService()
