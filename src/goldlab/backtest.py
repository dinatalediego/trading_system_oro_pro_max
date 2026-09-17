from __future__ import annotations
from dataclasses import dataclass
import numpy as np
import pandas as pd

@dataclass(frozen=True)
class Costs:
    spread_bps: float = 1.0
    slippage_bps: float = 0.5
    commission_bps: float = 0.0


def decisions(prob_up: np.ndarray, long_threshold: float = 0.62, short_threshold: float = 0.38) -> np.ndarray:
    return np.where(prob_up >= long_threshold, 1, np.where(prob_up <= short_threshold, -1, 0))


def vector_backtest(close: pd.Series, prob_up: np.ndarray, horizon: int = 15, costs: Costs = Costs(), long_threshold: float = 0.62, short_threshold: float = 0.38) -> pd.DataFrame:
    side = decisions(prob_up, long_threshold, short_threshold)
    exit_px = close.shift(-horizon).to_numpy()
    entry_px = close.to_numpy()
    gross = side * (exit_px / entry_px - 1)
    one_way = (costs.spread_bps + costs.slippage_bps + costs.commission_bps) / 10_000
    net = np.where(side == 0, 0.0, gross - 2 * one_way)
    out = pd.DataFrame({"close": entry_px, "prob_up": prob_up, "side": side, "gross_return": gross, "net_return": net}, index=close.index)
    out["equity"] = (1 + out["net_return"].fillna(0)).cumprod()
    out["peak"] = out["equity"].cummax()
    out["drawdown"] = out["equity"] / out["peak"] - 1
    return out


def summary(bt: pd.DataFrame) -> dict[str, float]:
    active = bt[bt.side != 0].dropna(subset=["net_return"])
    if active.empty: return {"trades": 0}
    return {
        "trades": int(len(active)),
        "win_rate": float((active.net_return > 0).mean()),
        "mean_return": float(active.net_return.mean()),
        "profit_factor": float(active.loc[active.net_return > 0, "net_return"].sum() / abs(active.loc[active.net_return < 0, "net_return"].sum())) if (active.net_return < 0).any() else float("inf"),
        "max_drawdown": float(bt.drawdown.min()),
        "coverage": float((bt.side != 0).mean()),
    }
