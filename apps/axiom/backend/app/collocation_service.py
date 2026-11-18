from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats
from scipy.optimize import least_squares

from .import_service import import_service
from .models import CollocationAnalysisRequest, CollocationMember


def _number(value: float | int | None, digits: int = 3) -> float | None:
    if value is None or not math.isfinite(float(value)):
        return None
    return round(float(value), digits)


def _ccc(left: pd.Series, right: pd.Series) -> float | None:
    paired = pd.concat([left, right], axis=1).dropna()
    if len(paired) < 3:
        return None
    x = paired.iloc[:, 0].to_numpy(dtype=float)
    y = paired.iloc[:, 1].to_numpy(dtype=float)
    denominator = x.var(ddof=1) + y.var(ddof=1) + (x.mean() - y.mean()) ** 2
    if denominator == 0:
        return 1.0 if np.array_equal(x, y) else None
    return float(2 * np.cov(x, y, ddof=1)[0, 1] / denominator)


def _fit_robust(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    if len(x) < 3 or np.nanstd(x) == 0:
        return 0.0, 1.0
    initial = np.polyfit(x, y, 1)
    fit = least_squares(
        lambda params: params[0] + params[1] * x - y,
        [initial[1], initial[0]],
        loss="soft_l1",
    )
    return float(fit.x[0]), float(fit.x[1])


def _fit_candidate(model: str, x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    if model == "Identity":
        return 0.0, 1.0
    if model == "Offset only":
        return float(np.mean(y - x)), 1.0
    return _fit_robust(x, y)


def _validated_model(x: np.ndarray, y: np.ndarray) -> dict[str, Any]:
    """Select the simplest correction within one SE of the best blocked-CV model."""
    models = ["Identity", "Offset only", "Robust linear"]
    fold_count = min(5, max(2, len(x) // 20))
    indices = np.arange(len(x))
    folds = [fold for fold in np.array_split(indices, fold_count) if len(fold)]
    errors: dict[str, list[float]] = {model: [] for model in models}
    for validation in folds:
        training = np.setdiff1d(indices, validation, assume_unique=True)
        if len(training) < 3:
            continue
        for model in models:
            intercept, slope = _fit_candidate(model, x[training], y[training])
            prediction = intercept + slope * x[validation]
            errors[model].append(float(np.sqrt(np.mean((prediction - y[validation]) ** 2))))
    means = {model: float(np.mean(values)) if values else math.inf for model, values in errors.items()}
    standard_errors = {
        model: float(np.std(values, ddof=1) / np.sqrt(len(values))) if len(values) > 1 else 0.0
        for model, values in errors.items()
    }
    best = min(models, key=lambda model: means[model])
    threshold = means[best] + standard_errors[best]
    selected = next((model for model in models if means[model] <= threshold), best)
    intercept, slope = _fit_candidate(selected, x, y)
    return {
        "model": selected,
        "intercept": intercept,
        "slope": slope,
        "validation_rmse": means[selected],
        "identity_validation_rmse": means["Identity"],
        "validation_improvement_percent": (
            (1 - means[selected] / means["Identity"]) * 100
            if math.isfinite(means["Identity"]) and means["Identity"] > 0 else 0.0
        ),
        "candidate_validation_rmse": means,
        "folds": len(folds),
    }


def _infer_raw_interval(timestamps: pd.Series) -> float | None:
    differences = timestamps.sort_values().drop_duplicates().diff().dt.total_seconds().dropna()
    positive = differences[differences > 0]
    return float(positive.median()) if not positive.empty else None


def _icc_absolute(frame: pd.DataFrame) -> tuple[float | None, float | None]:
    complete = frame.dropna()
    targets, raters = complete.shape
    if targets < 3 or raters < 2:
        return None, None
    values = complete.to_numpy(dtype=float)
    grand = float(values.mean())
    row_means = values.mean(axis=1)
    column_means = values.mean(axis=0)
    ss_rows = raters * float(np.sum((row_means - grand) ** 2))
    ss_columns = targets * float(np.sum((column_means - grand) ** 2))
    residuals = values - row_means[:, None] - column_means[None, :] + grand
    ss_error = float(np.sum(residuals**2))
    ms_rows = ss_rows / (targets - 1)
    ms_columns = ss_columns / (raters - 1)
    ms_error = ss_error / ((targets - 1) * (raters - 1))
    single_denominator = ms_rows + (raters - 1) * ms_error + raters * (ms_columns - ms_error) / targets
    average_denominator = ms_rows + (ms_columns - ms_error) / targets
    single = (ms_rows - ms_error) / single_denominator if single_denominator else None
    average = (ms_rows - ms_error) / average_denominator if average_denominator else None
    return single, average


def _series_correlation(left: pd.Series, right: pd.Series | None) -> float | None:
    if right is None:
        return None
    joined = pd.concat([left, right], axis=1).dropna()
    if len(joined) < 3 or joined.iloc[:, 1].std() == 0:
        return None
    return float(joined.iloc[:, 0].corr(joined.iloc[:, 1]))


def _unit_key(unit: str) -> str:
    return (
        unit.strip().lower().replace("μ", "u").replace("µ", "u").replace("³", "3")
        .replace(" ", "").replace("^", "")
    )


def _convert_unit(values: pd.Series, source: str, target: str) -> pd.Series:
    source_key, target_key = _unit_key(source), _unit_key(target)
    if not source_key or not target_key or source_key == target_key:
        return values
    linear_groups = (
        {"ppt": 0.001, "ppb": 1.0, "ppm": 1000.0},
        {"ng/m3": 0.001, "ug/m3": 1.0, "mg/m3": 1000.0},
        {"pa": 1.0, "hpa": 100.0, "kpa": 1000.0},
        {"fraction": 1.0, "%": 0.01, "%rh": 0.01},
    )
    for group in linear_groups:
        if source_key in group and target_key in group:
            return values * group[source_key] / group[target_key]
    temperature_units = {"c", "°c", "f", "°f", "k"}
    if source_key in temperature_units and target_key in temperature_units:
        celsius = values
        if source_key in {"f", "°f"}:
            celsius = (values - 32) * 5 / 9
        elif source_key == "k":
            celsius = values - 273.15
        if target_key in {"f", "°f"}:
            return celsius * 9 / 5 + 32
        if target_key == "k":
            return celsius + 273.15
        return celsius
    raise ValueError(
        f"Cannot safely convert {source or 'unspecified unit'} to {target}. "
        "Use matching units; gas amount-to-mass conversion requires molecular and environmental context."
    )


def _relative_metric_context(values: np.ndarray, scale_type: str) -> tuple[bool, str, float | None]:
    if scale_type != "ratio":
        labels = {
            "interval": "Percentage bias is not meaningful for an interval scale with an arbitrary zero.",
            "logarithmic": "Percentage bias is not meaningful on a logarithmic scale.",
            "other": "Percentage bias was disabled for this custom measurement scale.",
        }
        return False, labels.get(scale_type, labels["other"]), None
    if not len(values):
        return False, "No paired benchmark values were available.", None
    negative_fraction = float(np.mean(values < 0))
    denominator = float(np.mean(values))
    material_scale = max(float(np.nanmax(np.abs(values))) * 1e-6, 1e-12)
    if negative_fraction > 0.01:
        return (
            False,
            "More than 1% of benchmark values are negative, so a ratio percentage is unstable.",
            None,
        )
    if denominator <= material_scale:
        return False, "The benchmark mean is too close to zero for a stable percentage.", None
    return True, "Normalized by the arithmetic mean of the paired benchmark values.", denominator


def _moving_block_intervals(
    x: np.ndarray,
    y: np.ndarray,
    relative_metrics: bool,
    replicates: int = 500,
) -> dict[str, Any]:
    if len(x) < 20:
        return {
            "replicates": 0,
            "block_length": None,
            "bias": [None, None],
            "relative_bias": [None, None],
            "agreement_limit_low": [None, None],
            "agreement_limit_high": [None, None],
        }
    residual = x - y
    lag_one = float(np.corrcoef(residual[:-1], residual[1:])[0, 1]) if len(residual) > 2 else 0.0
    if not math.isfinite(lag_one):
        lag_one = 0.0
    lag_one = min(max(lag_one, -0.9), 0.9)
    dependence_factor = max(1.0, (1 + lag_one) / (1 - lag_one))
    block_length = min(max(2, math.ceil(len(x) ** (1 / 3) * dependence_factor ** (1 / 3))), max(2, len(x) // 4))
    blocks_needed = math.ceil(len(x) / block_length)
    rng = np.random.default_rng(730241)
    bias_samples: list[float] = []
    relative_samples: list[float] = []
    low_samples: list[float] = []
    high_samples: list[float] = []
    offsets = np.arange(block_length)
    for _ in range(replicates):
        starts = rng.integers(0, len(x), size=blocks_needed)
        indices = np.concatenate([(start + offsets) % len(x) for start in starts])[: len(x)]
        sampled_residual = residual[indices]
        mean_difference = float(np.mean(sampled_residual))
        standard_deviation = float(np.std(sampled_residual, ddof=1))
        bias_samples.append(mean_difference)
        low_samples.append(mean_difference - 1.96 * standard_deviation)
        high_samples.append(mean_difference + 1.96 * standard_deviation)
        if relative_metrics:
            sampled_denominator = float(np.mean(y[indices]))
            if sampled_denominator > 1e-12:
                relative_samples.append(mean_difference / sampled_denominator * 100)

    def interval(samples: list[float]) -> list[float | None]:
        if not samples:
            return [None, None]
        low, high = np.quantile(samples, [0.025, 0.975])
        return [_number(float(low)), _number(float(high))]

    return {
        "replicates": replicates,
        "block_length": block_length,
        "bias": interval(bias_samples),
        "relative_bias": interval(relative_samples),
        "agreement_limit_low": interval(low_samples),
        "agreement_limit_high": interval(high_samples),
    }


def _range_bias(x: np.ndarray, y: np.ndarray, relative_metrics: bool) -> list[dict[str, Any]]:
    if len(y) < 9:
        return []
    lower, upper = np.quantile(y, [1 / 3, 2 / 3])
    definitions = (
        ("Low", y <= lower),
        ("Middle", (y > lower) & (y <= upper)),
        ("High", y > upper),
    )
    result = []
    for label, mask in definitions:
        if not np.any(mask):
            continue
        target, benchmark = x[mask], y[mask]
        residual = target - benchmark
        denominator = float(np.mean(benchmark))
        result.append(
            {
                "range": label,
                "minimum": _number(float(np.min(benchmark))),
                "maximum": _number(float(np.max(benchmark))),
                "paired_bins": int(len(benchmark)),
                "bias": _number(float(np.mean(residual))),
                "relative_bias": _number(float(np.mean(residual)) / denominator * 100, 1)
                if relative_metrics and denominator > 1e-12 else None,
                "rmse": _number(float(np.sqrt(np.mean(residual**2)))),
            }
        )
    return result


def _temporal_completeness(target: pd.Series, benchmark: pd.Series) -> tuple[float, int]:
    if target.empty or benchmark.empty:
        return 0.0, 0
    start = max(target.index.min(), benchmark.index.min())
    end = min(target.index.max(), benchmark.index.max())
    if start > end:
        return 0.0, 0
    expected = pd.concat([target.loc[start:end], benchmark.loc[start:end]], axis=1)
    paired = int(expected.dropna().shape[0])
    return (paired / len(expected) * 100 if len(expected) else 0.0), len(expected)


@dataclass
class PreparedSensor:
    name: str
    filename: str
    series: pd.Series
    raw_rows: int
    valid_rows: int
    invalid_timestamps: int
    duplicate_timestamps: int
    median_interval_seconds: float | None
    temperature: pd.Series | None
    humidity: pd.Series | None


class CollocationService:
    resolutions = {"1min": "1min", "5min": "5min", "15min": "15min", "1h": "1h"}

    @staticmethod
    def _timestamps(frame: pd.DataFrame, member: CollocationMember) -> pd.Series:
        if member.date_column not in frame.columns:
            raise ValueError(f"{member.filename}: timestamp column was not found")
        values = frame[member.date_column].astype("string")
        if member.time_column:
            if member.time_column not in frame.columns:
                raise ValueError(f"{member.filename}: time column was not found")
            values = values + " " + frame[member.time_column].astype("string")
        return pd.to_datetime(values, errors="coerce", dayfirst=member.day_first, format="mixed")

    def _prepare(
        self,
        member: CollocationMember,
        frequency: str,
        minimum_bin_coverage: float,
        target_unit: str,
    ) -> PreparedSensor:
        frame = import_service.load_staged_frame(member.upload_id, member.sheet)
        if member.measurement_column not in frame.columns:
            raise ValueError(f"{member.filename}: measurement column was not found")
        timestamps = self._timestamps(frame, member)
        values = pd.to_numeric(frame[member.measurement_column], errors="coerce")
        values = _convert_unit(values, member.source_unit, target_unit)
        valid = pd.DataFrame({"timestamp": timestamps, "value": values}).dropna()
        duplicates = int(valid["timestamp"].duplicated(keep=False).sum())
        interval = _infer_raw_interval(valid["timestamp"])
        raw = valid.groupby("timestamp", as_index=True)["value"].mean().sort_index()
        resampler = raw.resample(frequency)
        series = resampler.mean()
        frequency_seconds = pd.Timedelta(frequency).total_seconds()
        expected = max(1, round(frequency_seconds / interval)) if interval else 1
        minimum_count = max(1, math.ceil(expected * minimum_bin_coverage / 100))
        series = series.where(resampler.count() >= minimum_count)

        def prepare_covariate(column: str | None) -> pd.Series | None:
            if not column or column not in frame.columns:
                return None
            covariate = pd.DataFrame(
                {"timestamp": timestamps, "value": pd.to_numeric(frame[column], errors="coerce")}
            ).dropna()
            if covariate.empty:
                return None
            raw_covariate = (
                covariate.groupby("timestamp", as_index=True)["value"].mean().sort_index()
            )
            return raw_covariate.resample(frequency).mean()

        return PreparedSensor(
            name=member.sensor_name.strip(),
            filename=member.filename,
            series=series,
            raw_rows=int(len(frame)),
            valid_rows=int(len(valid)),
            invalid_timestamps=int(timestamps.isna().sum()),
            duplicate_timestamps=duplicates,
            median_interval_seconds=interval,
            temperature=prepare_covariate(member.temperature_column),
            humidity=prepare_covariate(member.humidity_column),
        )

    @staticmethod
    def _best_lag(series: pd.Series, reference: pd.Series, max_lag: int) -> tuple[int, float | None]:
        best_lag = 0
        best_correlation = -2.0
        for lag in range(-max_lag, max_lag + 1):
            shifted = series.shift(lag)
            paired = pd.concat([shifted.diff(), reference.diff()], axis=1, sort=False).dropna()
            if len(paired) < 20 or paired.iloc[:, 0].std() == 0 or paired.iloc[:, 1].std() == 0:
                continue
            correlation = float(paired.iloc[:, 0].corr(paired.iloc[:, 1]))
            if correlation > best_correlation:
                best_correlation = correlation
                best_lag = lag
        return best_lag, None if best_correlation == -2.0 else best_correlation

    @staticmethod
    def _downsample(frame: pd.DataFrame, maximum: int = 1200) -> pd.DataFrame:
        if len(frame) <= maximum:
            return frame
        indices = np.linspace(0, len(frame) - 1, maximum, dtype=int)
        return frame.iloc[np.unique(indices)]

    def analyze(self, request: CollocationAnalysisRequest) -> dict[str, Any]:
        if request.minimum_peer_count < 1:
            raise ValueError("Minimum peer count must be at least one")
        names = [member.sensor_name.strip() for member in request.members]
        if any(not name for name in names) or len(set(names)) != len(names):
            raise ValueError("Give every sensor a unique name")
        references = [member for member in request.members if member.role == "reference"]
        targets = [member for member in request.members if member.role == "sensor"]
        if request.comparison_mode == "ensemble":
            if len(request.members) < 3:
                raise ValueError("Ensemble consensus requires at least three sensor files")
            if request.minimum_peer_count > len(request.members) - 1:
                raise ValueError("Minimum peer count exceeds the available peer sensors")
            target_names = names
            reference_name = None
        else:
            if len(references) != 1:
                raise ValueError("Reference mode requires exactly one file marked as the reference")
            if not targets:
                raise ValueError("Reference mode requires at least one sensor file")
            target_names = [member.sensor_name.strip() for member in targets]
            reference_name = references[0].sensor_name.strip()
        if request.resolution not in self.resolutions:
            raise ValueError("Choose a supported analysis resolution")
        if not 0 < request.minimum_bin_coverage <= 100:
            raise ValueError("Minimum bin coverage must be between 0 and 100")
        if request.minimum_duration_hours <= 0 or request.minimum_paired_bins < 10:
            raise ValueError("Minimum duration and paired-bin requirements must be positive")

        frequency = self.resolutions[request.resolution]
        sensors = [
            self._prepare(member, frequency, request.minimum_bin_coverage, request.unit)
            for member in request.members
        ]
        combined = pd.concat({sensor.name: sensor.series for sensor in sensors}, axis=1).sort_index()
        if combined.empty:
            raise ValueError("No valid timestamped measurements were found")

        preliminary = (
            combined[reference_name]
            if reference_name else combined.median(axis=1, skipna=True)
        )
        alignments: list[dict[str, Any]] = []
        aligned = pd.DataFrame(index=combined.index)
        aligned_temperature: dict[str, pd.Series] = {}
        aligned_humidity: dict[str, pd.Series] = {}
        frequency_minutes = pd.Timedelta(frequency).total_seconds() / 60
        max_lag_bins = math.floor(request.max_lag_minutes / frequency_minutes)
        for sensor in sensors:
            if sensor.name == reference_name:
                lag, correlation = 0, 1.0
            else:
                lag, correlation = self._best_lag(sensor.series, preliminary, max_lag_bins)
            aligned[sensor.name] = sensor.series.shift(lag if request.apply_suggested_lag else 0)
            applied_lag = lag if request.apply_suggested_lag else 0
            if sensor.temperature is not None:
                aligned_temperature[sensor.name] = sensor.temperature.shift(applied_lag)
            if sensor.humidity is not None:
                aligned_humidity[sensor.name] = sensor.humidity.shift(applied_lag)
            alignments.append(
                {
                    "sensor": sensor.name,
                    "suggested_lag_minutes": round(lag * frequency_minutes),
                    "correlation": _number(correlation),
                    "status": "Review" if abs(lag) > 0 else "Aligned",
                }
            )

        observed_counts = aligned.notna().sum(axis=1)
        if reference_name:
            target_available = aligned[target_names].notna().any(axis=1)
            analysis_mask = aligned[reference_name].notna() & target_available
        else:
            analysis_mask = observed_counts >= request.minimum_peer_count + 1
        analysis = aligned.loc[analysis_mask].copy()
        if len(analysis) < 10:
            raise ValueError("The files do not have enough overlapping observations")

        sensor_results: list[dict[str, Any]] = []
        corrections: list[dict[str, Any]] = []
        corrected = aligned.copy()
        gates = request.quality_gates
        fleet_temperature = (
            pd.concat(aligned_temperature, axis=1).median(axis=1, skipna=True)
            if aligned_temperature else None
        )
        fleet_humidity = (
            pd.concat(aligned_humidity, axis=1).median(axis=1, skipna=True)
            if aligned_humidity else None
        )

        prepared_by_name = {sensor.name: sensor for sensor in sensors}
        for name in target_names:
            sensor = prepared_by_name[name]
            name = sensor.name
            if reference_name:
                benchmark = aligned[reference_name].rename("consensus")
                peer_counts = benchmark.notna().astype(int)
                benchmark_label = reference_name
            else:
                peer_frame = aligned.drop(columns=[name])
                peer_counts = peer_frame.notna().sum(axis=1)
                benchmark = peer_frame.median(axis=1, skipna=True).where(
                    peer_counts >= request.minimum_peer_count
                ).rename("consensus")
                benchmark_label = f"Median of ≥{request.minimum_peer_count} peers"
            pair = pd.concat([aligned[name].rename("sensor"), benchmark], axis=1).dropna()
            if len(pair) < 3:
                sensor_results.append(
                    {
                        "sensor": name,
                        "filename": sensor.filename,
                        "benchmark": benchmark_label,
                        "paired_bins": int(len(pair)),
                        "eligible_bins": 0,
                        "peer_count_minimum": request.minimum_peer_count if not reference_name else 1,
                        "duration_hours": 0.0,
                        "completeness": 0.0,
                        "mean": None,
                        "bias": None,
                        "bias_ci_low": None,
                        "bias_ci_high": None,
                        "relative_bias": None,
                        "relative_bias_ci_low": None,
                        "relative_bias_ci_high": None,
                        "relative_metrics_applicable": False,
                        "relative_metrics_reason": "Insufficient paired observations.",
                        "mae": None,
                        "rmse": None,
                        "nrmse": None,
                        "pearson": None,
                        "spearman": None,
                        "r_squared": None,
                        "ccc": None,
                        "slope": None,
                        "intercept": None,
                        "agreement_limit_low": None,
                        "agreement_limit_high": None,
                        "agreement_limit_low_ci": [None, None],
                        "agreement_limit_high_ci": [None, None],
                        "bootstrap_replicates": 0,
                        "bootstrap_block_length": None,
                        "range_bias": [],
                        "residual_trend_per_day": None,
                        "residual_trend_p_value": None,
                        "temperature_residual_correlation": None,
                        "humidity_residual_correlation": None,
                        "status": "Insufficient",
                        "checks": {"paired_bins": False, "duration": False},
                        "not_applicable": {
                            "relative_bias": "Insufficient paired observations.",
                            "nrmse": "Insufficient paired observations.",
                        },
                        "invalid_timestamps": sensor.invalid_timestamps,
                        "duplicate_timestamps": sensor.duplicate_timestamps,
                        "median_interval_seconds": _number(sensor.median_interval_seconds, 1),
                    }
                )
                continue
            x = pair["sensor"].to_numpy(dtype=float)
            y = pair["consensus"].to_numpy(dtype=float)
            residual = x - y
            relative_applicable, relative_reason, mean_reference = _relative_metric_context(
                y, request.scale_type
            )
            relative_bias = (
                float(np.mean(residual) / mean_reference * 100)
                if relative_applicable and mean_reference else None
            )
            rmse = float(np.sqrt(np.mean(residual**2))) if len(residual) else math.nan
            nrmse = (
                float(rmse / mean_reference * 100)
                if relative_applicable and mean_reference else None
            )
            pearson = float(stats.pearsonr(x, y).statistic) if len(x) >= 3 and np.std(x) and np.std(y) else None
            spearman = float(stats.spearmanr(x, y).statistic) if len(x) >= 3 else None
            r_squared = pearson**2 if pearson is not None else None
            agreement_sd = float(np.std(residual, ddof=1)) if len(residual) > 1 else 0.0
            agreement_mean = float(np.mean(residual)) if len(residual) else math.nan
            elapsed_days = (pair.index - pair.index.min()).total_seconds().to_numpy() / 86400
            if len(pair) >= 3 and np.ptp(elapsed_days) > 0:
                trend = stats.linregress(elapsed_days, residual)
                trend_per_day = float(trend.slope)
                trend_p_value = float(trend.pvalue)
            else:
                trend_per_day = None
                trend_p_value = None
            residual_series = pd.Series(residual, index=pair.index)

            intercept, slope = _fit_robust(x, y)
            completeness, eligible_bins = _temporal_completeness(aligned[name], benchmark)
            concordance = _ccc(pair["sensor"], pair["consensus"])
            sensor_duration_hours = (pair.index.max() - pair.index.min()).total_seconds() / 3600
            uncertainty = _moving_block_intervals(x, y, relative_applicable)
            ranges = _range_bias(x, y, relative_applicable)

            checks = {
                "paired_bins": len(pair) >= request.minimum_paired_bins,
                "duration": sensor_duration_hours >= request.minimum_duration_hours,
                "completeness": completeness >= gates.completeness,
                "ccc": concordance is not None and concordance >= gates.ccc,
                "slope": gates.slope_min <= slope <= gates.slope_max,
            }
            not_applicable: dict[str, str] = {}
            if relative_applicable:
                if gates.nrmse is not None:
                    checks["nrmse"] = nrmse is not None and nrmse <= gates.nrmse
                if gates.relative_bias is not None:
                    checks["relative_bias"] = (
                        relative_bias is not None and abs(relative_bias) <= gates.relative_bias
                    )
            else:
                not_applicable["nrmse"] = relative_reason
                not_applicable["relative_bias"] = relative_reason
            if gates.absolute_rmse is not None:
                checks["absolute_rmse"] = rmse <= gates.absolute_rmse
            sufficient = checks["paired_bins"] and checks["duration"]
            status = "Insufficient" if not sufficient else "Ready" if all(checks.values()) else "Review"
            sensor_results.append(
                {
                    "sensor": name,
                    "filename": sensor.filename,
                    "benchmark": benchmark_label,
                    "paired_bins": int(len(pair)),
                    "eligible_bins": eligible_bins,
                    "peer_count_minimum": request.minimum_peer_count if not reference_name else 1,
                    "duration_hours": _number(sensor_duration_hours, 1),
                    "completeness": _number(completeness, 1),
                    "mean": _number(float(np.mean(x)) if len(x) else None),
                    "bias": _number(float(np.mean(residual)) if len(residual) else None),
                    "bias_ci_low": uncertainty["bias"][0],
                    "bias_ci_high": uncertainty["bias"][1],
                    "relative_bias": _number(relative_bias, 1),
                    "relative_bias_ci_low": uncertainty["relative_bias"][0],
                    "relative_bias_ci_high": uncertainty["relative_bias"][1],
                    "relative_metrics_applicable": relative_applicable,
                    "relative_metrics_reason": relative_reason,
                    "mae": _number(float(np.mean(np.abs(residual))) if len(residual) else None),
                    "rmse": _number(rmse),
                    "nrmse": _number(nrmse, 1),
                    "pearson": _number(pearson),
                    "spearman": _number(spearman),
                    "r_squared": _number(r_squared),
                    "ccc": _number(concordance),
                    "slope": _number(slope),
                    "intercept": _number(intercept),
                    "agreement_limit_low": _number(agreement_mean - 1.96 * agreement_sd),
                    "agreement_limit_high": _number(agreement_mean + 1.96 * agreement_sd),
                    "agreement_limit_low_ci": uncertainty["agreement_limit_low"],
                    "agreement_limit_high_ci": uncertainty["agreement_limit_high"],
                    "bootstrap_replicates": uncertainty["replicates"],
                    "bootstrap_block_length": uncertainty["block_length"],
                    "range_bias": ranges,
                    "residual_trend_per_day": _number(trend_per_day),
                    "residual_trend_p_value": _number(trend_p_value),
                    "temperature_residual_correlation": _number(
                        _series_correlation(residual_series, fleet_temperature)
                    ),
                    "humidity_residual_correlation": _number(
                        _series_correlation(residual_series, fleet_humidity)
                    ),
                    "status": status,
                    "checks": checks,
                    "not_applicable": not_applicable,
                    "invalid_timestamps": sensor.invalid_timestamps,
                    "duplicate_timestamps": sensor.duplicate_timestamps,
                    "median_interval_seconds": _number(sensor.median_interval_seconds, 1),
                }
            )
            if not sufficient:
                continue
            selected_model = _validated_model(x, y)
            correction_intercept = selected_model["intercept"]
            correction_slope = selected_model["slope"]
            corrected[name] = correction_intercept + correction_slope * analysis[name]
            corrected_residual = (correction_intercept + correction_slope * x) - y
            corrections.append(
                {
                    "sensor": name,
                    "model": selected_model["model"],
                    "formula": f"corrected = {_number(correction_intercept)} + {_number(correction_slope)} × raw",
                    "intercept": _number(correction_intercept),
                    "slope": _number(correction_slope),
                    "raw_rmse": _number(rmse),
                    "corrected_rmse": _number(float(np.sqrt(np.mean(corrected_residual**2)))),
                    "improvement_percent": _number((1 - np.sqrt(np.mean(corrected_residual**2)) / rmse) * 100, 1) if rmse else 0.0,
                    "validation_rmse": _number(selected_model["validation_rmse"]),
                    "identity_validation_rmse": _number(
                        selected_model["identity_validation_rmse"]
                    ),
                    "validation_improvement_percent": _number(
                        selected_model["validation_improvement_percent"], 1
                    ),
                    "candidate_validation_rmse": {
                        key: _number(value) for key, value in
                        selected_model["candidate_validation_rmse"].items()
                    },
                    "validation_folds": selected_model["folds"],
                    "status": "Proposed",
                }
            )

        pairwise = aligned.corr(method="pearson", min_periods=3)
        display = self._downsample(analysis)
        series: list[dict[str, Any]] = []
        for timestamp, row in display.iterrows():
            values = {name: _number(row[name]) for name in names}
            corrected_values = {
                name: _number(corrected.loc[timestamp, name])
                if timestamp in corrected.index else None
                for name in names
            }
            valid_values = [value for value in values.values() if value is not None]
            if reference_name:
                display_consensus = values.get(reference_name)
            else:
                display_consensus = (
                    float(np.median(valid_values))
                    if len(valid_values) >= request.minimum_peer_count + 1 else None
                )
            series.append(
                {
                    "timestamp": int(timestamp.timestamp() * 1000),
                    "values": values,
                    "corrected": corrected_values,
                    "consensus": _number(display_consensus),
                }
            )

        ccc_values = [item["ccc"] for item in sensor_results if item["ccc"] is not None]
        completeness_values = [item["completeness"] for item in sensor_results]
        icc_single, icc_average = _icc_absolute(analysis) if not reference_name else (None, None)
        row_means = analysis[target_names].mean(axis=1).abs()
        fleet_cv = analysis[target_names].std(axis=1, ddof=1).div(
            row_means.where(row_means > 1e-12)
        ).mul(100)
        ready = sum(item["status"] == "Ready" for item in sensor_results)
        if reference_name:
            warnings = [
                "Accuracy claims inherit the calibration, traceability, uncertainty, and operating range of the selected reference.",
            ]
        else:
            warnings = [
                "Consensus is relative to the sensor cohort; it does not establish absolute accuracy.",
                "Common-mode drift cannot be detected without an independent reference.",
            ]
        duration_hours = (analysis.index.max() - analysis.index.min()).total_seconds() / 3600
        if duration_hours < request.minimum_duration_hours:
            warnings.append(
                f"This session is shorter than the configured {request.minimum_duration_hours:g}-hour evidence requirement."
            )
        insufficient = sum(item["status"] == "Insufficient" for item in sensor_results)
        if insufficient:
            overall_status = "Insufficient evidence"
        else:
            overall_status = "Ready" if ready == len(sensor_results) else "Review needed"

        return {
            "study": {
                "name": request.study_name,
                "parameter": request.parameter_name,
                "unit": request.unit,
                "comparison_mode": request.comparison_mode,
                "reference": reference_name,
                "scale_type": request.scale_type,
            },
            "summary": {
                "sensor_count": len(sensor_results),
                "member_count": len(sensors),
                "paired_bins": int(len(analysis)),
                "start": analysis.index.min().isoformat(),
                "end": analysis.index.max().isoformat(),
                "duration_hours": _number(duration_hours, 1),
                "resolution": request.resolution,
                "median_completeness": _number(float(np.median(completeness_values)), 1),
                "fleet_ccc": _number(float(np.median(ccc_values))) if ccc_values else None,
                "icc_single": _number(icc_single),
                "icc_average": _number(icc_average),
                "median_fleet_cv": _number(float(fleet_cv.median()), 1),
                "ready_sensors": ready,
                "insufficient_sensors": insufficient,
                "status": overall_status,
                "alignment_applied": request.apply_suggested_lag,
                "comparison_mode": request.comparison_mode,
                "reference": reference_name,
            },
            "sensors": sensor_results,
            "alignments": alignments,
            "corrections": corrections,
            "pairwise": {
                "sensors": names,
                "values": [[_number(pairwise.loc[left, right]) for right in names] for left in names],
            },
            "series": series,
            "quality_gates": gates.model_dump(),
            "minimum_requirements": {
                "peer_count": request.minimum_peer_count if not reference_name else 1,
                "duration_hours": request.minimum_duration_hours,
                "paired_bins": request.minimum_paired_bins,
            },
            "warnings": warnings,
        }


collocation_service = CollocationService()
