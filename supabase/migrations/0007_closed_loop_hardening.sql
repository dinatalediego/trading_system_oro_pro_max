create table if not exists public.prediction_outcomes (
  prediction_id bigint primary key references public.model_predictions(id) on delete cascade,
  model_version text not null,
  symbol text not null,
  horizon_minutes integer not null,
  evaluated_at timestamptz not null default now(),
  entry_price numeric not null,
  exit_price numeric not null,
  realized_return numeric not null,
  action text not null check(action in ('BUY','SELL','NO_TRADE')),
  directional_correct boolean,
  cost_return numeric not null default 0,
  net_return numeric not null,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists ix_prediction_outcomes_model_eval on public.prediction_outcomes(model_version, evaluated_at desc);
create index if not exists ix_prediction_outcomes_symbol_eval on public.prediction_outcomes(symbol, evaluated_at desc);
alter table public.prediction_outcomes enable row level security;

create table if not exists public.retraining_runs (
  id uuid primary key default gen_random_uuid(),
  model_name text not null,
  trigger_type text not null check(trigger_type in ('schedule','manual','drift','data_refresh')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check(status in ('running','success','failed','skipped')),
  rows_seen integer,
  candidate_version text,
  promoted boolean,
  metrics jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb
);
create index if not exists ix_retraining_runs_model_started on public.retraining_runs(model_name, started_at desc);
alter table public.retraining_runs enable row level security;

insert into public.runtime_settings(key,value) values
  ('paper_cost_return','0.00015'),
  ('prediction_outcome_max_lag_minutes','10')
on conflict (key) do nothing;

create or replace function public.evaluate_prediction_outcomes(
  p_symbol text default 'XAUUSD_PROXY_GC',
  p_cost_return numeric default 0.00015,
  p_limit integer default 500
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  with due as (
    select p.id, p.symbol, p.prediction_ts, p.horizon_minutes, p.action,
           p.probability, p.model_version, p.features_ts,
           f.close::numeric as entry_price,
           p.prediction_ts + make_interval(mins => p.horizon_minutes) as target_ts
    from public.model_predictions p
    join public.gold_market_features f
      on f.symbol=p.symbol and f.ts=p.features_ts
    left join public.prediction_outcomes o on o.prediction_id=p.id
    where o.prediction_id is null
      and p.symbol=p_symbol
      and p.prediction_ts <= now() - make_interval(mins => p.horizon_minutes)
    order by p.prediction_ts asc
    limit greatest(1, least(p_limit, 5000))
  ), resolved as (
    select d.*,
           x.ts as exit_ts,
           x.close::numeric as exit_price,
           ln(x.close::numeric / nullif(d.entry_price,0)) as realized_return
    from due d
    join lateral (
      select g.ts, g.close
      from public.gold_market_features g
      where g.symbol=d.symbol
        and g.ts >= d.target_ts
        and g.ts <= d.target_ts + interval '10 minutes'
      order by g.ts asc
      limit 1
    ) x on true
  ), ins as (
    insert into public.prediction_outcomes(
      prediction_id, model_version, symbol, horizon_minutes, entry_price, exit_price,
      realized_return, action, directional_correct, cost_return, net_return, metadata
    )
    select id, model_version, symbol, horizon_minutes, entry_price, exit_price,
           realized_return, action,
           case when action='BUY' then realized_return>0
                when action='SELL' then realized_return<0
                else null end,
           case when action='NO_TRADE' then 0 else p_cost_return end,
           case when action='BUY' then realized_return-p_cost_return
                when action='SELL' then -realized_return-p_cost_return
                else 0 end,
           jsonb_build_object('exit_ts',exit_ts,'probability',probability,'source','feature_horizon')
    from resolved
    on conflict (prediction_id) do nothing
    returning 1
  )
  select count(*) into v_count from ins;
  return v_count;
end;
$$;
revoke all on function public.evaluate_prediction_outcomes(text,numeric,integer) from public;
grant execute on function public.evaluate_prediction_outcomes(text,numeric,integer) to service_role, postgres;

create or replace function public.model_outcome_summary(p_model_version text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
select jsonb_build_object(
  'model_version', p_model_version,
  'evaluated_predictions', count(*),
  'acted_predictions', count(*) filter (where action <> 'NO_TRADE'),
  'directional_hit_rate', coalesce(avg(directional_correct::int) filter (where directional_correct is not null),0),
  'mean_net_return', coalesce(avg(net_return) filter (where action <> 'NO_TRADE'),0),
  'total_net_return', coalesce(sum(net_return) filter (where action <> 'NO_TRADE'),0),
  'last_evaluated_at', max(evaluated_at)
)
from public.prediction_outcomes
where model_version=p_model_version;
$$;
revoke all on function public.model_outcome_summary(text) from public;
grant execute on function public.model_outcome_summary(text) to service_role, postgres;

do $$
begin
  if not exists (select 1 from cron.job where jobname='gold-prediction-outcomes') then
    perform cron.schedule(
      'gold-prediction-outcomes',
      '*/5 * * * *',
      $$select public.evaluate_prediction_outcomes('XAUUSD_PROXY_GC',0.00015,1000);$$
    );
  end if;
end $$;
