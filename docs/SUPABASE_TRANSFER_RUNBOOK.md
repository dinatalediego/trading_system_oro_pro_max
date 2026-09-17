# Supabase transfer / rebuild runbook

This project is designed so Martín can recreate the backend in a Supabase project he owns without copying account secrets or depending on the current project ref.

## 1. Create the destination project

Create a fresh Supabase project in the destination account/organization. Keep its project ref out of Git.

## 2. Apply migrations in order

Apply every SQL file in `supabase/migrations/` in lexical order (`0001_...` through the latest migration). These files recreate the trading schema, observability tables, risk gates, closed-loop state, cron jobs and portability bridge.

The migrations intentionally leave project-specific Edge Function URLs unset. They also preserve `live_enabled=false` / `paper_only=true`.

## 3. Deploy Edge Functions

Deploy these versioned functions from `supabase/functions/`:

- `refresh-public-gold`
- `execute-paper`
- `evaluate-closed-loop`
- `train-baseline`

They use Supabase-provided `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` at runtime. Do not commit either value.

The functions use a custom `x-refresh-token` because cron calls originate inside Postgres. JWT verification is therefore disabled for these internal functions, but every request must match the token stored in `runtime_settings.public_refresh_token`.

## 4. Configure the destination runtime bridge

After the functions exist, set only the destination base URL in the database:

```sql
insert into public.runtime_settings(key,value)
values ('edge_function_base_url','https://<DESTINATION_PROJECT_REF>.supabase.co/functions/v1')
on conflict (key) do update set value=excluded.value, updated_at=now();
```

Do not copy the old `public_refresh_token`; migration `0004` generates a new random token in the destination project.

Legacy keys `public_refresh_url` and `baseline_train_url` are not required after migration `0007`; the portability bridge derives all internal function URLs from `edge_function_base_url`.

## 5. Validate closed-loop state

Run SELECT-only checks:

```sql
select public.closed_loop_health('XAUUSD_PROXY_GC');
select key,value from public.runtime_settings where key in ('execution_mode','edge_function_base_url');
select name,config from public.risk_limits where name='global';
select jobname,schedule,active from cron.job where jobname like 'gold-%' order by jobname;
```

Expected safety state before any broker work:

- `execution_mode = paper`
- `live_enabled = false`
- `paper_only = true`
- four `gold-*` cron jobs active
- no broker credentials in Supabase, Vercel or Git

## 6. Reconnect Vercel

Configure Vercel with the destination project URL and service-role secret using Vercel environment variables. Never commit the service-role secret. Redeploy and verify `/api/health` plus the dashboard snapshot.

## 7. Broker worker remains separate

The eventual MT5/Tag Markets worker belongs on Martín's machine/VPS. Broker login, password, investor password and execution tokens stay only on that execution machine. Supabase receives decisions/outcomes, not broker credentials.

## Promotion contract

The transferable system retains the ladder:

`RESEARCH -> BACKTEST -> PAPER -> SHADOW -> SMALL_LIVE -> LIVE`

A transfer does not promote execution stage. A fresh installation starts paper-only until broker-specific data, costs, slippage and explicit live authorization are validated.
