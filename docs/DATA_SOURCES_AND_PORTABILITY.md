# Data sources, canonicality and portability

## Source hierarchy

1. **Broker / MetaTrader 5 (`XAUUSD`)** — future canonical source for execution, spread, tick value, broker timezone and reproducible live/paper comparison.
2. **Public gold proxy (`GC=F`)** — bootstrap-only source used to keep ETL, indicators, UI and MLOps moving before broker history is supplied. It must never be presented as if it were the Tag Markets execution feed.
3. **Macro public sources** — optional context (USD, rates, volatility, calendar). A series is excluded from leakage-sensitive backtests unless its `available_at`/vintage contract proves that the observation existed at decision time.

The database table `data_sources` records this hierarchy and whether a source is point-in-time safe.

## No forced daily profit objective

The decision space is `BUY | SELL | NO_TRADE`. Promotion is based on out-of-sample net expectancy and risk, not on manufacturing a profitable trade every day. A model or rule set may be rejected even when its in-sample win rate is high.

## Promotion ladder

`candidate -> backtest -> paper -> shadow -> small_live -> live`

Every transition is recorded in `model_promotion_events`. Neural models are challengers; they do not skip leakage, cost, drawdown or calibration gates.

## Portability contract for Martin

The Git repository and SQL migrations are the source of truth. Application code must not hard-code Supabase project refs, Vercel team IDs, broker account IDs or secrets. Runtime-specific values live only in environment variables.

Required runtime variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` or publishable key
- `SUPABASE_SERVICE_ROLE_KEY` (server / CI only; never expose to browser)
- Broker/MT5 credentials only on the future execution worker/VPS, never in GitHub

To transfer later, create/transfer the destination infrastructure, replay `supabase/migrations/*`, update environment variables, then validate row counts and checksums before switching traffic. The ML/data contracts remain unchanged.

## Current bootstrap limitation

Yahoo chart data is an unofficial public proxy with intraday history limits. It exists to exercise the product end-to-end while Martin prepares broker exports. It is not suitable evidence for claiming that a strategy will reproduce SONIC or Tag Markets execution performance.
