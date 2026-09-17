import numpy as np
import pandas as pd
from goldlab.features import add_features, directional_label


def sample(n=220):
    ts = pd.date_range('2026-01-01', periods=n, freq='min', tz='UTC')
    close = pd.Series(4300 + np.sin(np.arange(n)/9)*5 + np.arange(n)*0.02)
    return pd.DataFrame({'ts':ts,'open':close.shift(1).fillna(close),'high':close+1,'low':close-1,'close':close})


def test_features_are_point_in_time_shape_preserving():
    x = add_features(sample())
    assert len(x) == 220
    assert {'rsi','wt1','wt2','squeeze','atr'}.issubset(x.columns)
    assert x.rsi.dropna().between(0,100).all()


def test_directional_label_has_three_states():
    x = add_features(sample())
    y = directional_label(x, horizon=15)
    assert set(y.unique()).issubset({-1,0,1})
