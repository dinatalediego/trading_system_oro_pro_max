-- Portable equivalent of deployed migration 20260917062714_runtime_automation_and_dashboard.
-- Project-specific Edge Function URLs are deliberately externalized into runtime_settings.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.runtime_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.runtime_settings enable row level security;

create index if not exists ix_paper_orders_status_requested on public.paper_orders(status, requested_at desc);
create index if not exists ix_execution_outcomes_closed_at on public.execution_outcomes(closed_at desc);

create or replace function public.dashboard_snapshot(
  p_symbol text default 'XAUUSD_PROXY_GC',
  p_limit integer default 180
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with bars as (
  select ts, close, rsi, wt1, wt2, squeeze, rule_signal
  from public.gold_market_features
  where symbol = p_symbol
  order by ts desc
  limit greatest(1, least(p_limit, 500))
), ordered_bars as (
  select * from bars order by ts asc
), latest_pred as (
  select action, probability, expected_return, risk_state, model_version, created_at
  from public.model_predictions
  where symbol = p_symbol
  order by created_at desc
  limit 1
), paper_stats as (
  select
    count(*)::int as closed_trades,
    coalesce(avg((eo.net_pnl > 0)::int), 0)::numeric as win_rate,
    coalesce(sum(eo.net_pnl), 0)::numeric as net_pnl,
    coalesce(avg(eo.net_pnl), 0)::numeric as avg_net_pnl
  from public.execution_outcomes eo
  join public.paper_orders po on po.id = eo.paper_order_id
  where po.symbol = p_symbol
), copy_stats as (
  select
    count(*)::int as trades,
    coalesce(avg((realized_pnl > 0)::int), 0)::numeric as win_rate,
    coalesce(sum(realized_pnl), 0)::numeric as pnl,
    coalesce(avg(extract(epoch from (close_time-open_time))/60.0), 0)::numeric as avg_duration_min
  from public.broker_trades
  where source like 'sonic_copy_history%'
), latest_ingestion as (
  select provider, dataset, status, rows_written, watermark, finished_at
  from public.data_ingestion_runs
  order by started_at desc
  limit 1
)
select jsonb_build_object(
  'mode','paper',
  'symbol',p_symbol,
  'bars',coalesce((select jsonb_agg(jsonb_build_object(
    'ts',ts,'close',close,'rsi',rsi,'wt1',wt1,'wt2',wt2,'squeeze',squeeze,'signal',rule_signal
  ) order by ts) from ordered_bars),'[]'::jsonb),
  'prediction',coalesce((select to_jsonb(latest_pred) from latest_pred),'{}'::jsonb),
  'paper',coalesce((select to_jsonb(paper_stats) from paper_stats),'{}'::jsonb),
  'copyBenchmark',coalesce((select to_jsonb(copy_stats) from copy_stats),'{}'::jsonb),
  'ingestion',coalesce((select to_jsonb(latest_ingestion) from latest_ingestion),'{}'::jsonb)
);
$$;

revoke all on function public.dashboard_snapshot(text, integer) from public;
grant execute on function public.dashboard_snapshot(text, integer) to anon, authenticated, service_role;

-- Generic Edge Function invoker. A fresh project only needs edge_function_base_url + public_refresh_token configured.
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
as $$
  select public.invoke_edge_function('refresh-public-gold');
$$;
revoke all on function public.invoke_public_refresh() from public;
grant execute on function public.invoke_public_refresh() to service_role, postgres;

-- Scheduling is installed only when pg_cron exists. Re-running is idempotent by job name.
do $$
begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    if not exists (select 1 from cron.job where jobname='gold-public-refresh') then
      perform cron.schedule('gold-public-refresh','*/5 * * * *','select public.invoke_public_refresh();');
    end if;
  end if;
end $$;
