# Fleet reliability

The Operations page shows 7- and 30-day fleet reliability for **completed IST days**. It does not modify either logger firmware or the twice-daily CSV collection schedule.

- **15-minute reporting** is the number of distinct fifteen-minute slots containing a cloud snapshot divided by the expected slots. This is a reporting-availability proxy, **not measured electrical uptime**. A logger that remains powered but loses its network can have low reporting availability.
- **1-minute CSV coverage** is the count of imported minute records divided by expected minutes. It can temporarily fall while a scheduled SD-card transfer is pending, and rise again after a successful catch-up. The calculation respects a logger's configured cloud minute-history retention.
- **Failed CSV jobs** counts terminal failures created in the selected period. Completed jobs are shown separately; pending jobs are excluded. A later successful job does not erase an earlier failure.

Expected slots start no earlier than device registration. No values are interpolated. The fleet percentage is weighted by eligible slots, not an unweighted average of device percentages. Newly registered devices without a completed day display no eligible history. As with any time-based report, an incorrect logger clock can shift readings into the wrong slots.

The database function is read-only, uses invoker rights and row-level security, and is callable only by authenticated researchers. Tests: `npm.cmd test`, `npm.cmd run smoke:research`, and the rollback-only `supabase/tests/fleet_reliability.sql`.
