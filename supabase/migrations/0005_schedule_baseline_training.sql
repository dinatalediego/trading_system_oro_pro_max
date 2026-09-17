create or replace function public.invoke_baseline_training()
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
  select value into v_url from public.runtime_settings where key='baseline_train_url';
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
revoke all on function public.invoke_baseline_training() from public;
grant execute on function public.invoke_baseline_training() to service_role, postgres;

do $$
begin
  if not exists (select 1 from cron.job where jobname='gold-baseline-train') then
    perform cron.schedule('gold-baseline-train','17 1 * * *','select public.invoke_baseline_training();');
  end if;
end $$;
