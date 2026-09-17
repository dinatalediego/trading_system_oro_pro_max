from goldlab.ingest_public import quality_checks, to_feature_rows, to_market_rows

import numpy as np
import pandas as pd


def _frame(n: int = 2):
    ts = pd.date_range("2026-09-17T00:00:00Z", periods=n, freq="min")
    close = 4300 + np.arange(n) * 0.25 + np.sin(np.arange(n) / 4)
    return pd.DataFrame(
        {
            "ts": ts,
            "open": close - 0.15,
            "high": close + 0.8,
            "low": close - 0.8,
            "close": close,
            "volume": 100 + np.arange(n),
        }
    )


def test_quality_checks_pass_clean_ohlc():
    checks = quality_checks(_frame())
    assert {c["check_name"]: c["status"] for c in checks} == {
        "non_empty": "pass",
        "ohlc_consistency": "pass",
        "unique_timestamp": "pass",
    }


def test_to_market_rows_contract():
    rows = to_market_rows(_frame(), symbol="GC=F", interval="1m", provider="yahoo_chart")
    assert len(rows) == 2
    assert rows[0]["symbol"] == "GC=F"
    assert rows[0]["provider"] == "yahoo_chart"
    assert rows[0]["ts"].endswith("+00:00")


def test_feature_rows_are_lag_available_and_versioned():
    rows = to_feature_rows(_frame(90), symbol="GC=F", interval="1m")
    assert len(rows) == 90
    assert rows[-1]["feature_set_version"] == "public-bootstrap-v1"
    ts = pd.Timestamp(rows[-1]["ts"])
    available = pd.Timestamp(rows[-1]["available_at"])
    assert available - ts == pd.Timedelta(minutes=1)
    assert rows[-1]["rsi"] is not None
    assert "ret_60" in rows[-1]["features"]
