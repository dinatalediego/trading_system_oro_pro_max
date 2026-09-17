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
  select count(*)::int as closed_trades,
         coalesce(avg((eo.net_pnl > 0)::int), 0)::numeric as win_rate,
         coalesce(sum(eo.net_pnl), 0)::numeric as net_pnl,
         coalesce(avg(eo.net_pnl), 0)::numeric as avg_net_pnl
  from public.execution_outcomes eo
  join public.paper_orders po on po.id = eo.paper_order_id
  where po.symbol = p_symbol
), benchmark as (
  select metrics, protocol, ended_at
  from public.strategy_experiments
  where experiment_key='sonic_observed_baseline_2025_09_to_2026_09'
  limit 1
), latest_ingestion as (
  select provider, dataset, status, rows_written, watermark, finished_at, details
  from public.data_ingestion_runs
  order by started_at desc
  limit 1
), model_state as (
  select model_name, model_version, status, metrics, created_at
  from public.model_runs
  order by created_at desc
  limit 1
)
select jsonb_build_object(
  'mode','paper',
  'instrumentClass','proxy',
  'symbol',p_symbol,
  'canonicalExecutionSymbol','XAUUSD',
  'bars',coalesce((select jsonb_agg(jsonb_build_object('ts',ts,'close',close,'rsi',rsi,'wt1',wt1,'wt2',wt2,'squeeze',squeeze,'signal',rule_signal) order by ts) from ordered_bars),'[]'::jsonb),
  'prediction',coalesce((select to_jsonb(latest_pred) from latest_pred),'{}'::jsonb),
  'paper',coalesce((select to_jsonb(paper_stats) from paper_stats),'{}'::jsonb),
  'benchmark',coalesce((select jsonb_build_object('metrics',metrics,'protocol',protocol,'ended_at',ended_at) from benchmark),'{}'::jsonb),
  'ingestion',coalesce((select to_jsonb(latest_ingestion) from latest_ingestion),'{}'::jsonb),
  'modelState',coalesce((select to_jsonb(model_state) from model_state),'{}'::jsonb),
  'limitations',jsonb_build_array('GC=F is a public proxy, not the broker XAUUSD execution feed','proxy paper PnL does not yet include broker-specific spread/slippage','live trading is disabled')
);
$$;
revoke all on function public.dashboard_snapshot(text, integer) from public;
grant execute on function public.dashboard_snapshot(text, integer) to anon, authenticated, service_role;
