-- Portable equivalent of deployed migration 20260917062919_custom_auth_public_refresh.
-- The token is generated inside the target database and is never committed to Git.

insert into public.runtime_settings(key,value)
values ('public_refresh_token', encode(gen_random_bytes(24),'hex'))
on conflict (key) do nothing;

-- edge_function_base_url is intentionally not hardcoded. Bootstrap/runbook sets it to:
-- https://<project-ref>.supabase.co/functions/v1

create or replace function public.invoke_public_refresh()
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.invoke_edge_function('refresh-public-gold');
$$;
revoke all on function public.invoke_public_refresh() from public;
grant execute on function public.invoke_public_refresh() to service_role, postgres;
