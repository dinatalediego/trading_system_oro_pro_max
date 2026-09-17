# Architecture

## Closed loop

```text
MT5 / public market data
        |
        v
raw bars + ingestion ledger ----> quality checks
        |                              |
        v                              v
point-in-time features --------> dataset version
        |                              |
        +---- deterministic signals ---+
        |                              |
        v                              v
candidate trade ------------> calibrated ML meta-label
                                      |
                                      v
                         expected edge after costs
                                      |
                                      v
                              RISK / NO-TRADE GATE
                                |             |
                             paper          reject
                                |
                                v
                         execution outcome
                                |
                                v
                      evaluation + drift + retrain
```

## Why the model may abstain

A system optimized for “a winning trade every day” is structurally incentivized to trade when no edge exists. V1 therefore treats `NO_TRADE` as a first-class decision. The primary objective is risk-adjusted out-of-sample expectancy after realistic costs, subject to drawdown and exposure limits.

## Model ladder

1. Rules-only benchmark: WaveTrend/RSI/Squeeze plus UT-style candidate trigger.
2. Calibrated linear baseline.
3. Gradient-boosted challenger.
4. Sequence challenger: TCN/LSTM.
5. Transformer/TFT only if the simpler models establish repeatable walk-forward edge.

Neural networks are challengers, not an automatic promotion. Every promotion uses the same frozen out-of-sample evaluation contract.

## Leakage controls

- chronological splits only;
- labels use future data, features never do;
- purged/embargoed validation around label horizons;
- macro inputs stored with `available_at`, not simply observation date;
- broker history aligned in UTC;
- costs/spread/slippage included before model promotion;
- model, dataset, features and thresholds versioned together.

## Deployment boundary

Vercel serves the cockpit and read-oriented API. Heavy ETL/training is performed by Python workers / GitHub Actions / a local MT5 runner, not inside request handlers. Supabase is the durable event and feature store.
