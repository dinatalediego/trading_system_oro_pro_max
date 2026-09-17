# Production gates

The product is intentionally released in stages. A stage may not be skipped because a model is more complex.

## Stage 0 — Build / deploy
- GitHub CI is green.
- Vercel build succeeds.
- `/api/health` returns `status=ok`.
- Supabase migrations are reproducible from Git.

## Stage 1 — Research
- Time-indexed XAU/USD market data are ingested without look-ahead leakage.
- Feature generation reproduces RSI, WaveTrend and Squeeze semantics used by the UI/TradingView research layer.
- Candidate signals include BUY, SELL and NO_TRADE.

## Stage 2 — Backtest
- Walk-forward or expanding-window evaluation only.
- Spread, commission and slippage assumptions are explicit.
- Report: net PnL, max drawdown, profit factor, Sortino, hit rate, calibration and trade coverage.
- No parameter may be selected using the final holdout.

## Stage 3 — Paper trading
- Orders are simulated from live/near-live signals.
- Every prediction, risk veto, simulated order and outcome is persisted.
- Daily loss and drawdown guards are enforced.

## Stage 4 — Shadow
- System observes broker market data and generates proposed orders but does not transmit them.
- Slippage and broker-symbol differences are measured.

## Stage 5 — Small live
- Requires explicit human approval and a dedicated execution worker.
- Fixed small risk budget, hard daily loss cap, kill switch and audit log.

## Stage 6 — Live
- Only after sustained out-of-sample + paper + shadow evidence.
- Promotion is reversible; degradation triggers rollback to the prior model or PAPER mode.

## Non-negotiable defaults
- `NO_TRADE` is a valid and expected action.
- Neural models are challengers until they beat a leakage-safe baseline out of sample after costs.
- The Vercel app never stores broker credentials.
- Broker execution belongs in a dedicated MT5/local/VPS worker.
- Private broker exports must never be committed to the public repository.
