insert into public.runtime_settings(key,value)
values ('public_refresh_token', encode(gen_random_bytes(24),'hex'))
on conflict (key) do nothing;

-- Runtime URLs are intentionally not hardcoded. After deploying Edge Functions,
-- configure `public_refresh_url` and `baseline_train_url` for the destination project.

create or replace function public.invoke_public_refresh()
returns bigint
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_url text;
  v_token text;
  v_request_id bigint;
begin
  select value into v_url from public.runtime_settings where key='public_refresh_url';
  select value into v_token from public.runtime_settings where key='public_refresh_token';
  if v_url is null or v_token is null then return null; end if;
  select net.http_post(
    url := v_url,
    headers := jsonb_build_object('x-refresh-token',v_token,'Content-Type','application/json'),
    body := '{}'::jsonb
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function public.invoke_public_refresh() from public;
grant execute on function public.invoke_public_refresh() to service_role, postgres;
