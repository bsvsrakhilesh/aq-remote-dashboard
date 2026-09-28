begin;

-- Supabase projects may grant EXECUTE to anon through default function grants.
-- The Operations workspace is for authenticated researchers only.
revoke execute on function public.fleet_reliability(integer) from anon;

commit;
