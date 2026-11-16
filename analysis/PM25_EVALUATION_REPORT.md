# PM2.5 collocation evaluation: GRIMM 11-D and loggers 1, 6, 7

**Measurement period:** 13 November 2026, 20:30:00 to 14 November 2026, 13:30:00 IST (17 hours; end excluded).  
**Prepared:** 15 November 2026.  
**Purpose:** Quantify each logger's difference from the co-located GRIMM and assess whether its difference changes over this period.

## Executive findings

All three loggers reported higher PM2.5 than the GRIMM throughout the 1,020 paired minutes. Logger 1 had the smallest difference. Loggers 1 and 7 closely tracked the GRIMM's *shape*, but their raw concentrations were substantially high. Logger 6 had both the largest discrepancy and a substantially poorer pattern match. The 17-hour data permit a short-term comparison; they do not establish each sensor's long-term aging drift or absolute accuracy against gravimetric mass.

| Device | Mean PM2.5 (µg/m³) | Mean logger − GRIMM (µg/m³) | Bias / GRIMM mean | RMSE (µg/m³) | Correlation with GRIMM |
|---|---:|---:|---:|---:|---:|
| GRIMM 11-D | 116.44 | — | — | — | — |
| Logger 1 | 155.97 | **+39.53** | **+33.95%** | 40.11 | 0.9953 |
| Logger 6 | 384.45 | **+268.01** | **+230.17%** | 273.66 | 0.8096 |
| Logger 7 | 209.73 | **+93.29** | **+80.12%** | 94.78 | 0.9980 |

The chart is [pm25_collocation.png](pm25_collocation.png). The exact paired minute values are in [pm25_minute_averages.csv](pm25_minute_averages.csv); machine-readable results are in [pm25_results.json](pm25_results.json).

## Inputs, field selection, and quality control

The user confirmed the GRIMM and all three loggers were co-located for the requested period. The workbook `13thnov_grimm.xlsx` identifies the GRIMM as model **11-D**, serial **11D21067**. Its standard `Mass values` → `PM2.5 [ug/m3]` column was used, rather than its separate `pm2.5-IAQ` output. The logger CSVs supplied for 1, 6, and 7 were compared using `MC2.5`. The project's device documentation identifies SPS30 particle sensors; logger 7's CSV does not independently identify its sensor model, so the SPS30 datasheet comparison for it is conditional on that inventory being correct.

1. Parse GRIMM timestamps as month/day/year and logger timestamps as day-month-year. Treat both as IST, as supplied in the measurement context. Restrict to the half-open interval above.
2. Join GRIMM mass rows to `Log values` by their identical timestamps. The requested window contains **10,200 GRIMM rows**, all with `Err = 0`, valid nonnegative PM2.5, and no duplicate timestamps. Ten nonzero GRIMM error-status rows occur before the requested window and were excluded by the time filter.
3. Logger 1 has **30,575**, logger 6 **30,592**, and logger 7 **30,502** valid raw rows in the window. Each has no duplicate timestamps or invalid PM2.5 values in the window. Logger 7 has 25 unparsable timestamps elsewhere in its larger file; none enters the comparison.
4. Form arithmetic one-minute means, requiring at least 8 GRIMM values and 24 logger values per minute. All **1,020 minutes** pass for each pair: the GRIMM contributes 10 values per minute, and each logger contributes 29–30. No data were interpolated and no post hoc outliers were removed.
5. Repeating the bias calculation in five-minute bins changes the reported means by less than 0.01 µg/m³. Shifting a logger series by ±1 minute changes its mean bias by at most approximately 0.2 µg/m³. This checks *sensitivity* to a small clock offset; it does not prove that all clocks were synchronized.

## Definitions and calculations

For paired minute *i*, let `Gᵢ` be GRIMM PM2.5 and `Lᵢ` be logger PM2.5, both in µg/m³. The signed difference is `dᵢ = Lᵢ − Gᵢ`. Mean bias is `mean(dᵢ)`; relative bias is `100 × mean(dᵢ) / mean(Gᵢ)`; mean absolute error is `mean(|dᵢ|)`; and RMSE is `sqrt(mean(dᵢ²))`. All 1,020 differences are positive for every logger, so mean absolute error equals mean bias in this dataset. Correlation describes pattern similarity, **not** concentration accuracy.

