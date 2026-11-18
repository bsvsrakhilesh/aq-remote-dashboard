import numpy as np
import pandas as pd
import pytest
from app.data_service import DataService, data_service
from app.import_service import ImportService
from app.models import StatisticalTestRequest
from app.statistics_service import statistics_service
from scipy import stats


@pytest.fixture
def dataset(monkeypatch):
    def install(frame):
        monkeypatch.setattr(data_service, "load_dataset", lambda _: (frame, {"name": "Fixture"}))
    return install


def test_correlation_adjusts_only_unique_pairs_and_retains_small_probabilities(dataset):
    rng = np.random.default_rng(21)
    x = rng.normal(size=80)
    frame = pd.DataFrame({"x": x, "y": x + rng.normal(0, .5, 80), "z": rng.normal(size=80)})
    dataset(frame)
    result = statistics_service.correlation("fixture", list(frame), "pearson")
    pairs = [(0, 1), (0, 2), (1, 2)]
    raw = [stats.pearsonr(frame.iloc[:, i], frame.iloc[:, j]).pvalue for i, j in pairs]
    adjusted = stats.false_discovery_control(raw)
    assert result["hypotheses"] == 3
    assert 0 < result["p_values"][0][1] < 1e-6
    for (i, j), expected in zip(pairs, adjusted, strict=True):
        assert result["adjusted_p_values"][i][j] == pytest.approx(expected)
        assert result["adjusted_p_values"][i][j] == result["adjusted_p_values"][j][i]
    assert result["adjusted_p_values"][0][0] is None


def test_constant_distribution_is_not_claimed_to_be_normal(dataset):
    dataset(pd.DataFrame({"x": [5.0] * 30}))
    result = statistics_service.distribution("fixture", "x")
    assert result["likely_normal"] is None
    assert result["normality_tests"] == []


def test_distribution_discloses_reproducible_sampling(dataset):
    dataset(pd.DataFrame({"x": np.random.default_rng(8).normal(size=6000)}))
    result = statistics_service.distribution("fixture", "x")
    assert result["normality_sample_size"] == 5000
    assert result["sampling_seed"] == 42
    assert result == statistics_service.distribution("fixture", "x")


def test_two_group_test_does_not_silently_drop_third_group(dataset):
    dataset(pd.DataFrame({"x": [1, 2, 3, 4, 5, 6], "group": ["a", "a", "b", "b", "c", "c"]}))
    with pytest.raises(ValueError, match="exactly two"):
        statistics_service.test(StatisticalTestRequest(dataset_id="fixture", test="independent_t", columns=["x"], group_column="group"))


def test_selected_group_anova_effect_uses_only_selected_observations(dataset):
    dataset(pd.DataFrame({"x": [1, 2, 3, 5, 6, 7, 900, 1000], "group": ["a"] * 3 + ["b"] * 3 + ["c"] * 2}))
    result = statistics_service.test(StatisticalTestRequest(dataset_id="fixture", test="anova", columns=["x"], group_column="group", groups=["a", "b"]))
    assert result["effect_size"] == pytest.approx(24 / 28, abs=1e-6)
    assert result["n"] == 6
    assert result["excluded_rows"] == 2


def test_welch_effect_size_uses_pooled_sample_variance(dataset):
    a, b = np.array([1, 3, 4]), np.array([5, 6, 7, 9, 11])
    dataset(pd.DataFrame({"x": np.concatenate([a, b]), "g": ["a"] * len(a) + ["b"] * len(b)}))
    result = statistics_service.test(StatisticalTestRequest(dataset_id="fixture", test="independent_t", columns=["x"], group_column="g"))
    pooled = np.sqrt(((len(a) - 1) * a.var(ddof=1) + (len(b) - 1) * b.var(ddof=1)) / (len(a) + len(b) - 2))
    assert result["effect_size"] == pytest.approx((a.mean() - b.mean()) / pooled, abs=1e-6)


@pytest.mark.parametrize("test,columns", [("one_sample_t", ["x"]), ("linear_regression", ["x", "y"]), ("paired_t", ["x", "y"])])
def test_degenerate_samples_have_actionable_errors(dataset, test, columns):
    dataset(pd.DataFrame({"x": [1, 1, 1], "y": [2, 2, 2]}))
    with pytest.raises(ValueError):
        statistics_service.test(StatisticalTestRequest(dataset_id="fixture", test=test, columns=columns))


def test_missing_group_column_has_validation_error(dataset):
    dataset(pd.DataFrame({"x": [1, 2, 3]}))
    with pytest.raises(ValueError, match="Column not found"):
        statistics_service.test(StatisticalTestRequest(dataset_id="fixture", test="independent_t", columns=["x"], group_column="missing"))


