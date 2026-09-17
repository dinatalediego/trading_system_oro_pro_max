from goldlab.ingest_public import quality_checks, to_market_rows

import pandas as pd


def _frame():
    return pd.DataFrame(
        {
            "ts": pd.to_datetime(["2026-09-17T00:00:00Z", "2026-09-17T00:01:00Z"], utc=True),
            "open": [4300.0, 4301.0],
            "high": [4302.0, 4303.0],
            "low": [4299.0, 4300.0],
            "close": [4301.0, 4302.0],
            "volume": [100.0, 110.0],
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
    assert rows[0]["close"] == 4301.0
    assert rows[0]["ts"].endswith("+00:00")
