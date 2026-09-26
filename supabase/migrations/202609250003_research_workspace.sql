begin;

-- Authenticated researchers share operational records. Public viewers can only
-- read measurements through the existing public-read-only setting.
create table public.deployment_notes (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  kind text not null check (kind in ('deployment','maintenance','cleaning','observation')),
  location text not null default '' check (length(location) <= 200),
  body text not null check (length(body) between 1 and 4000),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id)
);
create index deployment_notes_device on public.deployment_notes(device_id, occurred_at desc);
alter table public.deployment_notes enable row level security;
revoke all on public.deployment_notes from anon, authenticated;
grant select,insert on public.deployment_notes to authenticated;
create policy "researchers read notes" on public.deployment_notes for select to authenticated using (true);
create policy "researchers add notes" on public.deployment_notes for insert to authenticated with check (created_by=auth.uid());

create table public.saved_analysis_views (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  config jsonb not null check (jsonb_typeof(config)='object' and octet_length(config::text)<8000),
  created_at timestamptz not null default now(),
  unique(owner_id,name)
);
alter table public.saved_analysis_views enable row level security;
revoke all on public.saved_analysis_views from anon, authenticated;
grant select,insert,update,delete on public.saved_analysis_views to authenticated;
create policy "owners manage saved views" on public.saved_analysis_views for all to authenticated
  using (owner_id=auth.uid()) with check (owner_id=auth.uid());

create function public.research_series(p_devices uuid[],p_from timestamptz,p_until timestamptz,p_source text)
returns table(device_id uuid, "timestamp" timestamptz, points bigint, pm1 double precision,
 pm25 double precision,pm10 double precision,temperature double precision,rh double precision,co2 double precision,
 valid_counts bigint[],min_values real[],max_values real[],sample_rows bigint,incomplete_points bigint)
