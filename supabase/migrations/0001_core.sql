create extension if not exists pgcrypto;

create table if not exists data_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  dataset text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','success','failed')),
  rows_written bigint default 0,
  watermark timestamptz,
  details jsonb not null default '{}'::jsonb
);

create table if not exists market_bars (
  symbol text not null,
  timeframe text not null default '1m',
  ts timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  bid numeric,
  ask numeric,
  spread numeric,
  tick_volume numeric,
  real_volume numeric,
  provider text not null,
  ingestion_run_id uuid references data_ingestion_runs(id),
  created_at timestamptz not null default now(),
  primary key(symbol,timeframe,ts,provider)
);
create index if not exists ix_market_bars_symbol_ts on market_bars(symbol, ts desc);

create table if not exists gold_market_features (
  symbol text not null,
  ts timestamptz not null,
  feature_set_version text not null,
  close numeric not null,
  rsi numeric,
  atr numeric,
  wt1 numeric,
  wt2 numeric,
  squeeze numeric,
  rule_signal text check(rule_signal in ('BUY','SELL') or rule_signal is null),
  features jsonb not null default '{}'::jsonb,
  available_at timestamptz not null,
  primary key(symbol,ts,feature_set_version)
);
create index if not exists ix_features_symbol_ts on gold_market_features(symbol, ts desc);

create table if not exists broker_trades (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'copy_history',
  ticket text,
  symbol text not null,
  side text not null check(side in ('BUY','SELL')),
  open_time timestamptz not null,
  close_time timestamptz,
  open_price numeric not null,
  close_price numeric,
  volume numeric,
  stop_loss numeric,
  take_profit numeric,
  commission numeric,
  swap numeric,
  fees numeric,
  realized_pnl numeric,
  metadata jsonb not null default '{}'::jsonb,
  unique(source,ticket)
);
create index if not exists ix_broker_trades_open_time on broker_trades(open_time desc);

create table if not exists model_runs (
  id uuid primary key default gen_random_uuid(),
  model_name text not null,
  model_version text not null unique,
  dataset_version text not null,
  feature_set_version text not null,
  train_start timestamptz,
  train_end timestamptz,
  metrics jsonb not null default '{}'::jsonb,
  params jsonb not null default '{}'::jsonb,
  artifact_uri text,
  status text not null default 'candidate' check(status in ('candidate','champion','rejected','retired')),
  created_at timestamptz not null default now()
);

create table if not exists model_predictions (
  id bigint generated always as identity primary key,
  symbol text not null,
  prediction_ts timestamptz not null,
  horizon_minutes int not null,
  action text not null check(action in ('BUY','SELL','NO_TRADE')),
  probability numeric not null check(probability between 0 and 1),
  expected_return numeric,
  risk_state text not null,
  model_version text not null,
  features_ts timestamptz not null,
  explanation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ix_predictions_symbol_created on model_predictions(symbol, created_at desc);

create table if not exists backtest_runs (
  id uuid primary key default gen_random_uuid(),
  model_version text not null,
  dataset_version text not null,
  start_ts timestamptz not null,
  end_ts timestamptz not null,
  assumptions jsonb not null,
  metrics jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists paper_orders (
  id uuid primary key default gen_random_uuid(),
  prediction_id bigint references model_predictions(id),
  symbol text not null,
  side text not null check(side in ('BUY','SELL')),
  requested_at timestamptz not null,
  requested_price numeric,
  filled_at timestamptz,
  fill_price numeric,
  quantity numeric not null,
  stop_loss numeric,
  take_profit numeric,
  status text not null check(status in ('pending','filled','closed','cancelled','rejected')),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists execution_outcomes (
  paper_order_id uuid primary key references paper_orders(id),
  closed_at timestamptz not null,
  close_price numeric not null,
  gross_pnl numeric,
  costs numeric,
  net_pnl numeric,
  mfe numeric,
  mae numeric,
  outcome_label text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists risk_limits (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  enabled boolean not null default true,
  config jsonb not null,
  updated_at timestamptz not null default now()
);

insert into risk_limits(name,config) values
 ('global', '{"max_trades_per_day":2,"max_daily_loss_r":1.0,"max_open_positions":1,"min_probability":0.62,"max_spread_atr":0.12,"cooldown_minutes":15,"live_enabled":false}'::jsonb)
on conflict (name) do nothing;

alter table data_ingestion_runs enable row level security;
alter table market_bars enable row level security;
alter table gold_market_features enable row level security;
alter table broker_trades enable row level security;
alter table model_runs enable row level security;
alter table model_predictions enable row level security;
alter table backtest_runs enable row level security;
alter table paper_orders enable row level security;
alter table execution_outcomes enable row level security;
alter table risk_limits enable row level security;

-- No anon policies in V1. Server-side service role only. This keeps account/trading data private and portable.
