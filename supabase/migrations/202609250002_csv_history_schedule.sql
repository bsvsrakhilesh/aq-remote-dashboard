begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- This small coordinator checks transfers every minute; queue_csv_history's
-- unique (device, filename, cutoff) permits only two scheduled snapshots/day.
-- Workers are invoked only when an actual CSV is ready, not on every tick.
create function public.tick_csv_history() returns void
language plpgsql security definer set search_path = '' as $$
declare token text; ready_count integer; i integer;
begin
  perform public.queue_csv_history();
  select count(*) into ready_count from public.csv_history_jobs h
    join public.download_requests d on d.id = h.download_request_id
    where h.status = 'waiting' and d.status = 'ready' and d.expires_at > now();
  if ready_count = 0 then return; end if;
  select decrypted_secret into token from vault.decrypted_secrets where name = 'csv_history_worker_secret';
  if token is null then raise exception 'CSV worker token is not configured'; end if;
  for i in 1..least(ready_count, 3) loop
    perform net.http_post(
      url := 'https://qnrfwfuyxuzqdcbgrwdd.supabase.co/functions/v1/process-csv-history',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-history-secret', token),
      body := '{}'::jsonb, timeout_milliseconds := 120000);
  end loop;
end;
$$;
revoke all on function public.tick_csv_history() from public, anon, authenticated;
grant execute on function public.tick_csv_history() to service_role;
select cron.schedule('csv-minute-history-coordinator', '* * * * *', 'select public.tick_csv_history();');
commit;
