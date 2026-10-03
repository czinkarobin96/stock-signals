"""Vectorised engine must reproduce the reference (live-code) backtest exactly."""
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
warnings.filterwarnings("ignore")

import numpy as np

from app import backtest, data, vec
from app.signals import score


def test_score_parity():
    df = data.history_long("AAPL", 5)
    s = vec.score_series(df)
    for j in range(250, len(df), 7):
        assert s[j] == score(df.iloc[: j + 1])["score"], f"score mismatch at bar {j}"


def test_trade_parity():
    for sym in ("AAPL", "NVDA", "JPM"):
        df = data.history_long(sym, 5)
        _, ref_trades = backtest.simulate(df, sym, 4)
        p = vec.Prepared(df[["Open", "High", "Low", "Close", "Volume"]])
        _, ei, xi, ret, why = p.sim(4)
        assert len(ei) == len(ref_trades), (sym, len(ei), len(ref_trades))
        ref = sorted(ref_trades, key=lambda t: t["entry_date"])
        for k in range(len(ei)):
            assert p.index[ei[k]].strftime("%Y-%m-%d") == ref[k]["entry_date"]
            assert p.index[xi[k]].strftime("%Y-%m-%d") == ref[k]["exit_date"]
            assert abs(ret[k] - ref[k]["ret"]) < 1e-9


if __name__ == "__main__":
    test_score_parity(); print("score parity OK")
    test_trade_parity(); print("trade parity OK")
