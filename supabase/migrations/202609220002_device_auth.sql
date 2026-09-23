create function public.verify_device_secret(p_device_code text,p_secret text)
returns table(id uuid,device_code text) language sql security definer set search_path='' as $$
  select d.id,d.device_code
  from public.devices d
  where d.device_code=p_device_code
    and d.secret_hash=extensions.crypt(p_secret,d.secret_hash)
  limit 1;
$$;
revoke all on function public.verify_device_secret(text,text) from public,anon,authenticated;
grant execute on function public.verify_device_secret(text,text) to service_role;
