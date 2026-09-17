from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable
from urllib.parse import quote

import pandas as pd
import requests

from goldlab.features import add_features

YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
FEATURE_SET_VERSION = "public-bootstrap-v1"


@dataclass(frozen=True)
class YahooRequest:
    symbol: str = "GC=F"
    interval: str = "1m"
    range_: str = "7d"


def fetch_yahoo_chart(req: YahooRequest, timeout: int = 30) -> pd.DataFrame:
    """Fetch a free bootstrap market proxy.

    This endpoint is intentionally treated as a research/bootstrap source rather
    than a canonical broker feed. Production execution must move to broker/MT5
    data once available.
    """
    url = f"{YAHOO_BASE}/{quote(req.symbol, safe='')}"
    response = requests.get(
        url,
        params={"interval": req.interval, "range": req.range_, "includePrePost": "true"},
        headers={"User-Agent": "goldlab/0.2 research"},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    result = payload.get("chart", {}).get("result") or []
    if not result:
        error = payload.get("chart", {}).get("error")
        raise RuntimeError(f"Yahoo returned no chart data: {error}")

    node = result[0]
    timestamps = node.get("timestamp") or []
    quote_node = ((node.get("indicators") or {}).get("quote") or [{}])[0]
    if not timestamps:
        return pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume"])

    frame = pd.DataFrame(
        {
            "ts": pd.to_datetime(timestamps, unit="s", utc=True),
            "open": quote_node.get("open"),
            "high": quote_node.get("high"),
            "low": quote_node.get("low"),
            "close": quote_node.get("close"),
            "volume": quote_node.get("volume"),
        }
    )
    frame = frame.dropna(subset=["open", "high", "low", "close"]).copy()
    frame = frame.sort_values("ts").drop_duplicates("ts", keep="last")
    return frame.reset_index(drop=True)


def quality_checks(frame: pd.DataFrame) -> list[dict]:
    checks: list[dict] = []
    checks.append(
        {
            "check_name": "non_empty",
            "status": "pass" if len(frame) > 0 else "fail",
            "observed": float(len(frame)),
            "expected": {"min_rows": 1},
        }
    )
    if frame.empty:
        return checks

    bad_ohlc = (
        (frame["high"] < frame[["open", "close", "low"]].max(axis=1))
        | (frame["low"] > frame[["open", "close", "high"]].min(axis=1))
    ).sum()
    checks.append(
        {
            "check_name": "ohlc_consistency",
            "status": "pass" if bad_ohlc == 0 else "fail",
            "observed": float(bad_ohlc),
            "expected": {"bad_rows": 0},
        }
    )

    duplicate_ts = int(frame["ts"].duplicated().sum())
    checks.append(
        {
            "check_name": "unique_timestamp",
            "status": "pass" if duplicate_ts == 0 else "fail",
            "observed": float(duplicate_ts),
            "expected": {"duplicates": 0},
        }
    )
    return checks


def to_market_rows(frame: pd.DataFrame, symbol: str, interval: str, provider: str) -> list[dict]:
    rows: list[dict] = []
    for row in frame.itertuples(index=False):
        rows.append(
            {
                "symbol": symbol,
                "timeframe": interval,
                "ts": row.ts.isoformat(),
                "open": float(row.open),
                "high": float(row.high),
                "low": float(row.low),
                "close": float(row.close),
                "tick_volume": None if pd.isna(row.volume) else float(row.volume),
                "provider": provider,
            }
        )
    return rows


def _interval_delta(interval: str) -> pd.Timedelta:
    if interval.endswith("m") and interval[:-1].isdigit():
        return pd.Timedelta(minutes=int(interval[:-1]))
    if interval.endswith("h") and interval[:-1].isdigit():
        return pd.Timedelta(hours=int(interval[:-1]))
    if interval in {"1d", "1D"}:
        return pd.Timedelta(days=1)
    return pd.Timedelta(0)


def to_feature_rows(frame: pd.DataFrame, symbol: str, interval: str) -> list[dict]:
    enriched = add_features(frame.copy())
    available_delta = _interval_delta(interval)
    fields = [
        "ret_1",
        "ret_3",
        "ret_5",
        "ret_15",
        "ret_30",
        "ret_60",
        "vol_3",
        "vol_5",
        "vol_15",
        "vol_30",
        "vol_60",
        "wt_delta",
    ]
    rows: list[dict] = []
    for row in enriched.itertuples(index=False):
        if pd.isna(row.close):
            continue
        signal = "BUY" if row.wt_cross_up == 1 else "SELL" if row.wt_cross_down == 1 else None
        extra: dict[str, float | None] = {}
        for field in fields:
            value = getattr(row, field)
            extra[field] = None if pd.isna(value) else float(value)
        rows.append(
            {
                "symbol": symbol,
                "ts": row.ts.isoformat(),
                "feature_set_version": FEATURE_SET_VERSION,
                "close": float(row.close),
                "rsi": None if pd.isna(row.rsi) else float(row.rsi),
                "atr": None if pd.isna(row.atr) else float(row.atr),
                "wt1": None if pd.isna(row.wt1) else float(row.wt1),
                "wt2": None if pd.isna(row.wt2) else float(row.wt2),
                "squeeze": None if pd.isna(row.squeeze) else float(row.squeeze),
                "rule_signal": signal,
                "features": extra,
                "available_at": (row.ts + available_delta).isoformat(),
            }
        )
    return rows


def _chunks(items: list[dict], size: int = 500) -> Iterable[list[dict]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def upsert_supabase(rows: list[dict], table: str, on_conflict: str) -> int:
    if not rows:
        return 0
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --write-supabase")

    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    written = 0
    for batch in _chunks(rows):
        endpoint = f"{url.rstrip('/')}/rest/v1/{table}?on_conflict={on_conflict}"
        response = requests.post(endpoint, headers=headers, json=batch, timeout=60)
        response.raise_for_status()
        written += len(batch)
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description="Bootstrap public gold market data")
    parser.add_argument("--symbol", default="GC=F")
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--range", dest="range_", default="7d")
    parser.add_argument("--out", default="data/public/gc_f_bootstrap.csv")
    parser.add_argument("--write-supabase", action="store_true")
    args = parser.parse_args()

    request = YahooRequest(symbol=args.symbol, interval=args.interval, range_=args.range_)
    frame = fetch_yahoo_chart(request)
    checks = quality_checks(frame)
    failed = [c for c in checks if c["status"] == "fail"]
    if failed:
        raise SystemExit(f"Data quality failed: {failed}")

    out = args.out
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    frame.to_csv(out, index=False)
    print(f"[{datetime.now(timezone.utc).isoformat()}] rows={len(frame)} wrote={out}")

    if args.write_supabase:
        market_rows = to_market_rows(frame, symbol=args.symbol, interval=args.interval, provider="yahoo_chart")
        feature_rows = to_feature_rows(frame, symbol=args.symbol, interval=args.interval)
        market_written = upsert_supabase(
            market_rows,
            table="market_bars",
            on_conflict="symbol,timeframe,ts,provider",
        )
        feature_written = upsert_supabase(
            feature_rows,
            table="gold_market_features",
            on_conflict="symbol,ts,feature_set_version",
        )
        print(f"supabase_market_rows={market_written} supabase_feature_rows={feature_written}")


if __name__ == "__main__":
    main()
