create or replace function public.invoke_edge_function(p_path text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_base text;
  v_token text;
  v_request_id bigint;
begin
  select value into v_base from public.runtime_settings where key='edge_function_base_url';
  select value into v_token from public.runtime_settings where key='public_refresh_token';
  if v_base is null or v_token is null or p_path is null then
    return null;
  end if;
  select net.http_post(
    url := rtrim(v_base,'/') || '/' || ltrim(p_path,'/'),
    headers := jsonb_build_object('x-refresh-token',v_token,'Content-Type','application/json'),
    body := '{}'::jsonb
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function public.invoke_edge_function(text) from public;
grant execute on function public.invoke_edge_function(text) to service_role, postgres;

create or replace function public.invoke_public_refresh()
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$ select public.invoke_edge_function('refresh-public-gold'); $$;
revoke all on function public.invoke_public_refresh() from public;
grant execute on function public.invoke_public_refresh() to service_role, postgres;

create or replace function public.invoke_baseline_training()
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$ select public.invoke_edge_function('train-baseline'); $$;
revoke all on function public.invoke_baseline_training() from public;
grant execute on function public.invoke_baseline_training() to service_role, postgres;
