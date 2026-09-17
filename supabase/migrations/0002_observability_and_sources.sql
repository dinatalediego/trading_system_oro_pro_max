create index if not exists ix_market_bars_ingestion_run_id
  on market_bars(ingestion_run_id);
create index if not exists ix_paper_orders_prediction_id
  on paper_orders(prediction_id);

create table if not exists data_sources (
  source_key text primary key,
  source_type text not null,
  canonical_symbol text,
  priority int not null default 100,
  purpose text not null,
  cadence text,
  endpoint text,
  requires_secret boolean not null default false,
  point_in_time_safe boolean not null default false,
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into data_sources(source_key, source_type, canonical_symbol, priority, purpose, cadence, endpoint, requires_secret, point_in_time_safe, metadata)
values
  ('mt5_broker_xauusd', 'broker', 'XAUUSD', 1, 'Canonical execution and broker-price history once Martin provides/authorizes MT5 access', '1m/tick', null, true, true, '{"status":"pending_broker_access"}'::jsonb),
  ('yahoo_gc_futures', 'public_market_proxy', 'GC=F', 20, 'Free bootstrap proxy for gold research and pipeline smoke tests; not canonical for broker execution', '1m/daily', 'https://query1.finance.yahoo.com/v8/finance/chart/', false, false, '{"limitations":["unofficial endpoint","proxy instrument","intraday history limits"]}'::jsonb),
  ('fred_macro', 'public_macro', null, 30, 'Macro context such as USD/rates; current-vintage CSV is research-only until vintage-safe ingestion is enabled', 'daily', 'https://fred.stlouisfed.org/graph/fredgraph.csv', false, false, '{"status":"research_only_current_vintage"}'::jsonb)
on conflict (source_key) do update set
  purpose = excluded.purpose,
  cadence = excluded.cadence,
  endpoint = excluded.endpoint,
  requires_secret = excluded.requires_secret,
  point_in_time_safe = excluded.point_in_time_safe,
  metadata = excluded.metadata,
  updated_at = now();

create table if not exists data_quality_results (
  id bigint generated always as identity primary key,
  ingestion_run_id uuid references data_ingestion_runs(id),
  dataset text not null,
  check_name text not null,
  status text not null check(status in ('pass','warn','fail')),
  observed numeric,
  expected jsonb,
  details jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index if not exists ix_dq_dataset_checked_at on data_quality_results(dataset, checked_at desc);
create index if not exists ix_dq_ingestion_run_id on data_quality_results(ingestion_run_id);

create table if not exists model_promotion_events (
  id bigint generated always as identity primary key,
  model_version text not null,
  from_stage text,
  to_stage text not null check(to_stage in ('candidate','backtest','paper','shadow','small_live','live','rejected','retired')),
  decision text not null check(decision in ('promote','hold','reject','rollback')),
  gate_metrics jsonb not null default '{}'::jsonb,
  reason text,
  actor text not null default 'system',
  created_at timestamptz not null default now()
);
create index if not exists ix_model_promotion_version_created on model_promotion_events(model_version, created_at desc);

create table if not exists strategy_experiments (
  id uuid primary key default gen_random_uuid(),
  experiment_key text not null unique,
  hypothesis text not null,
  status text not null default 'planned' check(status in ('planned','running','completed','killed')),
  baseline_version text,
  challenger_version text,
  protocol jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

alter table data_sources enable row level security;
alter table data_quality_results enable row level security;
alter table model_promotion_events enable row level security;
alter table strategy_experiments enable row level security;

-- Deliberately no anon/authenticated policies yet. V1/V2 uses server-side service role only.
