from datetime import datetime
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .collocation_service import collocation_service
from .collocation_store import collocation_store
from .config import CORS_ORIGINS
from .data_service import data_service
from .import_service import import_service
from .models import (
    CollocationAnalysisRequest,
    CollocationSessionCreate,
    ImportConfig,
    StatisticalTestRequest,
    TimeSeriesResponse,
)
from .statistics_service import statistics_service

app = FastAPI(
    title="Axiom API",
    version="0.1.0",
    description="General-purpose statistical and time-series analysis API",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1500)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/catalog")
def catalog() -> dict:
    return data_service.catalog()


@app.post("/api/import/inspect")
async def inspect_upload(file: Annotated[UploadFile, File()]) -> dict:
    try:
        return await import_service.stage(file)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/import/{upload_id}/inspect")
def inspect_sheet(upload_id: str, sheet: str | None = None) -> dict:
    try:
        return import_service.inspect(upload_id, sheet)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/import/commit")
def commit_import(config: ImportConfig) -> dict:
    try:
        result = import_service.commit(config)
        data_service.clear_caches()
        return result
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/collocation/analyze")
def analyze_collocation(request: CollocationAnalysisRequest) -> dict:
    try:
        return collocation_service.analyze(request)
    except (ValueError, OSError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/collocation/sessions")
def collocation_sessions() -> list[dict]:
    return collocation_store.list()


@app.post("/api/collocation/sessions")
def save_collocation_session(request: CollocationSessionCreate) -> dict:
    try:
        return collocation_store.save(request)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/collocation/drift")
def collocation_drift(baseline_id: str, follow_up_id: str) -> dict:
    try:
        return collocation_store.compare(baseline_id, follow_up_id)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/statistics/{dataset_id}/profile")
def statistical_profile(dataset_id: str) -> dict:
    try:
        return statistics_service.profile(dataset_id)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/statistics/{dataset_id}/distribution")
def statistical_distribution(
    dataset_id: str,
    column: str,
    bins: Annotated[int, Query(ge=5, le=100)] = 30,
) -> dict:
    try:
        return statistics_service.distribution(dataset_id, column, bins)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/statistics/{dataset_id}/correlation")
def statistical_correlation(
    dataset_id: str,
    columns: Annotated[list[str] | None, Query()] = None,
    method: str = "pearson",
) -> dict:
    try:
        return statistics_service.correlation(dataset_id, columns or [], method)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/statistics/test")
def statistical_test(request: StatisticalTestRequest) -> dict:
    try:
        return statistics_service.test(request)
    except (ValueError, OSError, IndexError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/statistics/{dataset_id}/time-diagnostics")
def time_diagnostics(
    dataset_id: str,
    timestamp: str,
    column: str,
    max_lag: Annotated[int, Query(ge=1, le=100)] = 40,
) -> dict:
    try:
        return statistics_service.time_diagnostics(dataset_id, timestamp, column, max_lag)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/timeseries", response_model=TimeSeriesResponse)
def timeseries(
    monitors: Annotated[list[str], Query()],
    metric: str = "pm25",
    start: datetime | None = None,
    end: datetime | None = None,
    interval: str = "5m",
    smoothing: Annotated[int, Query(ge=1, le=60)] = 1,
) -> dict:
    try:
        return data_service.timeseries(monitors, metric, start, end, interval, smoothing)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
