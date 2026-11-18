export interface Metric {
  id: string
  label: string
  unit: string
  decimals: number
}

export interface Monitor {
  id: string
  name: string
  filename: string
  rows: number
  start: string | null
  end: string | null
  invalid_rows: number
  metrics: string[]
  imported?: boolean
}

export interface Catalog {
  monitors: Monitor[]
  metrics: Metric[]
  intervals: string[]
  range: { start: string | null; end: string | null }
  total_rows: number
  invalid_rows: number
  updated_at: string
}

export interface SeriesStats {
  latest: number | null
  average: number | null
  minimum: number | null
  maximum: number | null
  p95: number | null
  points: number
}

export interface TimeSeries {
  monitor_id: string
  monitor_name: string
  points: Array<{ timestamp: number; value: number | null }>
  stats: SeriesStats
}

export interface TimeSeriesResponse {
  metric: string
  unit: string
  interval: string
  start: string
  end: string
  total_points: number
  series: TimeSeries[]
}

export interface ColumnProfile {
  name: string
  type: 'number' | 'date/time' | 'text' | 'empty'
  sample: string[]
  nulls_in_sample: number
}

export interface ImportInspection {
  upload_id: string
  filename: string
  size: number
  sheets: string[]
  selected_sheet: string | null
  columns: ColumnProfile[]
  sample_rows: number
  suggestions: {
    date_column: string | null
    time_column: string | null
    measurements: string[]
  }
}

export interface ImportedDataset {
  id: string
  name: string
  rows: number
  invalid_rows: number
  start: string | null
  end: string | null
  has_time?: boolean
  columns?: Array<{ name: string; type: string }>
  metrics: Array<{
    id: string
    label: string
    unit: string
    source_column: string
  }>
}

export interface StatColumnProfile {
  invalid: number
  name: string
  type: 'numeric' | 'datetime' | 'categorical' | 'boolean' | 'text'
  count: number
  missing: number
  missing_percent: number
  unique: number
  mean?: number | null
  median?: number | null
  mode?: Array<number | null>
  std?: number | null
  variance?: number | null
  minimum?: number | string | null
  q1?: number | null
  q3?: number | null
  maximum?: number | string | null
  range?: number | null
  iqr?: number | null
  mad?: number | null
  cv?: number | null
  skewness?: number | null
  kurtosis?: number | null
  sem?: number | null
  ci95_low?: number | null
  ci95_high?: number | null
  top_values?: Array<{ value: string; count: number; percent: number }>
}

export interface StatisticalProfile {
  invalid_cells: number
  dataset: { id: string; name: string }
  rows: number
  columns: number
  duplicate_rows: number
  missing_cells: number
  completeness: number
  memory_bytes: number
  type_counts: { numeric: number; categorical: number; datetime: number }
  column_profiles: StatColumnProfile[]
}

export interface DistributionResult {
  column: string
  count: number
  histogram: { counts: number[]; edges: Array<number | null> }
  boxplot: {
    minimum: number
    q1: number
    median: number
    q3: number
    maximum: number
    lower_fence: number
    upper_fence: number
    outliers: number
  }
  qq_plot: Array<[number, number]>
  normality_tests: Array<{ name: string; statistic: number | null; p_value: number | null }>
  normality_sample_size: number
  sampling_seed: number | null
  likely_normal: boolean | null
}

export interface CorrelationResult {
  method: string
  columns: string[]
  values: Array<Array<number | null>>
  p_values: Array<Array<number | null>>
  adjusted_p_values: Array<Array<number | null>>
  correction: string
  hypotheses: number
  sample_sizes: number[][]
}

export interface StatisticalTestResult {
  name: string
  statistic_label: string
  statistic: number | null
  p_value: number | null
  df: number | null
  effect_size: number | null
  effect_name: string | null
  null_hypothesis: string
  alpha: number
  significant: boolean
  interpretation: string
  caution: string
  [key: string]: unknown
}

export interface TimeDiagnosticsResult {
  caution: string
  irregular_intervals: boolean
  duplicate_timestamps: number
  count: number
  start: string
  end: string
  median_interval_seconds: number
  trend_per_day: number
  trend_p_value: number
  r_squared: number
  lags: number[]
  autocorrelation: Array<number | null>
}

export interface CollocationMemberConfiguration {
  upload_id: string
  filename: string
  sheet: string | null
  sensor_name: string
  date_column: string
  time_column: string | null
  measurement_column: string
  source_unit: string
  temperature_column: string | null
  humidity_column: string | null
  day_first: boolean
  role: 'sensor' | 'reference'
}

