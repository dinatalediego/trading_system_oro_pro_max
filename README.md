# Gold Decision Lab — `trading_system_oro_pro_max`

A closed-loop research, forecasting, backtesting and paper-trading system for XAU/USD.

## Product objective

The objective is **not** to promise a profitable trade every day. The system is built to estimate whether a trade has positive expected value **after spread, commission and slippage**, and to explicitly return `NO_TRADE` when confidence or market conditions are poor.

The long-term loop is:

`market data -> features -> candidate signals -> calibrated prediction -> risk gate -> paper execution -> outcome -> evaluation -> retraining/challenger -> promotion`

The first benchmark is the observed behaviour of the supplied copy-trading history, while avoiding the assumption that its hidden strategy can be exactly reverse-engineered from fills alone.

## V1 architecture

- **Web:** Next.js / TypeScript, deployable on Vercel.
- **Database:** PostgreSQL / Supabase with migrations kept in Git so the database can later be recreated or transferred.
- **Research/ML:** Python package for ETL, feature engineering, walk-forward validation, backtesting and model training.
- **Signals:** UT-style trend trigger + WaveTrend + Squeeze Momentum + RSI, with ML used as a meta-label / probability layer rather than blindly replacing deterministic rules.
- **Models:** baseline logistic/gradient boosting first; sequence model challenger (TCN/LSTM/Transformer-ready) only after a leakage-safe baseline exists.
- **MLOps:** immutable model runs, feature snapshots, backtest runs, predictions, paper orders and outcomes.
- **Automation:** GitHub Actions for tests/research jobs; Supabase for durable state; Vercel for UI/API.

## Data-source strategy

1. Exact broker/MT5 XAUUSD bars/ticks whenever possible (best alignment with execution).
2. Public/free historical quote source as a reproducible fallback.
3. FRED/ALFRED macro series for slow-moving context.
4. Optional commercial intraday feed behind the same provider interface if free-source limits become binding.

Do not scrape TradingView. TradingView/Pine is treated as a signal/visualisation surface; ingestion is done through supported exports/webhooks or independent market-data providers.

## Minimum trade-history contract

A historical fill file is useful, but to reproduce execution economics the preferred export is:

`ticket, side, open_time_utc, open_price, close_time_utc, close_price, volume, stop_loss, take_profit, commission, swap, fees, realized_pnl, symbol, broker_symbol, account_currency`

Also record:

- broker/server timezone and DST rule;
- starting balance and periodic balance/equity snapshots;
- account leverage and contract size;
- bid/ask or spread at entry/exit if available;
- whether trades are copied with latency/slippage and the copy multiplier.

Raw account exports, credentials, API tokens and ticket-level private history **must not be committed to this public repository**. Use local `data/private/` or Supabase protected tables.

## Safety gates before broker automation

`RESEARCH -> BACKTEST -> PAPER -> SHADOW -> SMALL_LIVE -> LIVE`

Promotion requires out-of-sample evidence and explicit risk limits. Live execution is intentionally not the V1 default.

## Repository layout

```text
app/                     Next.js dashboard/API
src/goldlab/             Python ETL, features, models, backtest
supabase/migrations/     portable database schema
data/                     public/sample only; private ignored
docs/                     architecture, data contract, model card
.github/workflows/       CI / scheduled research jobs
```

See `docs/ARCHITECTURE.md` and `docs/DATA_CONTRACT.md` after the initial scaffold.
