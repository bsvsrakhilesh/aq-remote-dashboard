# Architecture

```text
Browser
  -> Nginx :8080
       -> static React application
       -> /api/* proxy
            -> FastAPI :8000
                 -> pandas / SciPy analysis services
                 -> read-only source directory
                 -> persistent Axiom state volume
```

The browser never receives a whole source workbook by default. FastAPI performs parsing, validation, inference, and statistics, then returns schema metadata and chart-ready results. Nginx provides one same-origin entry point, which keeps the browser configuration portable and avoids production CORS complexity.

The service boundaries leave room for later additions: background jobs for expensive analyses, object storage for datasets, PostgreSQL for metadata, DuckDB or Polars for larger local workloads, and separately deployed model-serving workers for ML/LLM features.

The collocation service consumes user-confirmed mappings from staged uploads. It normalizes each sensor independently, applies coverage-aware aggregation, diagnoses relative clock offsets, and calculates leave-one-out consensus metrics. Suggested shifts and correction profiles are returned as reviewable metadata; source rows are immutable. Correction selection uses contiguous time-block validation to avoid random-split leakage in time-dependent measurements.

Uploaded data is application state, not source code. It is written to the `axiom-state` volume and excluded from images and Git. Files discovered through `AXIOM_INPUT_DIR` are mounted read-only.
