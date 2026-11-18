# Collocation methodology

Axiom supports two comparison authorities:

- **Ensemble:** every target sensor is compared with a leave-one-out median of its peers. A bin is eligible only when the configured minimum number of peers is valid.
- **External reference:** one uploaded member is designated as the reference. Reference results support accuracy claims only when that instrument is traceable, fit for purpose, and operated within its calibration range.

## Preprocessing and pairing

Each source is parsed independently from the user-confirmed timestamp and measurement columns. Safe unit conversions are applied before aggregation. A bin is retained only when its raw-observation coverage reaches the configured threshold. Suggested clock shifts are metadata and require explicit approval; source timestamps are never changed.

For sensor value `X(t)` and benchmark value `R(t)`:

```text
difference(t) = X(t) - R(t)
bias = mean(difference)
MAE = mean(abs(difference))
RMSE = sqrt(mean(difference²))
```

Positive bias means the sensor reads higher than its benchmark. In ensemble mode, this is **relative ensemble bias**, not absolute bias.

## Relative metrics

Relative bias and NRMSE are reported only for a ratio-scale parameter with a meaningful zero, no more than 1% negative benchmark values, and a benchmark mean materially above zero:

```text
relative bias (%) = 100 × mean(X - R) / mean(R)
NRMSE (%) = 100 × RMSE / mean(R)
```

They are marked not applicable for interval scales such as Celsius temperature, logarithmic scales, custom non-ratio measurements, negative benchmarks, and near-zero benchmarks. Absolute-unit bias, MAE, and RMSE remain available. An optional absolute-RMSE gate can be configured for those parameters.

## Uncertainty and agreement

Bias and Bland–Altman agreement-limit confidence intervals use 500 circular moving-block bootstrap replicates. The block length increases with residual lag-one autocorrelation and is reported for each sensor. Intervals are withheld below 20 paired observations.

```text
lower agreement limit = bias - 1.96 × SD(difference)
upper agreement limit = bias + 1.96 × SD(difference)
```

Bias is also reported independently in low, middle, and high benchmark tertiles to reveal concentration- or range-dependent response.

## Readiness and correction

Readiness requires the configured minimum duration and number of paired bins before performance gates are evaluated. A correction profile is not proposed for insufficient evidence.

Identity, offset-only, and robust-linear corrections are evaluated with contiguous time-block folds. Random splitting is not used. The simplest candidate within one standard error of the best validation RMSE is selected. The interface reports validation improvement against the identity model; training-fit improvement is not used as the approval claim.

## Interpretation boundaries

An ensemble can quantify agreement, precision, relative bias, reliability, and harmonization. It cannot establish absolute accuracy or detect common-mode drift. An external reference addresses those limitations only to the extent that its own calibration, uncertainty, temporal response, and measurement range are suitable.

Method references include the [NIST definition of bias](https://www.itl.nist.gov/div898/handbook/mpc/section1/mpc113.htm), [NIST Bland–Altman guidance](https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/blandalt.htm), and [EPA Air Sensor Guidebook](https://nepis.epa.gov/Exe/ZyPURL.cgi?Dockey=P100JDZI.TXT).
