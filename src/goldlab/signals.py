from __future__ import annotations

import numpy as np
import pandas as pd

from .features import atr


def ut_bot(df: pd.DataFrame, key_value: float = 1.0, atr_period: int = 10) -> pd.DataFrame:
    """UT-Bot-style ATR trailing-stop candidate signals.

    This implements the common ATR trailing-stop formulation with key_value=1
    and ATR period=10 as a reproducible baseline. Exact TradingView parity
    requires the exact UT Bot Pine source/settings used by the trader.
    """
    out = df.sort_values("ts").copy()
    src = out["close"].astype(float)
    nloss = key_value * atr(out, atr_period)
    stop = np.full(len(out), np.nan, dtype=float)

    for i in range(len(out)):
        if i == 0 or np.isnan(nloss.iloc[i]):
            stop[i] = src.iloc[i] if i == 0 else stop[i - 1]
            continue
        prev_stop = stop[i - 1]
        prev_src = src.iloc[i - 1]
        cur = src.iloc[i]
        loss = nloss.iloc[i]
        if cur > prev_stop and prev_src > prev_stop:
            stop[i] = max(prev_stop, cur - loss)
        elif cur < prev_stop and prev_src < prev_stop:
            stop[i] = min(prev_stop, cur + loss)
        elif cur > prev_stop:
            stop[i] = cur - loss
        else:
            stop[i] = cur + loss

    out["ut_stop"] = stop
    above = src > out["ut_stop"]
    out["ut_buy"] = (above & ~above.shift(1).fillna(False)).astype(int)
    out["ut_sell"] = ((~above) & above.shift(1).fillna(False)).astype(int)
    out["ut_signal"] = np.select(
        [out["ut_buy"].eq(1), out["ut_sell"].eq(1)],
        ["BUY", "SELL"],
        default=None,
    )
    return out


def combined_candidate(df: pd.DataFrame) -> pd.Series:
    """Produce a conservative rule candidate before ML meta-labeling.

    UT provides the event. WaveTrend/RSI/Squeeze act as confirmation features.
    A missing confirmation becomes NO candidate rather than a forced trade.
    """
    buy = (
        df["ut_buy"].eq(1)
        & (df["wt1"] > df["wt2"])
        & (df["rsi"] < 70)
        & (df["squeeze"] >= 0)
    )
    sell = (
        df["ut_sell"].eq(1)
        & (df["wt1"] < df["wt2"])
        & (df["rsi"] > 30)
        & (df["squeeze"] <= 0)
    )
    return pd.Series(np.select([buy, sell], ["BUY", "SELL"], default=None), index=df.index, name="rule_signal")
