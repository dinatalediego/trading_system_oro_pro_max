from __future__ import annotations
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from .features import add_features, directional_label
from .backtest import vector_backtest, summary

FEATURES = ["ret_1","ret_3","ret_5","ret_15","ret_30","vol_5","vol_15","vol_30","rsi","atr","wt1","wt2","wt_delta","squeeze","minute_sin","minute_cos"]


def fit_walk_forward(df: pd.DataFrame, artifact_dir: str = "artifacts/baseline", horizon: int = 15) -> dict:
    x = add_features(df)
    x["target3"] = directional_label(x, horizon=horizon)
    x = x.replace([np.inf, -np.inf], np.nan).dropna(subset=FEATURES + ["target3"]).copy()
    # Baseline predicts UP vs not-UP only. SELL model can be split later; this avoids pretending neutral labels are shorts.
    x["y"] = (x.target3 == 1).astype(int)
    split = int(len(x) * 0.80)
    train, test = x.iloc[:split], x.iloc[split:]
    base = Pipeline([("scale", StandardScaler()), ("clf", LogisticRegression(max_iter=2000, class_weight="balanced"))])
    model = CalibratedClassifierCV(base, method="sigmoid", cv=3)
    model.fit(train[FEATURES], train.y)
    p = model.predict_proba(test[FEATURES])[:, 1]
    metrics = {"rows_train": len(train), "rows_test": len(test), "brier": float(brier_score_loss(test.y, p)), "log_loss": float(log_loss(test.y, p)), "auc": float(roc_auc_score(test.y, p)) if test.y.nunique() > 1 else None}
    bt = vector_backtest(test.close, p, horizon=horizon)
    metrics["backtest"] = summary(bt)
    out = Path(artifact_dir); out.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "features": FEATURES, "horizon": horizon}, out / "model.joblib")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2))
    return metrics
