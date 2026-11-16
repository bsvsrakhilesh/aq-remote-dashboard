"""Plot the paired one-minute PM2.5 measurements and local relative humidity."""

from pathlib import Path

import matplotlib.dates as mdates
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd


HERE = Path(__file__).resolve().parent
frame = pd.read_csv(HERE / "pm25_minute_averages.csv", parse_dates=["local_time_IST"]).set_index("local_time_IST")
colors = {"logger_1": "#2374ab", "logger_6": "#d95f02", "logger_7": "#7b4ab8"}
smooth = frame.rolling(5, center=True, min_periods=1).mean()
fig, axes = plt.subplots(3, 1, figsize=(12, 9), sharex=True, layout="constrained")
axes[0].plot(smooth.index, smooth.grimm_pm25_mean, color="black", label="GRIMM 11-D", lw=2)
for logger, color in colors.items():
    axes[0].plot(smooth.index, smooth[f"{logger}_pm25_mean"], color=color, label=logger.replace("_", " ").title(), lw=1.5)
axes[0].set(ylabel="PM2.5 (µg/m³)", title="13 Nov 20:30–14 Nov 13:30 2026 (IST); 5-minute visual smoothing")
axes[0].legend(ncol=4, frameon=False)
for logger, color in colors.items():
    axes[1].plot(smooth.index, smooth[f"{logger}_pm25_mean"] - smooth.grimm_pm25_mean, color=color, lw=1.5)
axes[1].axhline(0, lw=0.8, color="black")
axes[1].set(ylabel="Logger − GRIMM (µg/m³)")
for logger, color in colors.items():
    axes[2].plot(smooth.index, smooth[f"{logger}_rh_mean"], color=color, lw=1.5)
axes[2].axhline(80, lw=0.8, ls="--", color="gray")
axes[2].set(ylabel="Logged RH (%)", xlabel="Local time (IST)")
axes[2].xaxis.set_major_locator(mdates.HourLocator(interval=2))
axes[2].xaxis.set_major_formatter(mdates.DateFormatter("%d %b\n%H:%M"))
fig.savefig(HERE / "pm25_collocation.png", dpi=170)
print(HERE / "pm25_collocation.png")
