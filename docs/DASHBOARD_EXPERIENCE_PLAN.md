# Dashboard experience plan

15 November 2026 · Scope: dashboard and cloud software only. Logger firmware stays unchanged.

## Product direction

The dashboard should answer three questions in order: **Which loggers need attention? Is the data trustworthy and fresh? What changed over time?** A browser can update its view whenever cloud data changes, but it cannot create readings between each logger's existing transmissions. Every screen must distinguish the time of the last cloud check from the time of the last device contact and measurement.

The workspace already has multi-device comparison, a heatmap, reports, data quality checks, alert rules, deployment notes, CSV history, saved analysis views, and responsive light/dark themes. Rebuilding those features as generic widgets would add navigation and maintenance cost without improving the workflow.

| Priority          | Update                                                                                                                                    | Where it runs                              | Acceptance criterion                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Done in this pass | Fleet attention queue for offline or delayed contact, SD/card status, 0 B active CSV, sensor status, delayed measurements, and weak Wi-Fi | Frontend                                   | An online logger with a 0 B CSV appears in “Needs attention,” with the reason visible before opening it.                                                        |
| Done in this pass | Last successful cloud check shown separately from device contact; accurate SD and active CSV checks on device detail                      | Frontend                                   | The UI never calls an SD card “recording normally” solely because the card reports healthy.                                                                     |
| Done in this pass | Mobile access to the alert inbox and priority sorting for the fleet                                                                       | Frontend                                   | The inbox remains available at 320 px, and attention items appear first.                                                                                        |
| Next              | Favorite loggers and a configurable overview with a small set of movable panels                                                           | Frontend, browser storage first            | A researcher can pin their loggers and choose which existing metrics appear first, without changing the shared fleet definition.                                |
| Next              | Shareable view state in URLs for filters, selected devices, time range, and metric                                                        | Frontend                                   | Opening a copied URL recreates the same view; invalid parameters fall back safely.                                                                              |
| Next              | Chart context: alert and deployment-note annotations, visible missing-data intervals, and a jump from a fleet issue to the relevant chart | Frontend using existing cloud tables       | A chart explains a gap or incident in place, with the source and timestamp shown.                                                                               |
| Later             | Team-wide saved overview layouts with roles and change history                                                                            | Dashboard cloud/database                   | Shared layouts are scoped to authorized users, restorable, and do not expose private device data.                                                               |
| Later             | Push updates with a polling fallback                                                                                                      | Dashboard cloud configuration and frontend | New cloud records appear promptly in an open tab while connection loss and reconnect are visible. Push does not imply more frequent logger readings.            |
| Later             | Map view with coordinates maintained in dashboard metadata                                                                                | Dashboard cloud/database                   | A missing location is explicit; no location is inferred from a device name.                                                                                     |
| Optional          | Evidence-linked AI research brief                                                                                                         | Dashboard backend and frontend             | Each statement cites the exact logger, metric, time window, and source record; unknown data remains unknown. API keys stay on the server and usage is budgeted. |

## Design rules

- Prefer operational questions and drill-downs over a grid of unrelated numbers. Put exceptions first, then comparison, then detail.
- Show device contact, measurement, file catalog, and browser check as separate clocks. A green connection badge is not proof of a usable CSV.
- Use colour with text and icons; keep keyboard, narrow-screen, and dark-theme behavior equivalent.
- Reuse the existing `useDevices` snapshot and batch queries. Avoid one network request per widget or aggressive polling that duplicates the logger's fifteen-minute cadence.
- Keep thresholds explicit and user-defined where they are interpretive. Do not present research measurements as a medical or regulatory determination.
- Keep demo data visibly marked, never synthesize production readings, and show gaps rather than interpolating them.

## References

- [TagoIO Dashboard Overview](https://docs.tago.io/docs/tagoio/dashboards/): reusable device-driven layouts and real-time presentation.
- [TagoIO Device List Widget](https://docs.tago.io/docs/tagoio/widgets/tables/device-list-widget): configurable device lists and filtering.
- [Grafana dashboard best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/): question-led layouts, clear drill-downs, consistent colour, and refresh rates matched to data cadence.
