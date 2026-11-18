from __future__ import annotations

import math
import warnings
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats

from .data_service import data_service
from .models import StatisticalTestRequest


def _number(value: Any, digits: int = 6) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return round(result, digits) if math.isfinite(result) else None


def _probability(value: Any) -> float | None:
    """Retain small p-values; decimal rounding can change inference at alpha."""
    result = float(value)
    return result if math.isfinite(result) else None


def _numeric(series: pd.Series) -> pd.Series | None:
    if pd.api.types.is_datetime64_any_dtype(series):
        return None
    converted = pd.to_numeric(series, errors="coerce").replace([np.inf, -np.inf], np.nan)
    if pd.api.types.is_numeric_dtype(series):
        return converted
    non_null = series.notna().sum()
    return converted if non_null and converted.notna().sum() / non_null >= 0.85 else None


def _datetime(series: pd.Series) -> pd.Series | None:
    if pd.api.types.is_datetime64_any_dtype(series):
        return pd.to_datetime(series, errors="coerce")
    sample = series.dropna().head(250)
    if sample.empty:
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        parsed_sample = pd.to_datetime(sample, errors="coerce", format="mixed")
    if parsed_sample.notna().mean() < 0.8:
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return pd.to_datetime(series, errors="coerce", format="mixed")