language plpgsql stable security invoker set search_path='' as $$
begin
 if p_from is null or p_until is null or p_until<=p_from or p_until-p_from>interval '31 days'
   or coalesce(array_length(p_devices,1),0) not between 1 and 20 or p_source not in ('minute','snapshot') then
   raise exception 'Select 1-20 devices and a period of up to 31 days';
 end if;
 return query
 with readings as (
  select t.device_id,t.timestamp,t.pm1,t.pm25,t.pm10,t.temperature_c,t.rh,t.co2_ppm,
    t.sample_count::bigint as rows, (exists(select 1 from unnest(t.valid_counts) with ordinality v(n,i)
      where v.i<=case when d.co2_enabled then 6 else 5 end and v.n<t.sample_count)) as incomplete
  from public.telemetry_1min t join public.devices d on d.id=t.device_id
  where p_source='minute' and t.device_id=any(p_devices) and t.timestamp>=p_from and t.timestamp<p_until
  union all
  select t.device_id,t.timestamp,t.pm1,t.pm25,t.pm10,t.temperature_c,t.rh,t.co2_ppm,1::bigint,false
  from public.telemetry_5min t where p_source='snapshot' and t.device_id=any(p_devices)
    and t.timestamp>=p_from and t.timestamp<p_until
 )
 select r.device_id,(date_trunc('hour',r.timestamp at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
 count(*),avg(r.pm1)::double precision,avg(r.pm25)::double precision,avg(r.pm10)::double precision,
 avg(r.temperature_c)::double precision,avg(r.rh)::double precision,avg(r.co2_ppm)::double precision,
 array[count(r.pm1),count(r.pm25),count(r.pm10),count(r.temperature_c),count(r.rh),count(r.co2_ppm)],
 array[min(r.pm1),min(r.pm25),min(r.pm10),min(r.temperature_c),min(r.rh),min(r.co2_ppm)],
 array[max(r.pm1),max(r.pm25),max(r.pm10),max(r.temperature_c),max(r.rh),max(r.co2_ppm)],
 sum(r.rows)::bigint,count(*) filter(where r.incomplete)
 from readings r group by r.device_id,2 order by 2,1;
end $$;
revoke all on function public.research_series(uuid[],timestamptz,timestamptz,text) from public;
grant execute on function public.research_series(uuid[],timestamptz,timestamptz,text) to anon,authenticated;

create table public.alert_rules (
 id uuid primary key default gen_random_uuid(),device_id uuid not null references public.devices(id) on delete cascade,
 metric text not null check(metric in ('offline','pm1','pm25','pm10','temperature','rh','co2')),
 threshold real not null check(threshold between -80 and 1000000),
 direction text not null default 'above' check(direction in ('above','below')),
 duration_minutes integer not null default 15 check(duration_minutes between 5 and 1440),
 enabled boolean not null default true,created_at timestamptz not null default now(),
 created_by uuid not null default auth.uid() references auth.users(id),
 unique(device_id,metric,direction)
);
create table public.alert_events (
 id uuid primary key default gen_random_uuid(),rule_id uuid not null references public.alert_rules(id) on delete cascade,
 device_id uuid not null references public.devices(id) on delete cascade,
 metric text not null,message text not null,observed_value real,
 opened_at timestamptz not null default now(),resolved_at timestamptz,
 acknowledged_at timestamptz,acknowledged_by uuid references auth.users(id)
);
create unique index alert_one_open on public.alert_events(rule_id) where resolved_at is null;
create index alert_events_recent on public.alert_events(opened_at desc);
alter table public.alert_rules enable row level security;
alter table public.alert_events enable row level security;
revoke all on public.alert_rules, public.alert_events from anon,authenticated;
grant select,insert,update,delete on public.alert_rules to authenticated;
grant select on public.alert_events to authenticated;
create policy "researchers read rules" on public.alert_rules for select to authenticated using(true);
create policy "researchers insert rules" on public.alert_rules for insert to authenticated with check(created_by=auth.uid());
create policy "researchers update rules" on public.alert_rules for update to authenticated using(true) with check(true);
create policy "researchers delete rules" on public.alert_rules for delete to authenticated using(true);
create policy "researchers read events" on public.alert_events for select to authenticated using(true);

create function public.acknowledge_alert(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 update public.alert_events set acknowledged_at=now(),acknowledged_by=auth.uid() where id=p_id;
end $$;
revoke all on function public.acknowledge_alert(uuid) from public,anon;
grant execute on function public.acknowledge_alert(uuid) to authenticated;

create function public.evaluate_research_alerts() returns void
language plpgsql security definer set search_path='' as $$
declare rule record; triggered boolean; n integer; total integer; hits integer; oldest timestamptz; newest timestamptz; value real; longest_gap interval;
begin
 if not pg_try_advisory_xact_lock(92625003) then return; end if;
 for rule in select r.*,d.device_code,d.last_seen,d.co2_enabled from public.alert_rules r
   join public.devices d on d.id=r.device_id loop
  triggered:=false; value:=null;
  if rule.enabled then
   if rule.metric='offline' then
    value:=extract(epoch from now()-coalesce(rule.last_seen,rule.created_at))/60;
    triggered:=value>=rule.duration_minutes;
   elsif rule.metric<>'co2' or rule.co2_enabled then
    -- Evaluate existing five-minute snapshots, not delayed twice-daily CSVs.
    -- Require full-window coverage and a fresh final sample; missing data never
    -- implies a threshold breach. The offline rule handles connectivity loss.
    select count(v),count(*),count(*) filter(where case when rule.direction='above' then v>rule.threshold else v<rule.threshold end),
      min(timestamp),max(timestamp),(array_agg(v order by timestamp desc))[1],max(gap)
    into n,total,hits,oldest,newest,value,longest_gap from (
     select t.timestamp,t.timestamp-lag(t.timestamp) over(order by t.timestamp) gap,case rule.metric when 'pm1' then t.pm1 when 'pm25' then t.pm25
       when 'pm10' then t.pm10 when 'temperature' then t.temperature_c when 'rh' then t.rh when 'co2' then t.co2_ppm end v
     from public.telemetry_5min t where t.device_id=rule.device_id
       and t.timestamp>=now()-make_interval(mins=>rule.duration_minutes+5) and t.timestamp<=now()
    ) values_in_window;
    if n=total and n>=greatest(2,ceil(rule.duration_minutes/5.0)::integer)
      and oldest<=now()-make_interval(mins=>rule.duration_minutes)
      and newest>=now()-interval '7 minutes' and longest_gap<=interval '7 minutes' then
      triggered:=hits=n;
    else
      -- Unknown coverage neither opens nor resolves an existing threshold alert.
      triggered:=null;
    end if;
   end if;
  end if;
  if triggered then
   insert into public.alert_events(rule_id,device_id,metric,observed_value,message)
   values(rule.id,rule.device_id,rule.metric,value,
    case when rule.metric='offline' then rule.device_code||' has not reported for '||rule.duration_minutes||' minutes'
    else rule.device_code||': '||rule.metric||' remained '||rule.direction||' '||rule.threshold||' for '||rule.duration_minutes||' minutes' end)
   on conflict(rule_id) where resolved_at is null do update set observed_value=excluded.observed_value;
  elsif triggered=false then
   update public.alert_events set resolved_at=now() where rule_id=rule.id and resolved_at is null;
  end if;
 end loop;
end $$;
revoke all on function public.evaluate_research_alerts() from public,anon,authenticated;
select cron.schedule('research-alerts','* * * * *','select public.evaluate_research_alerts();');
grant all on public.deployment_notes,public.saved_analysis_views,public.alert_rules,public.alert_events to service_role;
commit;