| Logger | Median difference | SD of minute differences | Central 95% of observed minute differences | Sensor-on-GRIMM fitted slope |
|---|---:|---:|---:|---:|
| 1 | +40.88 | 6.84 | +27.06 to +48.94 | 1.383 |
| 6 | +279.31 | 55.33 | +136.49 to +345.42 | 3.268 |
| 7 | +99.46 | 16.77 | +53.51 to +113.02 | 1.986 |

These ranges describe variation *within this recording*. They are neither confidence intervals for a future setting nor total measurement uncertainty. The fitted slopes show that a constant offset is not a complete calibration model for this period, especially for logger 6.

## Short-term change versus sensor drift

The raw difference between the first and last two-hour averages is a descriptive check:

| Logger | First two-hour mean difference | Last two-hour mean difference | Change |
|---|---:|---:|---:|
| 1 | +28.83 | +31.51 | +2.68 µg/m³ |
| 6 | +235.07 | +167.06 | −68.01 µg/m³ |
| 7 | +60.95 | +78.22 | +17.27 µg/m³ |

The ambient concentration differs between the beginning and end. To reduce that confounding, a descriptive model was fitted separately for each logger:

`dᵢ = α + βₜ(tᵢ − 8.5 h) + βG(Gᵢ − mean(G)) + βRH(RHᵢ − mean(RH)) + εᵢ`.

Here `βₜ` is the change in the logger-minus-GRIMM difference **at fixed modeled GRIMM concentration and logged RH**. Its 95% interval uses an ordinary least-squares fit with Newey–West/Bartlett serial-correlation robust standard errors and a 60-minute lag. The model assumes linear concentration and RH terms; those assumptions and unmeasured aerosol properties limit causal interpretation.

| Logger | Adjusted time coefficient βₜ (µg/m³/h) | 95% interval | Assessment |
|---|---:|---:|---|
| 1 | **−0.304** | −0.434 to −0.175 | A small residual time change is detectable in this model; it cannot be assigned specifically to sensor aging. |
| 6 | **+0.792** | −4.622 to +6.206 | Time change cannot be separated from environmental and response changes in this run. |
| 7 | **+0.044** | −0.050 to +0.138 | Consistent with no detectable residual time change. |

Logger 6's logged RH averaged **76.70%**, versus **65.60%** and **66.06%** for loggers 1 and 7. Its RH exceeded 80% for **90 minutes**. Its recorded temperature averaged **22.57°C**, versus **26.26°C** and **24.35°C**. At GRIMM concentrations of 100–110 µg/m³, logger 6's mean difference was approximately **+249 µg/m³ early** versus **+182 µg/m³ late**; its RH averaged approximately **80% early** versus **67% late**. This is evidence of a changing response associated with the recorded conditions, not proof of a particular cause. The large baseline difference remains unexplained by this association alone.

