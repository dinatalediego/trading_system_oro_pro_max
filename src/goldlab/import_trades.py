from __future__ import annotations
import pandas as pd

REQUIRED = ["Ticket","Type","Open Date","Close Date","Symbol","Volume","Price","Profit"]


def load_copy_history(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, sep=None, engine="python")
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing: raise ValueError(f"Missing columns: {missing}")
    out = df.rename(columns={"Ticket":"ticket","Type":"side","Open Date":"open_time","Close Date":"close_time","Symbol":"symbol","Volume":"volume","Price":"open_price","Profit":"realized_pnl"}).copy()
    out["open_time"] = pd.to_datetime(out.open_time, utc=True)
    out["close_time"] = pd.to_datetime(out.close_time, utc=True)
    out["side"] = out.side.str.upper()
    out["duration_seconds"] = (out.close_time - out.open_time).dt.total_seconds().astype(int)
    return out
