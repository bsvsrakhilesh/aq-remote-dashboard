$ErrorActionPreference = "Stop"

python -m ruff check backend
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
python -m pytest -q
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm --prefix frontend run lint
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm --prefix frontend run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker compose config --quiet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Axiom verification passed." -ForegroundColor Green