export interface CollocationQualityGates {
  completeness: number
  ccc: number
  nrmse: number | null
  relative_bias: number | null
  absolute_rmse: number | null
  slope_min: number
  slope_max: number
}

export interface CollocationResult {
  study: {
    name: string
    parameter: string
    unit: string
    comparison_mode: 'ensemble' | 'reference'
    reference: string | null
    scale_type: 'ratio' | 'interval' | 'logarithmic' | 'other'
  }
  summary: {
    sensor_count: number
    member_count: number
    paired_bins: number
    start: string
    end: string
    duration_hours: number
    resolution: string
    median_completeness: number
    fleet_ccc: number | null
    icc_single: number | null
    icc_average: number | null
    median_fleet_cv: number | null
    ready_sensors: number
    insufficient_sensors: number
    status: string
    alignment_applied: boolean
    comparison_mode: 'ensemble' | 'reference'
    reference: string | null
  }
  sensors: Array<{
    sensor: string
    filename: string
    benchmark: string
    paired_bins: number
    eligible_bins: number
    peer_count_minimum: number
    duration_hours: number
    completeness: number
    mean: number | null
    bias: number | null
    bias_ci_low: number | null
    bias_ci_high: number | null
    relative_bias: number | null
    relative_bias_ci_low: number | null
    relative_bias_ci_high: number | null
    relative_metrics_applicable: boolean
    relative_metrics_reason: string
    mae: number | null
    rmse: number | null
    nrmse: number | null
    pearson: number | null
    spearman: number | null
    r_squared: number | null
    ccc: number | null
    slope: number | null
    intercept: number | null
    agreement_limit_low: number | null
    agreement_limit_high: number | null
    agreement_limit_low_ci: [number | null, number | null]
    agreement_limit_high_ci: [number | null, number | null]
    bootstrap_replicates: number
    bootstrap_block_length: number | null
    range_bias: Array<{
      range: string
      minimum: number | null
      maximum: number | null
      paired_bins: number
      bias: number | null
      relative_bias: number | null
      rmse: number | null
    }>
    residual_trend_per_day: number | null
    residual_trend_p_value: number | null
    temperature_residual_correlation: number | null
    humidity_residual_correlation: number | null
    status: string
    checks: Record<string, boolean>
    not_applicable: Record<string, string>
    invalid_timestamps: number
    duplicate_timestamps: number
    median_interval_seconds: number | null
  }>
  alignments: Array<{
    sensor: string
    suggested_lag_minutes: number
    correlation: number | null
    status: string
  }>
  corrections: Array<{
    sensor: string
    model: string
    formula: string
    intercept: number
    slope: number
    raw_rmse: number
    corrected_rmse: number
    improvement_percent: number
    validation_rmse: number
    identity_validation_rmse: number
    validation_improvement_percent: number
    candidate_validation_rmse: Record<string, number | null>
    validation_folds: number
    status: string
  }>
  pairwise: { sensors: string[]; values: Array<Array<number | null>> }
  series: Array<{
    timestamp: number
    consensus: number | null
    values: Record<string, number | null>
    corrected: Record<string, number | null>
  }>
  quality_gates: CollocationQualityGates
  minimum_requirements: {
    peer_count: number
    duration_hours: number
    paired_bins: number
  }
  warnings: string[]
}

export interface SavedCollocationSession {
  id: string
  study_name: string
  parameter: string
  unit: string
  label: string
  role: 'baseline' | 'follow_up' | 'post_deployment'
  environment: string
  created_at: string
  summary: CollocationResult['summary']
}

export interface DriftComparison {
  baseline: SavedCollocationSession
  follow_up: SavedCollocationSession
  parameter: string
  unit: string
  scale_type: 'ratio' | 'interval' | 'logarithmic' | 'other'
  status: 'Stable' | 'Review' | 'Drift signal' | 'Insufficient'
  sensors: Array<{
    sensor: string
    status: 'Stable' | 'Review' | 'Drift signal' | 'Insufficient'
    relative_bias_change: number | null
    absolute_bias_change: number | null
    nrmse_change: number | null
    rmse_change: number | null
    ccc_change: number | null
    slope_change_percent: number | null
    baseline: CollocationResult['sensors'][number]
    follow_up: CollocationResult['sensors'][number]
  }>
  thresholds: Record<string, number>
}
