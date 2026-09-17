import numpy as np
import pandas as pd

from goldlab.features import add_features
from goldlab.signals import combined_candidate, ut_bot


def sample(n=260):
    ts = pd.date_range("2026-01-01", periods=n, freq="min", tz="UTC")
    close = pd.Series(4300 + np.sin(np.arange(n) / 8) * 8 + np.arange(n) * 0.01)
    return pd.DataFrame({
        "ts": ts,
        "open": close.shift(1).fillna(close),
        "high": close + 1.1,
        "low": close - 1.1,
        "close": close,
    })


def test_ut_bot_emits_only_valid_sides():
    x = add_features(sample())
    x = ut_bot(x, key_value=1.0, atr_period=10)
    assert set(x.ut_signal.dropna().unique()).issubset({"BUY", "SELL"})
    assert x.ut_buy.sum() + x.ut_sell.sum() > 0


def test_combined_candidate_can_abstain():
    x = ut_bot(add_features(sample()))
    s = combined_candidate(x)
    assert set(s.dropna().unique()).issubset({"BUY", "SELL"})
    assert s.isna().any()