def test_aggregation_preserves_missing_time_bins():
    frame = pd.DataFrame({"timestamp": pd.to_datetime(["2026-01-01 00:00", "2026-01-01 00:03"]), "value": [1., 4.]})
    result = DataService._aggregate(frame, "1min")
    assert len(result) == 4
    assert result["value"].isna().sum() == 2


def test_reversed_time_range_is_rejected():
    with pytest.raises(ValueError, match="start date"):
        DataService().timeseries(["fixture"], "pm25", pd.Timestamp("2026-01-02"), pd.Timestamp("2026-01-01"), "5m", 1)


def test_pm1_and_pm10_imports_remain_distinct():
    assert ImportService._metric_definition("PM1.0", "", "")[0] == "pm1"
    assert ImportService._metric_definition("PM10", "", "")[0] == "pm10"
    assert ImportService._metric_definition("MC10.0", "", "")[0] == "pm10"


def test_different_units_cannot_be_silently_compared():
    assert ImportService._metric_definition("PM2.5", "PM2.5", "mg/m³")[0] != "pm25"
    assert ImportService._metric_definition("custom", "Measurement", "m")[0] != ImportService._metric_definition("custom", "Measurement", "cm")[0]


def test_dataset_cache_invalidates_and_does_not_share_mutations(tmp_path):
    path = tmp_path / "sample.csv"
    path.write_text("x\n1\n2\n", encoding="utf-8")
    service = DataService(tmp_path)
    frame = service._dataset_frame(path)
    frame.loc[0, "x"] = 999
    assert service._dataset_frame(path).loc[0, "x"] == 1
    path.write_text("x\n100\n200\n300\n", encoding="utf-8")
    assert service._dataset_frame(path).loc[0, "x"] == 100


def test_significance_is_decided_before_display_rounding(dataset, monkeypatch):
    dataset(pd.DataFrame({"x": [1., 2., 3.]}))
    monkeypatch.setattr(stats, "ttest_1samp", lambda *args, **kwargs: (2.1, .0499999))
    result = statistics_service.test(StatisticalTestRequest(dataset_id="fixture", test="one_sample_t", columns=["x"]))
    assert result["significant"] is True
    assert result["p_value"] == .0499999


def test_invalid_numeric_values_are_reported_separately(dataset):
    dataset(pd.DataFrame({"x": [1., 2., np.inf, np.nan]}))
    result = statistics_service.profile("fixture")
    assert result["missing_cells"] == 1
    assert result["invalid_cells"] == 1
    assert result["column_profiles"][0]["count"] == 2


def test_raw_smoothing_does_not_change_summary_statistics(monkeypatch):
    service = DataService()
    monkeypatch.setattr(service, "catalog", lambda: {"monitors": [{"id": "fixture", "name": "Fixture"}]})
    monkeypatch.setattr(service, "_read_metric", lambda *_: pd.DataFrame({"timestamp": pd.date_range("2026-01-01", periods=3, freq="min"), "value": [1., 2., 9.]}))
    result = service.timeseries(["fixture"], "pm25", None, None, "raw", 3)
    assert result["series"][0]["stats"]["average"] == 4
    assert result["series"][0]["stats"]["latest"] == 9
    assert result["series"][0]["points"][-1]["value"] == 4


def test_imported_timestamp_column_does_not_collide_with_derived_time(monkeypatch, tmp_path):
    path = tmp_path / "stored.csv"
    path.write_text("timestamp,column_1,column_2\n2026-01-01T00:00:00,2026-01-01,12\n", encoding="utf-8")
    service = DataService(tmp_path)
    metadata = {"id": "fixture", "storage_path": str(path), "columns": [{"name": "timestamp", "storage_column": "column_1"}, {"name": "value", "storage_column": "column_2"}]}
    monkeypatch.setattr(service, "_imported_datasets", lambda: [metadata])
    monkeypatch.setattr(service, "_imported_path", lambda _: path)
    frame, _ = service.load_dataset("fixture")
    assert frame.columns.is_unique
    assert set(frame.columns) == {"Parsed timestamp", "timestamp", "value"}
    assert frame["timestamp"].iloc[0] == "2026-01-01"


def test_zero_variance_groups_cannot_produce_spurious_significance(dataset):
    dataset(pd.DataFrame({"x": [1, 1, 2, 2], "group": ["a", "a", "b", "b"]}))
    with pytest.raises(ValueError, match="within-group variance"):
        statistics_service.test(StatisticalTestRequest(dataset_id="fixture", test="independent_t", columns=["x"], group_column="group"))


def test_wilcoxon_allows_tied_nonzero_differences(dataset):
    dataset(pd.DataFrame({"x": [4, 5, 6], "y": [1, 2, 3]}))
    result = statistics_service.test(StatisticalTestRequest(dataset_id="fixture", test="wilcoxon", columns=["x", "y"]))
    assert result["p_value"] == pytest.approx(stats.wilcoxon([4, 5, 6], [1, 2, 3]).pvalue)
    assert result["n"] == 3
