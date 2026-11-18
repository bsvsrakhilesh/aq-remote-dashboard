import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("AXIOM_DATA_DIR", PROJECT_ROOT)).resolve()
MAX_CHART_POINTS = 2_500
APP_DATA_DIR = Path(os.getenv("AXIOM_APP_DATA_DIR", PROJECT_ROOT / ".axiom")).resolve()
STAGING_DIR = APP_DATA_DIR / "staging"
IMPORTED_DIR = APP_DATA_DIR / "imported"
REGISTRY_PATH = APP_DATA_DIR / "datasets.json"
STATE_DB_PATH = APP_DATA_DIR / "axiom.sqlite3"
MAX_UPLOAD_BYTES = int(os.getenv("AXIOM_MAX_UPLOAD_BYTES", 100 * 1024 * 1024))
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "AXIOM_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
