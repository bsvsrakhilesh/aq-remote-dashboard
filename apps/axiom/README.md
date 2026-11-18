# Axiom

Axiom is a polished, general-purpose statistical analysis workspace for structured data. Upload a CSV, TSV, text, JSON, XLSX, or XLS file; inspect the inferred schema; choose the columns that matter; and move directly into guided or expert analysis without using Excel.

## What it does

- Searchable dataset library and responsive research workspace with keyboard navigation and recoverable errors
- Reproducible analysis exports, normal Q–Q plots, and multiple-comparison-adjusted correlation results

- Guided multi-format import with worksheet, delimiter, header, type, date, time, and measure detection
- Complete profiling for missingness, uniqueness, duplicates, memory use, and inferred roles
- Descriptive statistics: central tendency, dispersion, quantiles, confidence intervals, skewness, kurtosis, and robust measures
- Distribution analysis with histograms, box-plot values, outliers, Q-Q data, and normality tests
- Pearson, Spearman, and Kendall correlations with p-values and pairwise sample sizes
- Parametric and non-parametric hypothesis tests, chi-square analysis, and simple regression
- Effect sizes including Cohen's d, rank-biserial correlation, eta squared, epsilon squared, Cramer's V, and R-squared
- Time-series charts, resampling, smoothing, date ranges, trend analysis, cadence, and autocorrelation diagnostics
- Generic sensor collocation for PM, gases, CO₂, VOCs, meteorology, noise, radiation, and custom numeric responses
- Dynamic per-file column mapping, clock-offset review, leave-one-out fleet consensus, configurable readiness gates, ICC/CCC, Bland–Altman limits, environmental residual diagnostics, and blocked-validation correction profiles
- Persistent baseline, follow-up, and post-deployment sessions with sensor-level drift classification and exportable corrected data
- Guided explanations for newer analysts and complete controls/results for experts
- Responsive, keyboard-friendly UI with loading, empty, and error states

Statistical results expose assumptions and sample sizes. Significance is paired with effect size and never presented as proof of causation.

## Collocation workflow

Open **Collocation** and upload one file per sensor. Axiom reads the headers and sample values from every file, suggests timestamp and numeric measurement fields, and exposes the actual detected columns in dropdowns. Different filenames and source-column names can be mapped to one shared parameter.

Reference-free consensus analysis requires at least three sensors. Clock offsets are diagnosed but never applied without confirmation. Results distinguish relative fleet agreement from absolute accuracy, retain the raw timestamps and measurements, and export approved corrected values beside the originals.

## Quick start with Docker

Docker is the simplest production-like setup:

```powershell
docker compose up --build -d
```

Open `http://localhost:3000`. During local backend development, interactive API documentation is available at `http://localhost:8000/docs`.

By default, Axiom discovers top-level CSV files in this repository without modifying them. Browser uploads and the dataset registry persist in the `axiom-state` Docker volume. Copy `.env.example` to `.env` to change the web port, input directory, or upload limit.

## Developer setup

Use Python 3.12+ and Node 22:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
npm --prefix frontend ci
```

Run the API and frontend in separate terminals:

```powershell
uvicorn backend.app.main:app --reload
npm --prefix frontend run dev
```

Open `http://localhost:5173`. Vite proxies `/api` requests to FastAPI.

## Verify the repository

```powershell
.\scripts\verify.ps1
```

The same backend, frontend, and container checks run in GitHub Actions. CodeQL scans Python and JavaScript/TypeScript, Dependabot maintains dependencies, and release workflows publish provenance and SBOM-enabled images to GitHub Container Registry.

## Architecture and roadmap

- **Web:** React 19, TypeScript, Vite, Apache ECharts, Nginx
- **API:** FastAPI, Pydantic, pandas, SciPy
- **Deployment:** Docker Compose, GitHub Actions, GitHub Container Registry
- **Scale path:** optional DuckDB, Polars, and PyArrow dependency group
- **ML path:** isolated scikit-learn and MLflow dependency group, ready for background model jobs and model-serving APIs

See [collocation methods](docs/collocation-methods.md), [architecture](docs/architecture.md), [deployment](docs/deployment.md), [contributing](CONTRIBUTING.md), and [security](SECURITY.md) for details.

See [analysis quality and reproducibility](docs/analysis-quality.md) for statistical assumptions, sampling, units, exports, browser checks, and operational limits.

## Data and privacy

Source datasets, `.axiom/` working state, environment files, and common generated data formats are excluded from Git and Docker build contexts. Original input files are never modified. Do not use the default local configuration as a public multi-user service without the controls listed in the deployment guide.

## License

MIT
