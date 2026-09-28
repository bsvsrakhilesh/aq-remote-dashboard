begin;

-- Completed IST days only: the current partial day cannot depress availability.
-- Snapshot slots are a reporting proxy, not a historical power-state record.
create function public.fleet_reliability(p_days integer)
returns table (
  device_id uuid,
  expected_snapshots bigint,
  reported_snapshots bigint,
  expected_minutes bigint,
  recorded_minutes bigint,
  failed_syncs bigint,
  completed_syncs bigint,
  latest_failure_at timestamptz,
  retention_days integer
)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_days is null or p_days not in (7, 30) then
    raise exception 'Choose a 7- or 30-day period';
  end if;

  return query
  with bounds as (
    select (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') as until_at
  )
  select d.id,
    greatest(0::bigint, floor(extract(epoch from b.until_at) / 300)::bigint -
      floor(extract(epoch from greatest(d.created_at, b.until_at - make_interval(days => p_days))) / 300)::bigint),
    coalesce(s.reported, 0),
    greatest(0::bigint, floor(extract(epoch from b.until_at) / 60)::bigint -
      floor(extract(epoch from greatest(d.created_at, b.until_at - make_interval(days => p_days),
        coalesce(now() - make_interval(days => r.days), b.until_at - make_interval(days => p_days)))) / 60)::bigint),
    coalesce(m.recorded, 0),
    coalesce(j.failed, 0),
    coalesce(j.completed, 0),
    j.latest_failure,
    r.days
  from public.devices d cross join bounds b
  left join public.history_retention r on r.device_id = d.id
  left join lateral (
    select count(distinct floor(extract(epoch from t."timestamp") / 300)::bigint) as reported
    from public.telemetry_5min t
    where t.device_id = d.id
      and t."timestamp" >= greatest(d.created_at, b.until_at - make_interval(days => p_days))
      and t."timestamp" < b.until_at
  ) s on true
  left join lateral (
    select count(*) as recorded from public.telemetry_1min t
    where t.device_id = d.id
      and t."timestamp" >= greatest(d.created_at, b.until_at - make_interval(days => p_days),
        coalesce(now() - make_interval(days => r.days), b.until_at - make_interval(days => p_days)))
      and t."timestamp" < b.until_at
  ) m on true
  left join lateral (
    select count(*) filter (where h.status = 'failed') as failed,
      count(*) filter (where h.status = 'completed') as completed,
      max(coalesce(h.completed_at, h.created_at)) filter (where h.status = 'failed') as latest_failure
    from public.csv_history_jobs h
    where h.device_id = d.id
      and h.created_at >= greatest(d.created_at, b.until_at - make_interval(days => p_days))
      and h.created_at < b.until_at
  ) j on true
  order by d.device_code;
end $$;

revoke all on function public.fleet_reliability(integer) from public;
grant execute on function public.fleet_reliability(integer) to authenticated;
comment on function public.fleet_reliability(integer) is
  'Fleet reporting-slot and imported-minute coverage for the last 7 or 30 completed IST days. Starts no earlier than registration; minute denominators respect configured retention. Reporting slots are not proof of electrical uptime.';

commit;
