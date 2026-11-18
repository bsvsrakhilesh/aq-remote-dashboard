import { apiUrl } from './deployment'
import type {
  Catalog,
  CollocationMemberConfiguration,
  CollocationQualityGates,
  CollocationResult,
  CorrelationResult,
  DistributionResult,
  ImportedDataset,
  ImportInspection,
  DriftComparison,
  SavedCollocationSession,
  StatisticalProfile,
  StatisticalTestResult,
  TimeDiagnosticsResult,
  TimeSeriesResponse,
} from './types'

async function responseError(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => null)
  const detail: unknown = payload?.detail
  const message = typeof detail === 'string' ? detail : Array.isArray(detail)
    ? detail.map((item: { loc?: unknown[]; msg?: string }) => `${item.loc?.slice(1).join('.') || 'Request'}: ${item.msg ?? 'Invalid value'}`).join('; ')
    : `The server could not complete the request (${response.status}). Please try again.`
  return new Error(message)
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(path), { signal })
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<T>
}

export function getCatalog(signal?: AbortSignal) {
  return request<Catalog>('/api/catalog', signal)
}

export interface TimeSeriesQuery {
  monitors: string[]
  metric: string
  start: string
  end: string
  interval: string
  smoothing: number
}

export function getTimeSeries(query: TimeSeriesQuery, signal?: AbortSignal) {
  const params = new URLSearchParams()
  query.monitors.forEach((monitor) => params.append('monitors', monitor))
  params.set('metric', query.metric)
  params.set('start', query.start)
  params.set('end', query.end)
  params.set('interval', query.interval)
  params.set('smoothing', String(query.smoothing))
  return request<TimeSeriesResponse>(`/api/timeseries?${params}`, signal)
}

export async function inspectUpload(file: File, signal?: AbortSignal) {
  const body = new FormData()
  body.append('file', file)
  const response = await fetch(apiUrl('/api/import/inspect'), { method: 'POST', body, signal })
  if (!response.ok) {
    throw await responseError(response)
  }
  return response.json() as Promise<ImportInspection>
}

export function inspectSheet(uploadId: string, sheet: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ sheet })
  return request<ImportInspection>(`/api/import/${uploadId}/inspect?${params}`, signal)
}

export interface ImportConfiguration {
  upload_id: string
  dataset_name: string
  source_filename: string
  sheet: string | null
  date_column: string | null
  time_column: string | null
  day_first: boolean
  measurements: Array<{ column: string; label: string; unit: string }>
}

export async function commitImport(configuration: ImportConfiguration) {
  const response = await fetch(apiUrl('/api/import/commit'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(configuration),
  })
  if (!response.ok) {
    throw await responseError(response)
  }
  return response.json() as Promise<{ dataset: ImportedDataset }>
}

export function getStatisticalProfile(datasetId: string, signal?: AbortSignal) {
  return request<StatisticalProfile>(`/api/statistics/${encodeURIComponent(datasetId)}/profile`, signal)
}

export function getDistribution(datasetId: string, column: string, bins = 30, signal?: AbortSignal) {
  const params = new URLSearchParams({ column, bins: String(bins) })
  return request<DistributionResult>(`/api/statistics/${encodeURIComponent(datasetId)}/distribution?${params}`, signal)
}

export function getCorrelation(datasetId: string, columns: string[], method: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ method })
  columns.forEach((column) => params.append('columns', column))
  return request<CorrelationResult>(`/api/statistics/${encodeURIComponent(datasetId)}/correlation?${params}`, signal)
}

export interface StatisticalTestConfiguration {
  dataset_id: string
  test: string
  columns: string[]
  group_column?: string | null
  groups?: string[] | null
  hypothesized_mean?: number
  alpha?: number
}

export async function runStatisticalTest(configuration: StatisticalTestConfiguration, signal?: AbortSignal) {
  const response = await fetch(apiUrl('/api/statistics/test'), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(configuration),
  })
  if (!response.ok) {
    throw await responseError(response)
  }
  return response.json() as Promise<StatisticalTestResult>
}

export function getTimeDiagnostics(
  datasetId: string,
  timestamp: string,
  column: string,
  maxLag = 40,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ timestamp, column, max_lag: String(maxLag) })
  return request<TimeDiagnosticsResult>(`/api/statistics/${encodeURIComponent(datasetId)}/time-diagnostics?${params}`, signal)
}

export interface CollocationAnalysisConfiguration {
  study_name: string
  parameter_name: string
  unit: string
  resolution: string
  minimum_bin_coverage: number
  max_lag_minutes: number
  apply_suggested_lag: boolean
  comparison_mode: 'ensemble' | 'reference'
  scale_type: 'ratio' | 'interval' | 'logarithmic' | 'other'
  minimum_peer_count: number
  minimum_duration_hours: number
  minimum_paired_bins: number
  members: CollocationMemberConfiguration[]
  quality_gates: CollocationQualityGates
}

export async function analyzeCollocation(configuration: CollocationAnalysisConfiguration) {
  const response = await fetch(apiUrl('/api/collocation/analyze'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(configuration),
  })
  if (!response.ok) {
    throw await responseError(response)
  }
  return response.json() as Promise<CollocationResult>
}

export function getCollocationSessions(signal?: AbortSignal) {
  return request<SavedCollocationSession[]>('/api/collocation/sessions', signal)
}

export async function saveCollocationSession(configuration: {
  label: string
  role: 'baseline' | 'follow_up' | 'post_deployment'
  environment: string
  result: CollocationResult
}) {
  const response = await fetch(apiUrl('/api/collocation/sessions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(configuration),
  })
  if (!response.ok) {
    throw await responseError(response)
  }
  return response.json() as Promise<SavedCollocationSession>
}

export function getDriftComparison(baselineId: string, followUpId: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ baseline_id: baselineId, follow_up_id: followUpId })
  return request<DriftComparison>(`/api/collocation/drift?${params}`, signal)
}
