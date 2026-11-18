from typing import Any, Literal

from pydantic import BaseModel, Field


class Point(BaseModel):
    timestamp: int
    value: float | None


class SeriesStats(BaseModel):
    latest: float | None
    average: float | None
    minimum: float | None
    maximum: float | None
    p95: float | None
    points: int


class TimeSeries(BaseModel):
    monitor_id: str
    monitor_name: str
    points: list[Point]
    stats: SeriesStats


class TimeSeriesResponse(BaseModel):
    metric: str
    unit: str
    interval: str
    start: str
    end: str
    total_points: int
    series: list[TimeSeries]


class MeasurementMapping(BaseModel):
    column: str
    label: str
    unit: str = ""


class ImportConfig(BaseModel):
    upload_id: str
    dataset_name: str
    source_filename: str | None = None
    sheet: str | None = None
    date_column: str | None = None
    time_column: str | None = None
    day_first: bool = True
    measurements: list[MeasurementMapping]


class StatisticalTestRequest(BaseModel):
    dataset_id: str
    test: str
    columns: list[str] = Field(min_length=1, max_length=2)
    group_column: str | None = None
    groups: list[str] | None = None
    hypothesized_mean: float = Field(default=0, allow_inf_nan=False)
    alpha: float = Field(default=0.05, gt=0, lt=1, allow_inf_nan=False)


class CollocationMember(BaseModel):
    upload_id: str
    filename: str
    sheet: str | None = None
    sensor_name: str
    date_column: str
    time_column: str | None = None
    measurement_column: str
    source_unit: str = ""
    temperature_column: str | None = None
    humidity_column: str | None = None
    day_first: bool = True
    role: Literal["sensor", "reference"] = "sensor"


class CollocationQualityGates(BaseModel):
    completeness: float = 80.0
    ccc: float = 0.9
    nrmse: float | None = 20.0
    relative_bias: float | None = 10.0
    absolute_rmse: float | None = None
    slope_min: float = 0.85
    slope_max: float = 1.15


class CollocationAnalysisRequest(BaseModel):
    study_name: str = "Untitled collocation"
    parameter_name: str
    unit: str = ""
    resolution: str = "1min"
    minimum_bin_coverage: float = 75.0
    max_lag_minutes: int = 10
    apply_suggested_lag: bool = False
    comparison_mode: Literal["ensemble", "reference"] = "ensemble"
    scale_type: Literal["ratio", "interval", "logarithmic", "other"] = "ratio"
    minimum_peer_count: int = 2
    minimum_duration_hours: float = 8.0
    minimum_paired_bins: int = 100
    members: list[CollocationMember]
    quality_gates: CollocationQualityGates = Field(default_factory=CollocationQualityGates)


class CollocationSessionCreate(BaseModel):
    label: str
    role: str = "baseline"
    environment: str = "unspecified"
    result: dict[str, Any]
