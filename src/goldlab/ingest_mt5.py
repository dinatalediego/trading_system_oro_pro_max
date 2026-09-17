from __future__ import annotations
from datetime import datetime, timezone
import os
import pandas as pd


def fetch_m1(symbol: str | None = None, count: int = 100_000) -> pd.DataFrame:
    """Fetch exact broker M1 bars from a locally authenticated MetaTrader 5 terminal.

    Run on Windows where MT5 is installed. Credentials are never stored in the repository.
    """
    import MetaTrader5 as mt5  # optional dependency
    symbol = symbol or os.getenv("MT5_SYMBOL", "XAUUSD")
    if not mt5.initialize():
        raise RuntimeError(f"MT5 initialize failed: {mt5.last_error()}")
    try:
        rates = mt5.copy_rates_from(symbol, mt5.TIMEFRAME_M1, datetime.now(timezone.utc), count)
        if rates is None:
            raise RuntimeError(f"MT5 rates failed: {mt5.last_error()}")
        df = pd.DataFrame(rates).rename(columns={"time": "ts"})
        df["ts"] = pd.to_datetime(df["ts"], unit="s", utc=True)
        df["symbol"] = symbol
        return df[["ts","symbol","open","high","low","close","tick_volume","spread","real_volume"]]
    finally:
        mt5.shutdown()
