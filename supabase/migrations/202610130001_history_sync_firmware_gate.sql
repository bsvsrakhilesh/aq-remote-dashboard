begin;

-- A user-triggered history refresh uses the same incremental worker as the
-- automatic coordinator. Report the firmware requirement immediately instead
-- of leaving a request queued until the logger is reflashed.
create or replace function public.request_history_sync(p_device uuid) returns text
language plpgsql security definer set search_path='' as $$
declare d public.devices; s public.csv_history_settings; cutoff timestamptz;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_device::text,92625004));
 select * into d from public.devices where id=p_device;
 if not found then raise exception 'Logger not found'; end if;
 if not public.supports_incremental_csv(d.firmware_version) then
   raise exception 'Flash logger firmware 1.2.5 or newer before requesting CSV history';
 end if;
 if d.last_seen is null or d.last_seen<now()-interval '40 minutes' then raise exception 'Logger is offline. Try again when it reports.'; end if;
 if d.current_filename is null or d.current_filename !~ '^[a-zA-Z0-9_-]+_[0-9]{4}-[0-9]{2}-[0-9]{2}_to_[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv$' then raise exception 'No verified weekly CSV is available'; end if;
 insert into public.csv_history_settings(device_id) values(p_device) on conflict do nothing;
 select * into s from public.csv_history_settings where device_id=p_device for update;
 if not s.enabled then raise exception 'Resume automatic sync before requesting a refresh'; end if;
 if s.last_manual_at>now()-interval '15 minutes' then raise exception 'Please allow 15 minutes between manual requests'; end if;
 if exists(select 1 from public.csv_history_jobs where device_id=p_device and status in ('queued','waiting','processing'))
   or exists(select 1 from public.download_requests where device_id=p_device and status in ('queued','device_acknowledged','uploading')) then
   raise exception 'A transfer is already pending for this logger';
 end if;
 cutoff:=(date_trunc('day',now() at time zone 'Asia/Kolkata')+case when extract(hour from now() at time zone 'Asia/Kolkata')>=12 then interval '12 hours' else interval '0 hours' end) at time zone 'Asia/Kolkata';
 if (substring(d.current_filename from '_([0-9]{4}-[0-9]{2}-[0-9]{2})_to_')::date::timestamp at time zone 'Asia/Kolkata')>=cutoff then raise exception 'The new weekly file has no completed scheduled window yet'; end if;
 insert into public.csv_history_jobs(device_id,filename,hour_end) values(p_device,d.current_filename,cutoff)
 on conflict(device_id,filename,hour_end) do update set status='queued',attempts=0,retry_at=now(),error_message=null,
   download_request_id=null,completed_at=null,lease_token=null,lease_until=null;
 update public.csv_history_settings set last_manual_at=now() where device_id=p_device;
 return 'CSV refresh queued for the latest midnight/noon cutoff. Your SD files are unchanged.';
end $$;

commit;
