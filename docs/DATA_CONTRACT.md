# Minimum data contract

## What the supplied copy history can teach us

Trade fills can reveal timing, side, holding period, sizing and realized outcomes. They do **not** uniquely identify the provider's hidden entry logic, stop logic, intra-trade adverse excursion or execution economics.

## Preferred broker export

Minimum useful columns for strategy forensics:

- `ticket`
- `side` (`BUY`/`SELL`)
- `open_time_utc`
- `open_price`
- `close_time_utc`
- `close_price`
- `volume`
- `stop_loss`
- `take_profit`
- `commission`
- `swap`
- `fees`
- `realized_pnl`
- `symbol` and exact broker symbol (e.g. suffix)

Account/execution metadata:

- broker/server timezone and DST rule;
- contract size and tick value;
- account currency;
- leverage;
- starting balance;
- balance/equity snapshots if available;
- spread or bid/ask at entry/exit;
- copy-trading latency/slippage or multiplier.

## Market data

For a 1-minute decision system, retain at least:

`ts_utc, symbol, open, high, low, close, bid, ask, spread, tick_volume, provider`

M1 is the canonical training bar. Keep ticks around actual entries/exits when available so execution quality can later be estimated.

## External context

Point-in-time macro/context may include real yields, Treasury yields, USD index proxy, VIX, gold futures, and scheduled high-impact events. Every feature must have an `available_at` timestamp so revised/released-later information cannot leak into historical training.

## Private-data handling

The repository is public. Never commit account statements, ticket-level private history, credentials or API keys. Store private imports in `data/private/` locally or protected Supabase tables.
