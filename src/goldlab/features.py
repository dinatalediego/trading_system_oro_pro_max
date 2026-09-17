from __future__ import annotations
import numpy as np
import pandas as pd


def _ema(s: pd.Series, span: int) -> pd.Series:
    return s.ewm(span=span, adjust=False, min_periods=span).mean()


def rsi(close: pd.Series, length: int = 14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / length, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / length, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    value = 100 - (100 / (1 + rs))
    value = value.mask((dn == 0) & (up > 0), 100.0)
    value = value.mask((up == 0) & (dn > 0), 0.0)
    value = value.mask((up == 0) & (dn == 0), 50.0)
    return value


def atr(df: pd.DataFrame, length: int = 14) -> pd.Series:
    prev = df["close"].shift(1)
    tr = pd.concat([(df["high"] - df["low"]).abs(), (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / length, adjust=False).mean()


def wavetrend(df: pd.DataFrame, n1: int = 10, n2: int = 21) -> tuple[pd.Series, pd.Series]:
    ap = (df["high"] + df["low"] + df["close"]) / 3
    esa = _ema(ap, n1)
    dev = _ema((ap - esa).abs(), n1)
    ci = (ap - esa) / (0.015 * dev.replace(0, np.nan))
    wt1 = _ema(ci, n2)
    wt2 = wt1.rolling(4).mean()
    return wt1, wt2


def squeeze_momentum(df: pd.DataFrame, length: int = 20, scale: float = 15.0) -> pd.Series:
    # Pine-compatible intent: close minus midpoint of range/SMA, then rolling linear-regression endpoint.
    high_n = df["high"].rolling(length).max()
    low_n = df["low"].rolling(length).min()
    sma = df["close"].rolling(length).mean()
    src = df["close"] - (((high_n + low_n) / 2 + sma) / 2)
    x = np.arange(length, dtype=float)
    x_mean = x.mean()
    denom = ((x - x_mean) ** 2).sum()
    def endpoint(a: np.ndarray) -> float:
        y = np.asarray(a, dtype=float); slope = ((x - x_mean) * (y - y.mean())).sum() / denom
        return float(y.mean() + slope * (x[-1] - x_mean))
    raw = src.rolling(length).apply(endpoint, raw=True)
    scaled = raw.abs() / atr(df, 14).replace(0, np.nan) * scale
    return np.sign(raw) * scaled


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.sort_values("ts").copy()
    out["ret_1"] = np.log(out["close"]).diff()
    for n in (3, 5, 15, 30, 60):
        out[f"ret_{n}"] = np.log(out["close"] / out["close"].shift(n))
        out[f"vol_{n}"] = out["ret_1"].rolling(n).std()
    out["rsi"] = rsi(out["close"])
    out["atr"] = atr(out)
    out["wt1"], out["wt2"] = wavetrend(out)
    out["wt_delta"] = out["wt1"] - out["wt2"]
    out["wt_cross_up"] = ((out["wt_delta"] > 0) & (out["wt_delta"].shift(1) <= 0)).astype(int)
    out["wt_cross_down"] = ((out["wt_delta"] < 0) & (out["wt_delta"].shift(1) >= 0)).astype(int)
    out["squeeze"] = squeeze_momentum(out)
    out["minute_sin"] = np.sin(2 * np.pi * (out["ts"].dt.hour * 60 + out["ts"].dt.minute) / 1440)
    out["minute_cos"] = np.cos(2 * np.pi * (out["ts"].dt.hour * 60 + out["ts"].dt.minute) / 1440)
    if "spread" in out:
        out["spread_atr"] = out["spread"] / out["atr"].replace(0, np.nan)
    return out


def directional_label(df: pd.DataFrame, horizon: int = 15, min_move_atr: float = 0.20) -> pd.Series:
    future = df["close"].shift(-horizon)
    move = future - df["close"]
    threshold = df["atr"] * min_move_atr
    return pd.Series(np.select([move > threshold, move < -threshold], [1, -1], default=0), index=df.index, name="target")
