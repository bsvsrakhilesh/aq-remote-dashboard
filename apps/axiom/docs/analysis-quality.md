# Analysis quality and reproducibility

Axiom is an exploratory analysis workspace. It computes statistical results locally on the API server. Guidance is deterministic and rule-based; no external LLM is configured and no dataset is sent to an AI provider.

## Statistical methods

- **Summary statistics:** finite numeric observations only. Missing source cells and invalid inferred values are reported separately. Standard deviations use the sample denominator. The 95% mean interval uses Student's t and assumes independent observations; it is not adjusted for serial dependence.
- **Combined time-series average:** the mean of per-series raw averages, weighted by each series' valid reading count. It is not a time-weighted exposure estimate. Latest values across sensors can come from different timestamps.
- **Correlation:** pairwise complete observations, at least three pairs, nonconstant columns. Each unique pair is calculated once. Raw p-values retain floating-point precision. Markers use Benjamini–Hochberg adjusted p-values across valid unique off-diagonal pairs at 0.05. The correction's guarantees require independence or appropriate positive dependence; it does not fix dependence between sensor observations. See [SciPy's false discovery control documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.false_discovery_control.html).
- **Normality:** Shapiro–Wilk for 3–5,000 observations; D’Agostino K² for at least 8; Jarque–Bera only above 2,000. For larger datasets, normality tests use a reproducible sample of 5,000 with seed 42. Constant or insufficient samples are unevaluable. Failure to reject does not establish normality. See [Shapiro–Wilk](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.shapiro.html) and [Jarque–Bera](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.jarque_bera.html).
- **Q–Q plot:** at most 500 sampled observations, seed 17 when subsampled, with a quartile reference line. This is a visual diagnostic, not a fitted regression or acceptance gate.
- **Tests:** two-group methods require two explicit groups; they never silently discard further groups. Cohen's d uses pooled sample variance. ANOVA effect sizes use only the analyzed groups. Degenerate t-tests, constant paired differences in t-tests, and underspecified regressions are rejected with actionable messages. Chi-square results flag expected cells below five.
- **Time diagnostics:** autocorrelation lags count observations, not elapsed time. Duplicate timestamps and irregular cadence are exposed. OLS trend p-values are not corrected for autocorrelated residuals.

## Time series and units

Charts preserve empty aggregation bins as visible gaps. Rolling smoothing does not fill those gaps. Summaries are computed before aggregation and smoothing. A chart point budget applies to explicit and automatic resolutions; long windows may use automatic resolution.

Sensor timestamps without a timezone retain their source clock values. The chart uses UTC coordinate formatting to avoid silently shifting these values into the browser timezone. CSV exports label these timestamps `timestamp_source_clock` without asserting a timezone. Normalize source clocks before comparing datasets from different timezones.

PM1.0 and PM10 remain distinct on import. Explicit units that differ from a standard metric's unit receive a separate metric identifier; Axiom does not automatically convert units. Custom measurements with the same label but different units also remain separate.

## Exports

**Export view** downloads displayed chart values, including aggregation and smoothing. **Save analysis** and **Export analysis** download versioned JSON containing configuration, results, and export time. These files support review but do not replace archiving the original dataset and environment. They contain no source-data hash or immutable server-side audit history.

Spreadsheet CSV labels are quoted and formula-leading strings are neutralized. Original source files remain unchanged.

## Performance and operational scope

The overview does not load chart libraries or request time-series data. Statistics and collocation load on demand. API responses larger than 1,500 bytes can be compressed. The API caches up to two parsed dataset files, skips that cache for files above 64 MiB on disk, keys entries by modification time and size, and returns copies to isolate transformations. Parsed memory can exceed file size.

Import inspection runs in a worker thread. Registry updates use atomic replacement and an in-process lock. This is a **single-process local workspace**; multiple API processes need transactional shared storage. Authentication, authorization, durable job queues, quotas, and deployment observability remain requirements for a public multi-user service. See [deployment](deployment.md).

## Verification

```powershell
python -m ruff check backend
python -m pytest -q
npm.cmd --prefix frontend run lint
npm.cmd --prefix frontend run build
```

Browser regression tests use isolated API fixtures and run at desktop and mobile sizes:

```powershell
cd frontend
npx.cmd playwright install chromium
npm.cmd run test:e2e
```

To use an installed Edge browser on Windows, set `$env:PLAYWRIGHT_CHANNEL='msedge'`. For a live-data visual check with the API and Vite running, run `node frontend/scripts/review-browser.mjs` from the repository root. Screenshots and overflow/error findings are written to `frontend/test-results/review/` and excluded from Git.
