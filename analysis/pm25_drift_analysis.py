"""Reproducible 13–14 Nov 2026 PM2.5 collocation comparison.

Inputs are read from Downloads; results are written beside this script.
Run: python analysis/pm25_drift_analysis.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import openpyxl
import pandas as pd
from scipy import stats


DOWNLOADS = Path.home() / "Downloads"
OUT = Path(__file__).resolve().parent
START = pd.Timestamp("2026-11-13 20:30:00")
END = pd.Timestamp("2026-11-14 13:30:00")
LOGGER_FILES = {
    "logger_1": "aq_indoor01_2026-11-09_to_2026-11-15.csv",
    "logger_6": "aq_outdoor06_2026-11-09_to_2026-11-15.csv",
    "logger_7": "logger7.csv",
}


def read_grimm() -> tuple[pd.DataFrame, dict]:
    wb = openpyxl.load_workbook(DOWNLOADS / "13thnov_grimm.xlsx", read_only=True, data_only=True)
    mass_rows = wb["Mass values"].iter_rows(min_row=7, values_only=True)
    log_rows = wb["Log values"].iter_rows(min_row=7, values_only=True)
    rows = []
    for mass, log in zip(mass_rows, log_rows, strict=True):
        assert mass[0] == log[0], "GRIMM mass and status timestamps differ"
        rows.append((mass[0], mass[4], log[10]))
    wb.close()
    frame = pd.DataFrame(rows, columns=["time", "pm25", "error_code"])
    frame["time"] = pd.to_datetime(frame["time"], format="%m/%d/%Y %H:%M:%S", errors="coerce")
    window = frame.loc[(frame.time >= START) & (frame.time < END)].copy()
    quality = {
        "all_rows": len(frame),
        "window_rows": len(window),
        "all_error_codes": {str(k): int(v) for k, v in frame.error_code.value_counts(dropna=False).items()},
        "window_error_codes": {str(k): int(v) for k, v in window.error_code.value_counts(dropna=False).items()},
        "window_duplicate_timestamps": int(window.time.duplicated().sum()),
        "window_bad_pm25": int((~np.isfinite(window.pm25) | (window.pm25 < 0)).sum()),
    }
    window = window.loc[(window.error_code == 0) & np.isfinite(window.pm25) & (window.pm25 >= 0)]
    return window, quality


def read_logger(filename: str) -> tuple[pd.DataFrame, dict]:
    path = DOWNLOADS / filename
    columns = pd.read_csv(path, nrows=0).columns.tolist()
    rh = next(col for col in columns if col.startswith("Humidity"))
    temp = "Temp_C" if "Temp_C" in columns else "Temp"
    parts = []
    total_rows = invalid_timestamps = 0
    for chunk in pd.read_csv(path, chunksize=150_000, usecols=["Date", "Time", "MC2.5", rh, temp]):
        time = pd.to_datetime(chunk.Date + " " + chunk.Time, format="%d-%m-%Y %H:%M:%S", errors="coerce")
        total_rows += len(chunk)
        invalid_timestamps += int(time.isna().sum())
        in_window = (time >= START) & (time < END)
        piece = chunk.loc[in_window, ["MC2.5", rh, temp]].copy()
        piece.insert(0, "time", time.loc[in_window])
        piece.columns = ["time", "pm25", "rh", "temp"]
        parts.append(piece)
    frame = pd.concat(parts, ignore_index=True)
    quality = {
        "all_rows": total_rows,
        "bad_timestamps_all_rows": invalid_timestamps,
        "window_rows": len(frame),
        "window_duplicate_timestamps": int(frame.time.duplicated().sum()),
        "window_bad_pm25": int((~np.isfinite(frame.pm25) | (frame.pm25 < 0) | (frame.pm25 > 1000)).sum()),
        "window_first_time": str(frame.time.min()),
        "window_last_time": str(frame.time.max()),
    }
    frame = frame.loc[np.isfinite(frame.pm25) & (frame.pm25 >= 0) & (frame.pm25 <= 1000)]
    return frame, quality


def minute_mean(frame: pd.DataFrame, name: str, minimum: int) -> pd.DataFrame:
    frame = frame.set_index("time").sort_index()
    values = frame.resample("1min").agg({"pm25": ["mean", "count"], **({"rh": "mean", "temp": "mean"} if "rh" in frame else {})})
    values.columns = ["_".join(x) for x in values.columns]
    values.loc[values.pm25_count < minimum, "pm25_mean"] = np.nan
    return values.rename(columns={c: f"{name}_{c}" for c in values.columns})


def hac_regression(y: np.ndarray, x: np.ndarray, lag: int = 60) -> dict:
    """OLS with Bartlett/Newey–West covariance for dependent one-minute errors."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    mask = np.isfinite(y) & np.isfinite(x).all(axis=1)
    x, y = x[mask], y[mask]
    beta = np.linalg.lstsq(x, y, rcond=None)[0]
    residual = y - x @ beta
    bread = np.linalg.pinv(x.T @ x)
    score = x * residual[:, None]
    meat = score.T @ score
    for k in range(1, min(lag, len(y) - 1) + 1):
        cross = score[k:].T @ score[:-k]
        meat += (1 - k / (lag + 1)) * (cross + cross.T)
    se = np.sqrt(np.maximum(np.diag(bread @ meat @ bread), 0))
    return {
        "n": len(y),
        "coefficient": beta.tolist(),
        "se_hac": se.tolist(),
        "ci95_hac": np.column_stack((beta - 1.96 * se, beta + 1.96 * se)).tolist(),
        "r2": float(1 - np.sum(residual**2) / np.sum((y - np.mean(y)) ** 2)),
        "condition_number": float(np.linalg.cond(x)),
    }


