-- Closed-loop v2: prediction outcomes, paper risk audit, monitoring, retraining queue,
-- circuit breakers, orchestration health, and portable Edge Function schedules.
-- Live broker execution remains disabled.

create table if not exists public.prediction_outcomes (
  prediction_id bigint not null references public.model_predictions(id) on delete cascade,
  horizon_minutes integer not null check (horizon_minutes > 0),
  symbol text not null,
  feature_ts timestamptz not null,
  entry_price numeric not null,
  target_ts timestamptz not null,
  target_price numeric not null,
  realized_return numeric not null,
  signed_return numeric,
  label_up boolean not null,
  action_correct boolean,
  mfe_return numeric,
  mae_return numeric,
  provider text,
  metadata jsonb not null default '{}'::jsonb,
  evaluated_at timestamptz not null default now(),
  primary key (prediction_id, horizon_minutes)
);
create index if not exists ix_prediction_outcomes_symbol_eval
  on public.prediction_outcomes(symbol, evaluated_at desc);
create index if not exists ix_prediction_outcomes_horizon_eval
  on public.prediction_outcomes(horizon_minutes, evaluated_at desc);

create table if not exists public.paper_risk_decisions (
  id bigint generated always as identity primary key,
  prediction_id bigint references public.model_predictions(id) on delete set null,
  decision text not null check (decision in ('ALLOW','VETO','SKIP')),
  reason text not null,
  risk_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ix_paper_risk_decisions_prediction
  on public.paper_risk_decisions(prediction_id, created_at desc);

create table if not exists public.model_monitoring_windows (
  id bigint generated always as identity primary key,
  symbol text not null,
  model_version text not null,
  horizon_minutes integer not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  observations integer not null default 0,
  brier numeric,
  accuracy numeric,
  coverage numeric,
  trade_win_rate numeric,
  mean_signed_return numeric,
  calibration_bias numeric,
  drift_score numeric,
  data_age_minutes numeric,
  status text not null check(status in ('healthy','warn','fail','insufficient_data')),
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(symbol, model_version, horizon_minutes, window_start, window_end)
);
create index if not exists ix_monitoring_symbol_created
  on public.model_monitoring_windows(symbol, created_at desc);

create table if not exists public.retraining_requests (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  trigger_type text not null check(trigger_type in ('schedule','performance','drift','data_growth','manual')),
  symbol text not null default 'XAUUSD_PROXY_GC',
  model_name text not null default 'logistic_direction_15m_proxy',
  model_version_before text,
  model_version_after text,
  status text not null default 'pending' check(status in ('pending','running','succeeded','failed','skipped')),
  reason jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text
);
create index if not exists ix_retraining_status_requested
  on public.retraining_requests(status, requested_at);

create table if not exists public.closed_loop_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null check(run_type in ('ingest_predict','paper_execute','outcome_monitor','retrain','manual')),
  status text not null default 'running' check(status in ('running','success','failed','skipped')),
  symbol text,
  model_version text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  input_watermark timestamptz,
  output_watermark timestamptz,
  counts jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  error text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists ix_closed_loop_runs_type_started
  on public.closed_loop_runs(run_type, started_at desc);

create table if not exists public.circuit_breaker_events (
  id bigint generated always as identity primary key,
  breaker text not null,
  state text not null check(state in ('OPEN','CLOSED')),
  reason text not null,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ix_breaker_created
  on public.circuit_breaker_events(breaker, created_at desc);

alter table public.prediction_outcomes enable row level security;
alter table public.paper_risk_decisions enable row level security;
alter table public.model_monitoring_windows enable row level security;
alter table public.retraining_requests enable row level security;
alter table public.closed_loop_runs enable row level security;
alter table public.circuit_breaker_events enable row level security;

insert into public.runtime_settings(key,value) values
  ('execution_mode','paper'),
  ('paper_horizon_minutes','15'),
  ('paper_cost_rate','0.00015'),
  ('evaluation_horizons','5,15,30'),
  ('retrain_min_outcomes','80'),
  ('monitor_window_hours','24'),
  ('brier_warn_threshold','0.27'),
  ('drift_warn_threshold','0.18')
on conflict (key) do nothing;

-- Explicitly keep live execution disabled even if this migration is applied to an existing project.
update public.risk_limits
set config = jsonb_set(config, '{live_enabled}', 'false'::jsonb, true),
    updated_at = now()
where name='global';

create or replace function public.invoke_paper_executor()
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.invoke_edge_function('execute-paper');
$$;
revoke all on function public.invoke_paper_executor() from public;
grant execute on function public.invoke_paper_executor() to service_role, postgres;

create or replace function public.invoke_closed_loop_evaluator()
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.invoke_edge_function('evaluate-closed-loop');
$$;
revoke all on function public.invoke_closed_loop_evaluator() from public;
grant execute on function public.invoke_closed_loop_evaluator() to service_role, postgres;

create or replace function public.closed_loop_health(
  p_symbol text default 'XAUUSD_PROXY_GC'
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with latest_ingestion as (
  select status, watermark, finished_at, details
  from public.data_ingestion_runs
  order by started_at desc limit 1
), latest_prediction as (
  select id, action, probability, model_version, risk_state, created_at
  from public.model_predictions
  where symbol=p_symbol
  order by created_at desc limit 1
), latest_outcome as (
  select prediction_id, horizon_minutes, realized_return, signed_return, action_correct, evaluated_at
  from public.prediction_outcomes
  where symbol=p_symbol
  order by evaluated_at desc limit 1
), latest_monitor as (
  select model_version, observations, brier, accuracy, coverage, trade_win_rate,
         mean_signed_return, drift_score, data_age_minutes, status, created_at
  from public.model_monitoring_windows
  where symbol=p_symbol
  order by created_at desc limit 1
), retraining as (
  select count(*) filter(where status='pending')::int as pending,
         max(requested_at) as latest_request_at,
         max(finished_at) filter(where status='succeeded') as latest_success_at
  from public.retraining_requests
  where symbol=p_symbol
), paper as (
  select count(*) filter(where status='filled')::int as open_orders,
         count(*) filter(where status='closed')::int as closed_orders
  from public.paper_orders
  where symbol=p_symbol
), breaker as (
  select state, reason, created_at
  from public.circuit_breaker_events
  order by created_at desc limit 1
), live_flag as (
  select coalesce((config->>'live_enabled')::boolean,false) as live_enabled
  from public.risk_limits where name='global'
)
select jsonb_build_object(
  'symbol',p_symbol,
  'executionMode',coalesce((select value from public.runtime_settings where key='execution_mode'),'paper'),
  'liveEnabled',coalesce((select live_enabled from live_flag),false),
  'ingestion',coalesce((select to_jsonb(latest_ingestion) from latest_ingestion),'{}'::jsonb),
  'prediction',coalesce((select to_jsonb(latest_prediction) from latest_prediction),'{}'::jsonb),
  'outcome',coalesce((select to_jsonb(latest_outcome) from latest_outcome),'{}'::jsonb),
  'monitoring',coalesce((select to_jsonb(latest_monitor) from latest_monitor),'{}'::jsonb),
  'retraining',coalesce((select to_jsonb(retraining) from retraining),'{}'::jsonb),
  'paper',coalesce((select to_jsonb(paper) from paper),'{}'::jsonb),
  'circuitBreaker',coalesce((select to_jsonb(breaker) from breaker),'{}'::jsonb)
);
$$;
revoke all on function public.closed_loop_health(text) from public;
grant execute on function public.closed_loop_health(text) to anon, authenticated, service_role;

-- Idempotent schedules. Jobs can safely overlap because every Edge Function uses durable idempotency keys.
do $$
declare r record;
begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    for r in select jobid from cron.job where jobname in ('gold-public-refresh','gold-paper-executor','gold-closed-loop-evaluator','gold-baseline-train') loop
      perform cron.unschedule(r.jobid);
    end loop;
    perform cron.schedule('gold-public-refresh','*/5 * * * *','select public.invoke_public_refresh();');
    perform cron.schedule('gold-paper-executor','*/5 * * * *','select public.invoke_paper_executor();');
    perform cron.schedule('gold-closed-loop-evaluator','*/5 * * * *','select public.invoke_closed_loop_evaluator();');
    perform cron.schedule('gold-baseline-train','17 1 * * *','select public.invoke_baseline_training();');
  end if;
end $$;
