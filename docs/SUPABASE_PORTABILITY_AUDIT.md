# Supabase portability audit

Dedicated project: `trading_system_oro_pro_max` (`dcpwsesxnhkmolqqqwde`, sa-east-1).

## Verified runtime state

The dedicated project is active and already contains the closed-loop trading schema and bootstrap data. At audit time it contained market bars/features, model runs/predictions, backtests, risk limits, data-source catalog, data-quality results, promotion events, experiments and runtime settings.

The database migration history currently contains six migrations:

1. `20260917060431_core`
2. `20260917060633_observability_and_sources`
3. `20260917062714_runtime_automation_and_dashboard`
4. `20260917062919_custom_auth_public_refresh`
5. `20260917063216_schedule_baseline_training`
6. `20260917063259_dashboard_benchmark_and_health`

The live Supabase project also has two active Edge Functions:

- `refresh-public-gold`
- `train-baseline`

Both use a custom `x-refresh-token` guard and intentionally do not rely on Supabase JWT verification. Broker credentials are not stored in Vercel and live broker execution remains disabled.

## Portability gap

Git currently contains only `supabase/migrations/0001_core.sql`, so the deployed database is ahead of the repository. Before any transfer to Martin, the remaining migration SQL and Edge Function source must be checked into Git so a fresh Supabase project can be recreated from the repository alone.

## Transfer contract

A transfer-ready release requires:

- all database migrations in Git in execution order;
- all Edge Function source in Git;
- no account-specific project refs or secrets embedded in code;
- runtime URLs/tokens configured from environment/runtime settings;
- a reproducible bootstrap/runbook for a fresh Supabase project;
- broker worker credentials kept only on the execution machine/VPS.

This audit is intentionally non-destructive and does not alter trading data or promotion state.