def block_bootstrap_errors(error: np.ndarray, block: int = 60, repeats: int = 3000) -> dict:
    """Moving-block percentile CIs preserve within-hour serial correlation."""
    rng = np.random.default_rng(20261115)
    n = len(error)
    offsets = rng.integers(0, n - block + 1, size=(repeats, int(np.ceil(n / block))))
    indexes = (offsets[:, :, None] + np.arange(block)).reshape(repeats, -1)[:, :n]
    samples = error[indexes]
    metrics = {
        "mean_bias": np.mean(samples, axis=1),
        "mae": np.mean(np.abs(samples), axis=1),
        "rmse": np.sqrt(np.mean(samples**2, axis=1)),
    }
    return {name: np.quantile(values, [0.025, 0.975]).tolist() for name, values in metrics.items()}


def summarize(pairs: pd.DataFrame, name: str) -> dict:
    reference = pairs.grimm_pm25_mean.to_numpy()
    sensor = pairs[f"{name}_pm25_mean"].to_numpy()
    error = sensor - reference
    rh = pairs[f"{name}_rh_mean"].to_numpy()
    temp = pairs[f"{name}_temp_mean"].to_numpy()
    t_hours = ((pairs.index - START) / pd.Timedelta(hours=1)).to_numpy()
    middle = 8.5
    plain = hac_regression(error, np.column_stack([np.ones(len(error)), t_hours - middle]))
    reference_adjusted = hac_regression(
        error, np.column_stack([np.ones(len(error)), t_hours - middle, reference - np.mean(reference)])
    )
    rh_adjusted = hac_regression(
        error,
        np.column_stack([np.ones(len(error)), t_hours - middle, reference - np.mean(reference), rh - np.mean(rh)]),
    )
    line = stats.linregress(reference, sensor)
    band = np.where(sensor <= 100, 5 + 0.05 * sensor, 0.10 * sensor)
    start = pairs.index < START + pd.Timedelta(hours=2)
    end = pairs.index >= END - pd.Timedelta(hours=2)
    drift_2h = float(np.mean(error[end]) - np.mean(error[start]))
    return {
        "paired_minutes": len(pairs),
        "coverage_percent": 100 * len(pairs) / 1020,
        "reference_mean": float(np.mean(reference)),
        "logger_mean": float(np.mean(sensor)),
        "reference_min_max": [float(np.min(reference)), float(np.max(reference))],
        "logger_min_max": [float(np.min(sensor)), float(np.max(sensor))],
        "bias_mean": float(np.mean(error)),
        "bias_median": float(np.median(error)),
        "bias_relative_to_reference_mean_percent": float(100 * np.mean(error) / np.mean(reference)),
        "mean_absolute_percent_error": float(np.mean(100 * np.abs(error) / reference)),
        "mae": float(np.mean(np.abs(error))),
        "rmse": float(np.sqrt(np.mean(error**2))),
        "difference_sd": float(np.std(error, ddof=1)),
        "difference_2p5_97p5_percentile": np.quantile(error, [0.025, 0.975]).tolist(),
        "pearson_r": float(np.corrcoef(reference, sensor)[0, 1]),
        "sensor_vs_reference_slope": float(line.slope),
        "sensor_vs_reference_intercept": float(line.intercept),
        "first_2h_bias": float(np.mean(error[start])),
        "last_2h_bias": float(np.mean(error[end])),
        "first_to_last_2h_bias_change": drift_2h,
        "first_2h_n": int(np.sum(start)),
        "last_2h_n": int(np.sum(end)),
        "plain_time_trend_ug_m3_per_hour_hac": plain,
        "reference_adjusted_time_trend_hac": reference_adjusted,
        "reference_and_rh_adjusted_time_trend_hac": rh_adjusted,
        "rh_min_mean_max": [float(np.min(rh)), float(np.mean(rh)), float(np.max(rh))],
        "temp_min_mean_max": [float(np.min(temp)), float(np.mean(temp)), float(np.max(temp))],
        "sps30_spec_band_mean": float(np.mean(band)),
        "fraction_paired_minutes_exceeding_sps30_spec_band": float(np.mean(np.abs(error) > band)),
        "empirical_block_bootstrap_ci95": block_bootstrap_errors(error),
    }


def main() -> None:
    grimm, grimm_quality = read_grimm()
    joined = minute_mean(grimm, "grimm", 8)
    quality = {"grimm": grimm_quality}
    for name, filename in LOGGER_FILES.items():
        frame, quality[name] = read_logger(filename)
        joined = joined.join(minute_mean(frame, name, 24), how="outer")
    joined = joined.loc[(joined.index >= START) & (joined.index < END)]
    results = {"window_start": str(START), "window_end_exclusive": str(END), "quality": quality, "loggers": {}}
    for name in LOGGER_FILES:
        fields = ["grimm_pm25_mean", f"{name}_pm25_mean", f"{name}_rh_mean", f"{name}_temp_mean"]
        pairs = joined[fields].dropna().copy()
        pairs[f"{name}_error"] = pairs[f"{name}_pm25_mean"] - pairs.grimm_pm25_mean
        results["loggers"][name] = summarize(pairs, name)
    joined.to_csv(OUT / "pm25_minute_averages.csv", index_label="local_time_IST")
    (OUT / "pm25_results.json").write_text(json.dumps(results, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps(results, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