The [EPA PM2.5 sensor testing protocol](https://nepis.epa.gov/Exe/ZyPURL.cgi?Dockey=P1012RCE.txt) distinguishes response to humidity and temperature from aging drift. Its controlled aging assessment repeats measurements at matched concentrations and conditions after at least 60 days. The present 17-hour exposure does not meet that design.

## Uncertainty assessment

| Component | Evidence or magnitude available here | Treatment and limitation |
|---|---|---|
| Sampling variation of the **mean difference** | 95% moving-block resampling intervals: logger 1 **+37.07 to +43.08**; logger 6 **+250.13 to +295.43**; logger 7 **+87.68 to +101.88 µg/m³** | 3,000 resamples of 60-minute contiguous blocks retain short-range serial dependence. These are descriptive statistical intervals under a stationarity approximation; they omit systematic instrument uncertainty. |
| SPS30 PM1/PM2.5 datasheet precision | ±(5 µg/m³ + 5% of reading) at 0–100 µg/m³; ±10% of reading at 100–1,000 µg/m³. At each logger's mean, approximately **±15.6**, **±38.4**, **±21.0 µg/m³** respectively. | This is principally a between-device precision limit at stated conditions, **not** a 95% accuracy interval against this GRIMM. It cannot be added to the observed bias as an independent random standard uncertainty. Logger 7's figure assumes it is an SPS30. |
| SPS30 temperature and long-term effects | Datasheet: typical additional ±0.5% of reading per °C from 25°C; long-term precision-limit change ±1.25% of reading per year above 100 µg/m³. Recommended best-performance RH range 20–80%. | The temperature term is *typical*, not a maximum; logged board/environment temperature need not equal SPS30 inlet temperature. Annual aging specification cannot be inferred by scaling one overnight run. Logger 6 spent 90 minutes above 80% recorded RH. |
| GRIMM 11-D PM2.5 mass uncertainty | Manufacturer states flow rate 1.2 L/min ±3% and particle-count reproducibility >95% at 500 nm. | Neither is a complete PM2.5 **mass** accuracy or expanded-uncertainty statement. This unit's calibration certificate, flow check, gravimetric check, and maintenance records were not supplied. No numerical GRIMM mass uncertainty can be defensibly assigned from the available materials. |
| Aerosol, humidity, and inlet differences | Optical particle-to-mass conversion depends on size, composition, shape, refractive index, and water uptake. Logged RH and temperature differ among co-located units. | The files do not measure these effects well enough to assign numerical bounds. No correction was imposed. |
| Timing and aggregation | Every requested minute is populated; ±1-minute sensitivity of mean bias is at most approximately 0.2 µg/m³. | Clock synchronization and exact inlet transit times were not independently certified. |

The [Sensirion SPS30 datasheet](https://sensirion.com/file/datasheet_sps30) gives the quoted sensor specifications. Sensirion's [specification statement](https://sensirion.com/media/documents/B7AAA101/61653FB8/Sensirion_Particulate_Matter_AppNotes_Specification_Statement.pdf) explains why its precision band differs from accuracy against another optical instrument. The [GRIMM 11-D manufacturer page](https://www.durag.com/en/product-filter-837.htm?productID=11-D) supplies the quoted reference-instrument specifications. A combined expanded uncertainty would require quantified standard-uncertainty components and their correlations; see [NIST uncertainty guidance](https://www.nist.gov/pml/nist-technical-note-1297/nist-tn-1297-5-combined-standard-uncertainty). The missing reference and environmental components prevent a defensible numerical total.

## Device-by-device conclusion and required next checks

- **Logger 1:** Strongly follows the GRIMM's temporal pattern but averages 39.5 µg/m³ high. It is the best of the three for this comparison, yet its raw concentrations are not accurate enough to call validated. Its small adjusted time effect should be checked in another controlled comparison.
- **Logger 6:** Averages 268.0 µg/m³ high and has substantial excursions absent from the GRIMM. A single offset or scale correction is not justified. Inspect its inlet/airflow, enclosure and RH/temperature placement, sensor installation and health, CSV channel mapping, and GRIMM co-location geometry before attempting calibration.
- **Logger 7:** Follows the GRIMM closely in shape but averages 93.3 µg/m³ high. Its raw readings are not validated absolute concentrations despite high correlation. Confirm its SPS30 model/serial and investigate the strong gain difference.

For a traceable absolute-error or long-term-drift claim, obtain the GRIMM's current calibration and maintenance records, check its flow and gravimetric control, confirm each sensor model and inlet arrangement, and repeat matched-concentration comparisons over a longer period under documented RH and temperature conditions. Do not apply these 17-hour fitted relationships outside the observed GRIMM range of approximately **71.5–135.8 µg/m³** without independent validation.

## Reproduction

From the project root, run `python analysis/pm25_drift_analysis.py`, then `python analysis/plot_pm25.py`. The scripts read the four source files from the user's `Downloads` folder and recreate the paired-minute CSV, results JSON, and chart. They make no changes to the source files.