class StatisticsService:
    @staticmethod
    def _get_column(frame: pd.DataFrame, column: str) -> pd.Series:
        if column not in frame.columns:
            raise ValueError(f"Column not found: {column}")
        return frame[column]

    @staticmethod
    def _numeric_column(frame: pd.DataFrame, column: str) -> pd.Series:
        numeric = _numeric(StatisticsService._get_column(frame, column))
        if numeric is None:
            raise ValueError(f"{column} is not numeric")
        return numeric.dropna()

    def profile(self, dataset_id: str) -> dict[str, Any]:
        frame, metadata = data_service.load_dataset(dataset_id)
        rows, column_count = frame.shape
        profiles = []
        numeric_count = categorical_count = datetime_count = 0

        for column in frame.columns:
            series = frame[column]
            missing = int(series.isna().sum())
            unique = int(series.nunique(dropna=True))
            numeric = _numeric(series)
            parsed_datetime = None if numeric is not None else _datetime(series)
            base: dict[str, Any] = {
                "name": str(column),
                "missing": missing,
                "missing_percent": _number(missing / rows * 100 if rows else 0, 2),
                "unique": unique,
            }

            if numeric is not None:
                numeric_count += 1
                values = numeric.dropna()
                q1 = values.quantile(0.25) if not values.empty else None
                q3 = values.quantile(0.75) if not values.empty else None
                mean = values.mean() if not values.empty else None
                std = values.std(ddof=1) if len(values) > 1 else None
                sem = stats.sem(values) if len(values) > 1 else None
                ci_margin = stats.t.ppf(0.975, len(values) - 1) * sem if len(values) > 1 else None
                base.update(
                    {
                        "type": "numeric",
                        "count": int(values.count()),
                        "mean": _number(mean),
                        "median": _number(values.median() if not values.empty else None),
                        "mode": [_number(value) for value in values.mode().head(3).tolist()],
                        "std": _number(std),
                        "variance": _number(values.var(ddof=1) if len(values) > 1 else None),
                        "minimum": _number(values.min() if not values.empty else None),
                        "q1": _number(q1),
                        "q3": _number(q3),
                        "maximum": _number(values.max() if not values.empty else None),
                        "range": _number(values.max() - values.min() if not values.empty else None),
                        "iqr": _number(q3 - q1 if q1 is not None and q3 is not None else None),
                        "mad": _number((values - values.median()).abs().median() if not values.empty else None),
                        "cv": _number(std / abs(mean) if std is not None and mean not in (None, 0) else None),
                        "skewness": _number(values.skew() if len(values) > 2 else None),
                        "kurtosis": _number(values.kurtosis() if len(values) > 3 else None),
                        "sem": _number(sem),
                        "ci95_low": _number(mean - ci_margin if mean is not None and ci_margin is not None else None),
                        "ci95_high": _number(mean + ci_margin if mean is not None and ci_margin is not None else None),
                    }
                )
            elif parsed_datetime is not None:
                datetime_count += 1
                valid = parsed_datetime.dropna()
                base.update(
                    {
                        "type": "datetime",
                        "count": int(valid.count()),
                        "minimum": valid.min().isoformat() if not valid.empty else None,
                        "maximum": valid.max().isoformat() if not valid.empty else None,
                    }
                )
            else:
                categorical_count += 1
                counts = series.fillna("(missing)").astype(str).value_counts().head(8)
                inferred = (
                    "boolean"
                    if unique <= 2
                    else "categorical"
                    if unique <= 100 or unique / max(rows, 1) <= 0.2
                    else "text"
                )
                base.update(
                    {
                        "type": inferred,
                        "count": int(series.notna().sum()),
                        "top_values": [
                            {
                                "value": str(value),
                                "count": int(count),
                                "percent": _number(count / max(rows, 1) * 100, 2),
                            }
                            for value, count in counts.items()
                        ],
                    }
                )
            base["invalid"] = max(0, int(series.notna().sum()) - base["count"])
            profiles.append(base)

        missing_cells = int(frame.isna().sum().sum())
        return {
            "dataset": {"id": dataset_id, "name": metadata.get("name", dataset_id)},
            "rows": int(rows),
            "columns": int(column_count),
            "duplicate_rows": int(frame.duplicated().sum()),
            "missing_cells": missing_cells,
            "invalid_cells": sum(item["invalid"] for item in profiles),
            "completeness": _number((1 - missing_cells / max(rows * column_count, 1)) * 100, 2),
            "memory_bytes": int(frame.memory_usage(deep=True).sum()),
            "type_counts": {
                "numeric": numeric_count,
                "categorical": categorical_count,
                "datetime": datetime_count,
            },
            "column_profiles": profiles,
        }

    def distribution(self, dataset_id: str, column: str, bins: int = 30) -> dict[str, Any]:
        frame, _ = data_service.load_dataset(dataset_id)
        values = self._numeric_column(frame, column)
        if len(values) < 2:
            raise ValueError("At least two numeric values are required")
        bins = max(5, min(bins, 100))
        counts, edges = np.histogram(values.to_numpy(), bins=bins)
        q1, median, q3 = values.quantile([0.25, 0.5, 0.75])
        iqr = q3 - q1
        lower_fence, upper_fence = q1 - 1.5 * iqr, q3 + 1.5 * iqr
        sample = values.sample(min(len(values), 5_000), random_state=42) if len(values) > 5_000 else values
        qq_sample = sample.sample(min(len(sample), 500), random_state=17) if len(sample) > 500 else sample
        theoretical, ordered = stats.probplot(qq_sample, dist="norm", fit=False)
        tests = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if 3 <= len(sample) <= 5_000 and sample.nunique() > 1:
                statistic, p_value = stats.shapiro(sample)
                tests.append({"name": "Shapiro–Wilk", "statistic": _number(statistic), "p_value": _probability(p_value)})
            if len(sample) >= 8 and sample.nunique() > 1:
                statistic, p_value = stats.normaltest(sample)
                tests.append({"name": "D’Agostino K²", "statistic": _number(statistic), "p_value": _probability(p_value)})
            if len(sample) > 2000 and sample.nunique() > 1:
                statistic, p_value = stats.jarque_bera(sample)
                tests.append({"name": "Jarque–Bera", "statistic": _number(statistic), "p_value": _probability(p_value)})

        return {
            "column": column,
            "count": int(len(values)),
            "histogram": {"counts": counts.tolist(), "edges": [_number(value) for value in edges]},
            "boxplot": {
                "minimum": _number(values.min()),
                "q1": _number(q1),
                "median": _number(median),
                "q3": _number(q3),
                "maximum": _number(values.max()),
                "lower_fence": _number(lower_fence),
                "upper_fence": _number(upper_fence),
                "outliers": int(((values < lower_fence) | (values > upper_fence)).sum()),
            },
            "qq_plot": [[_number(x), _number(y)] for x, y in zip(theoretical, ordered, strict=True)],
            "normality_tests": tests,
            "normality_sample_size": int(len(sample)),
            "sampling_seed": 42 if len(values) > 5000 else None,
            "likely_normal": all(item["p_value"] >= 0.05 for item in tests) if tests and all(item["p_value"] is not None for item in tests) else None,
        }

    def correlation(self, dataset_id: str, columns: list[str], method: str) -> dict[str, Any]:
        frame, _ = data_service.load_dataset(dataset_id)
        if method not in {"pearson", "spearman", "kendall"}:
            raise ValueError("Correlation method must be pearson, spearman, or kendall")
        if not columns:
            columns = [column for column in frame.columns if _numeric(frame[column]) is not None][:20]
        if len(columns) < 2:
            raise ValueError("Choose at least two numeric columns")
        if len(columns) > 30:
            raise ValueError("Correlation matrices are limited to 30 columns")

        columns = list(dict.fromkeys(columns))
        if len(columns) < 2:
            raise ValueError("Choose at least two distinct numeric columns")
        numeric = {column: self._numeric_column(frame, column) for column in columns}
        size = len(columns)
        values_matrix = [[None for _ in columns] for _ in columns]
        p_matrix = [[None for _ in columns] for _ in columns]
        n_matrix = [[0 for _ in columns] for _ in columns]
        q_matrix = [[None for _ in columns] for _ in columns]
        hypotheses = []
        function = {
            "pearson": stats.pearsonr,
            "spearman": stats.spearmanr,
            "kendall": stats.kendalltau,
        }[method]
        for i, first in enumerate(columns):
            for j in range(i, size):
                second = columns[j]
                pair = pd.concat([numeric[first], numeric[second]], axis=1).dropna()
                if len(pair) < 3 or pair.iloc[:, 0].nunique() < 2 or pair.iloc[:, 1].nunique() < 2:
                    coefficient = p_value = None
                else:
                    result = function(pair.iloc[:, 0], pair.iloc[:, 1])
                    coefficient, p_value = _number(result.statistic), _probability(result.pvalue)
                values_matrix[i][j] = values_matrix[j][i] = coefficient
                p_matrix[i][j] = p_matrix[j][i] = p_value if i != j else None
                n_matrix[i][j] = n_matrix[j][i] = int(len(pair))
                if i != j and p_value is not None:
                    hypotheses.append((i, j, p_value))
        if hypotheses:
            adjusted = stats.false_discovery_control([item[2] for item in hypotheses], method="bh")
            for (i, j, _), value in zip(hypotheses, adjusted, strict=True):
                q_matrix[i][j] = q_matrix[j][i] = float(value)
        return {
            "method": method,
            "columns": columns,
            "values": values_matrix,
            "p_values": p_matrix,
            "adjusted_p_values": q_matrix,
            "correction": "Benjamini–Hochberg",
            "hypotheses": len(hypotheses),
            "sample_sizes": n_matrix,
        }

    @staticmethod
    def _significance(p_value: float, alpha: float) -> tuple[bool, str]:
        significant = bool(p_value < alpha)
        message = (
            f"The result is statistically significant at α = {alpha:g}."
            if significant
            else f"The result is not statistically significant at α = {alpha:g}."
        )
        return significant, message

    def test(self, request: StatisticalTestRequest) -> dict[str, Any]:
        if not 0 < request.alpha < 1:
            raise ValueError("Alpha must be between 0 and 1")
        frame, _ = data_service.load_dataset(request.dataset_id)
        test, columns = request.test, request.columns
        if not columns:
            raise ValueError("Choose the required columns")
        for column in columns:
            self._get_column(frame, column)
        if len(columns) > 1 and len(set(columns)) != len(columns):
            raise ValueError("Choose distinct columns for this analysis")
        result: dict[str, Any]

        if test == "one_sample_t":
            values = self._numeric_column(frame, columns[0])
            if len(values) < 2 or values.nunique() < 2:
                raise ValueError("A t-test requires at least two observations with nonzero variance")
            statistic, p_value = stats.ttest_1samp(values, request.hypothesized_mean, nan_policy="omit")
            effect = (values.mean() - request.hypothesized_mean) / values.std(ddof=1)
            result = {
                "name": "One-sample t-test",
                "statistic_label": "t",
                "statistic": _number(statistic),
                "p_value": _number(p_value),
                "df": int(len(values) - 1),
                "n": int(len(values)),
                "effect_size": _number(effect),
                "effect_name": "Cohen’s d",
                "null_hypothesis": f"The mean of {columns[0]} equals {request.hypothesized_mean:g}.",
            }
        elif test in {"paired_t", "wilcoxon"}:
            if len(columns) < 2:
                raise ValueError("Choose two paired numeric columns")
            pair = pd.concat(
                [self._numeric_column(frame, columns[0]), self._numeric_column(frame, columns[1])],
                axis=1,
            ).dropna()
            if len(pair) < 2:
                raise ValueError("At least two complete pairs are required")
            differences = pair.iloc[:, 0] - pair.iloc[:, 1]
            if test == "paired_t" and differences.nunique() < 2:
                raise ValueError("Paired differences must have nonzero variance")
            if test == "wilcoxon" and differences.eq(0).all():
                raise ValueError("Wilcoxon requires at least one nonzero paired difference")
            if test == "paired_t":
                statistic, p_value = stats.ttest_rel(pair.iloc[:, 0], pair.iloc[:, 1])
                differences = pair.iloc[:, 0] - pair.iloc[:, 1]
                effect = differences.mean() / differences.std(ddof=1) if differences.std(ddof=1) else None
                result = {"name": "Paired t-test", "statistic_label": "t", "df": int(len(pair) - 1), "effect_size": _number(effect), "effect_name": "Cohen’s dz"}
            else:
                statistic, p_value = stats.wilcoxon(pair.iloc[:, 0], pair.iloc[:, 1])
                result = {"name": "Wilcoxon signed-rank test", "statistic_label": "W", "df": None, "effect_size": None, "effect_name": None}
            result.update({"n": int(len(pair)), "statistic": _number(statistic), "p_value": _probability(p_value), "null_hypothesis": f"{columns[0]} and {columns[1]} have no systematic paired difference."})
        elif test in {"independent_t", "mann_whitney", "anova", "kruskal"}:
            if not request.group_column:
                raise ValueError("Choose a grouping column")
            values = _numeric(self._get_column(frame, columns[0]))
            if values is None:
                raise ValueError(f"{columns[0]} is not numeric")
            grouped = pd.DataFrame({"value": values, "group": self._get_column(frame, request.group_column)}).dropna()
            group_names = request.groups or grouped["group"].astype(str).unique().tolist()
            if test in {"independent_t", "mann_whitney"}:
                if len(group_names) != 2:
                    raise ValueError("This test requires exactly two groups; select two groups or use ANOVA / Kruskal–Wallis")
            if len(set(group_names)) != len(group_names):
                raise ValueError("Choose distinct groups")
            samples = [grouped.loc[grouped["group"].astype(str) == str(name), "value"] for name in group_names]
            if len(samples) < 2 or any(len(sample) < 2 for sample in samples):
                raise ValueError("At least two groups with two observations each are required")
            analyzed = pd.concat(samples, ignore_index=True)
            if test in {"independent_t", "anova"} and all(sample.var(ddof=1) == 0 for sample in samples):
                raise ValueError("A mean-comparison test requires nonzero within-group variance")
            if test == "independent_t":
                welch = stats.ttest_ind(samples[0], samples[1], equal_var=False)
                statistic, p_value = welch.statistic, welch.pvalue
                pooled = math.sqrt(sum((len(sample) - 1) * sample.var(ddof=1) for sample in samples) / (len(analyzed) - 2))
                effect = (samples[0].mean() - samples[1].mean()) / pooled if pooled else None
                name, label, effect_name = "Welch’s independent t-test", "t", "Cohen’s d"
            elif test == "mann_whitney":
                statistic, p_value = stats.mannwhitneyu(samples[0], samples[1], alternative="two-sided")
                effect = 2 * statistic / (len(samples[0]) * len(samples[1])) - 1
                name, label, effect_name = "Mann–Whitney U test", "U", "Rank-biserial r"
            elif test == "anova":
                statistic, p_value = stats.f_oneway(*samples)
                grand_mean = analyzed.mean()
                ss_between = sum(len(sample) * (sample.mean() - grand_mean) ** 2 for sample in samples)
                ss_total = ((analyzed - grand_mean) ** 2).sum()
                effect = ss_between / ss_total if ss_total else None
                name, label, effect_name = "One-way ANOVA", "F", "Eta squared"
            else:
                statistic, p_value = stats.kruskal(*samples)
                effect = max(0, (statistic - len(samples) + 1) / (len(analyzed) - len(samples)))
                name, label, effect_name = "Kruskal–Wallis test", "H", "Epsilon squared"
            result = {
                "name": name,
                "statistic_label": label,
                "statistic": _number(statistic),
                "p_value": _number(p_value),
                "df": _number(welch.df) if test == "independent_t" else len(samples) - 1 if test in {"anova", "kruskal"} else None,
                "denominator_df": int(len(analyzed) - len(samples)) if test == "anova" else None,
                "effect_size": _number(effect),
                "effect_name": effect_name,
                "groups": [str(name) for name in group_names[: len(samples)]],
                "group_sizes": [int(len(sample)) for sample in samples],
                "n": int(len(analyzed)),
                "null_hypothesis": f"The {'means' if test in {'independent_t', 'anova'} else 'distributions'} of {columns[0]} are equal across the selected {request.group_column} groups.",
            }
        elif test == "chi_square":
            if len(columns) < 2:
                raise ValueError("Choose two categorical columns")
            table = pd.crosstab(frame[columns[0]], frame[columns[1]])
            if min(table.shape) < 2:
                raise ValueError("Each categorical column must contain at least two observed categories")
            statistic, p_value, dof, expected = stats.chi2_contingency(table)
            n = table.to_numpy().sum()
            denominator = max(min(table.shape) - 1, 1)
            effect = math.sqrt(statistic / (n * denominator)) if n else None
            result = {
                "name": "Chi-square test of independence",
                "statistic_label": "χ²",
                "statistic": _number(statistic),
                "p_value": _number(p_value),
                "df": int(dof),
                "n": int(n),
                "small_expected_cells": int((expected < 5).sum()),
                "effect_size": _number(effect),
                "effect_name": "Cramér’s V",
                "null_hypothesis": f"{columns[0]} and {columns[1]} are independent.",
                "observed": table.values.tolist(),
                "expected": [[_number(value) for value in row] for row in expected],
                "row_labels": [str(value) for value in table.index],
                "column_labels": [str(value) for value in table.columns],
            }
        elif test == "linear_regression":
            if len(columns) < 2:
                raise ValueError("Choose predictor and outcome columns")
            pair = pd.concat(
                [self._numeric_column(frame, columns[0]), self._numeric_column(frame, columns[1])],
                axis=1,
            ).dropna()
            if len(pair) < 3 or pair.iloc[:, 0].nunique() < 2 or pair.iloc[:, 1].nunique() < 2:
                raise ValueError("Regression requires at least three complete pairs and variation in both columns")
            regression = stats.linregress(pair.iloc[:, 0], pair.iloc[:, 1])
            result = {
                "name": "Simple linear regression",
                "statistic_label": "t",
                "statistic": _number(regression.slope / regression.stderr if regression.stderr else None),
                "p_value": _number(regression.pvalue),
                "df": int(len(pair) - 2),
                "effect_size": _number(regression.rvalue**2),
                "effect_name": "R²",
                "null_hypothesis": f"The slope relating {columns[0]} to {columns[1]} is zero.",
                "slope": _number(regression.slope),
                "intercept": _number(regression.intercept),
                "r": _number(regression.rvalue),
                "standard_error": _number(regression.stderr),
                "n": int(len(pair)),
            }
        else:
            raise ValueError("Unknown statistical test")

        # Infer from the full precision probability, never a display-rounded value.
        p_value = _probability(regression.pvalue if test == "linear_regression" else p_value)
        result["p_value"] = p_value
        significant, interpretation = self._significance(float(p_value), request.alpha) if p_value is not None else (False, "The result could not be evaluated.")
        result.update(
            {
                "alpha": request.alpha,
                "significant": significant,
                "interpretation": interpretation,
                "caution": "Statistical significance does not establish practical importance or causation. Inference assumes independent observations (independent pairs for paired tests); repeated sensor readings may violate this assumption.",
                "configuration": request.model_dump(),
                "excluded_rows": int(len(frame) - result.get("n", len(frame))),
            }
        )
        return result

    def time_diagnostics(
        self,
        dataset_id: str,
        timestamp: str,
        column: str,
        max_lag: int,
    ) -> dict[str, Any]:
        frame, _ = data_service.load_dataset(dataset_id)
        times = pd.to_datetime(self._get_column(frame, timestamp), errors="coerce")
        values = _numeric(self._get_column(frame, column))
        if values is None:
            raise ValueError(f"{column} is not numeric")
        pair = pd.DataFrame({"time": times, "value": values}).dropna().sort_values("time")
        if len(pair) < 4:
            raise ValueError("At least four time-ordered values are required")
        elapsed_days = (pair["time"] - pair["time"].iloc[0]).dt.total_seconds() / 86400
        if elapsed_days.nunique() < 2:
            raise ValueError("Time diagnostics require at least two distinct timestamps")
        trend = stats.linregress(elapsed_days, pair["value"])
        max_lag = max(1, min(max_lag, min(100, len(pair) // 3)))
        intervals = pair["time"].diff().dt.total_seconds().dropna()
        return {
            "count": int(len(pair)),
            "start": pair["time"].iloc[0].isoformat(),
            "end": pair["time"].iloc[-1].isoformat(),
            "median_interval_seconds": _number(intervals.median()),
            "trend_per_day": _number(trend.slope),
            "trend_p_value": _probability(trend.pvalue),
            "duplicate_timestamps": int(pair["time"].duplicated().sum()),
            "irregular_intervals": bool(intervals.nunique() > 1),
            "caution": "Lags count observations, not elapsed time. OLS trend p-values assume independent residuals; serial correlation can make them overconfident.",
            "r_squared": _number(trend.rvalue**2),
            "lags": list(range(1, max_lag + 1)),
            "autocorrelation": [_number(pair["value"].autocorr(lag)) for lag in range(1, max_lag + 1)],
        }


statistics_service = StatisticsService()
