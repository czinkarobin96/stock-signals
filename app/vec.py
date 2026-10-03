"""Vectorised factors / score and a numba trade simulator for research runs.

Mirrors signals.score / signals.exit_check and backtest.simulate (parity is
asserted in tests/test_parity.py) but is fast enough for 500 symbols x grids.
"""
import numpy as np
import pandas as pd
from numba import njit

from .indicators import enrich

WARMUP = 210
SLIP = 0.0005
MAX_HOLD = 60

REASONS = {1: "stop", 2: "célár", 3: "időkorlát", 4: "stop (zárás)", 5: "trendtörés",
           6: "célár (zárás)", 7: "RSI túlvett", 8: "nyitott (adatvége)"}


def prepare(ohlcv: pd.DataFrame) -> pd.DataFrame:
    return enrich(ohlcv)


def factors(df: pd.DataFrame) -> dict:
    """Boolean factor series. First block = components of the live score; second
    block = candidate ideas that are NOT in the live score (to test for edge)."""
    C, rsi, h = df["Close"], df["rsi"], df["macd_hist"]
    brk = C > df["high20"]
    f = {
        "trend_short": C > df["ema50"],
        "trend_long": df["ema50"] > df["ema200"],
        "rsi_rising": (rsi >= 45) & (rsi <= 68) & (rsi > rsi.shift()),
        "rsi_overbought": rsi > 75,
        "rsi_oversold": rsi < 30,
        "macd_up": (h > 0) & (h > h.shift()),
        "macd_down": (h < 0) & (h < h.shift()),
        "breakout20": brk,
        "breakout_vol": brk & (df["Volume"] > 1.5 * df["vol_avg20"]),
        "below_both": (C < df["ema50"]) & (C < df["ema200"]),
        # candidates
        "pullback_uptrend": (df["ema50"] > df["ema200"]) & (C < df["ema20"]) & (C > df["ema50"]) & (rsi < 50),
        "oversold_uptrend": (rsi < 35) & (C > df["ema200"]),
        "mom_6m": (C / C.shift(126) - 1) > 0.20,
        "near_52w_high": C >= 0.95 * df["High"].rolling(252).max(),
    }
    return {k: v.fillna(False).to_numpy(dtype=bool) for k, v in f.items()}


def score_series(df: pd.DataFrame) -> np.ndarray:
    """Vectorised equivalent of signals.score()['score'] for every bar."""
    f = factors(df)
    pts = f["trend_short"].astype(int) + f["trend_long"] + f["rsi_rising"]
    pts = pts - (f["rsi_overbought"] & ~f["rsi_rising"]) + f["macd_up"] - (f["macd_down"] & ~f["macd_up"])
    pts = pts + f["breakout20"] + f["breakout_vol"] - f["below_both"]
    return np.asarray(pts, dtype=np.int64)


@njit(cache=True)
def _sim(O, H, L, C, atr, ema50, macdh, rsi, score, start, thr, stop_atr, target_atr,
         trail_atr, max_hold, slip):
    n = len(C)
    r = np.zeros(n)
    cap = n // 2 + 2
    t_entry = np.empty(cap, np.int64)
    t_exit = np.empty(cap, np.int64)
    t_ret = np.empty(cap)
    t_why = np.empty(cap, np.int64)
    nt = 0
    in_pos = False
    pend_entry = False
    pend_exit = False
    ref = 0.0
    entry_px = 0.0
    entry_i = 0
    run_hi = -1e18
    why = 0
    for j in range(start, n):
        exited = False
        if in_pos and pend_exit:
            px = O[j] * (1 - slip)
            r[j] = px / ref - 1
            t_entry[nt] = entry_i; t_exit[nt] = j; t_ret[nt] = px / entry_px - 1; t_why[nt] = why
            nt += 1
            in_pos = False; pend_exit = False; exited = True
        elif pend_entry:
            entry_px = O[j] * (1 + slip)
            entry_i = j
            ref = entry_px
            in_pos = True
            pend_entry = False
            run_hi = -1e18
        if in_pos and not exited:
            hi_prev = run_hi if run_hi > -1e17 else H[j - 1]
            # levels are rounded to cents, exactly like signals.exit_check
            stop = round(max(hi_prev - trail_atr * atr[j - 1], entry_px - stop_atr * atr[j - 1]), 2)
            target = round(entry_px + target_atr * atr[j - 1], 2)
            px = 0.0
            code = 0
            if O[j] <= stop:
                px = O[j]; code = 1
            elif L[j] <= stop:
                px = stop; code = 1
            elif H[j] >= target:
                px = target; code = 2
            if code > 0:
                px = px * (1 - slip)
                r[j] = px / ref - 1
                t_entry[nt] = entry_i; t_exit[nt] = j; t_ret[nt] = px / entry_px - 1; t_why[nt] = code
                nt += 1
                in_pos = False; exited = True
            elif j - entry_i >= max_hold:
                px = C[j] * (1 - slip)
                r[j] = px / ref - 1
                t_entry[nt] = entry_i; t_exit[nt] = j; t_ret[nt] = px / entry_px - 1; t_why[nt] = 3
                nt += 1
                in_pos = False; exited = True
            else:
                r[j] = C[j] / ref - 1
                ref = C[j]
                hi_now = max(run_hi, H[j])
                stop2 = round(max(hi_now - trail_atr * atr[j], entry_px - stop_atr * atr[j]), 2)
                target2 = round(entry_px + target_atr * atr[j], 2)
                if C[j] <= stop2:
                    pend_exit = True; why = 4
                elif C[j] < ema50[j] and macdh[j] < 0:
                    pend_exit = True; why = 5
                elif C[j] >= target2:
                    pend_exit = True; why = 6
                elif rsi[j] > 78:
                    pend_exit = True; why = 7
                run_hi = hi_now
        if (not in_pos) and (not pend_entry) and j + 1 < n:
            if score[j] >= thr:
                pend_entry = True
    if in_pos:
        t_entry[nt] = entry_i; t_exit[nt] = n - 1; t_ret[nt] = C[n - 1] / entry_px - 1; t_why[nt] = 8
        nt += 1
    return r, t_entry[:nt], t_exit[:nt], t_ret[:nt], t_why[:nt]


class Prepared:
    """Per-symbol arrays ready for _sim (computed once, reused across a grid)."""

    def __init__(self, ohlcv: pd.DataFrame):
        df = prepare(ohlcv)
        self.index = df.index
        self.O, self.H, self.L, self.C = (df[c].to_numpy(float) for c in ("Open", "High", "Low", "Close"))
        self.atr = df["atr"].to_numpy(float)
        self.ema50 = df["ema50"].to_numpy(float)
        self.macdh = df["macd_hist"].to_numpy(float)
        self.rsi = df["rsi"].to_numpy(float)
        self.score = score_series(df)
        self.df = df

    def sim(self, thr=4, stop_atr=2.0, target_atr=3.0, trail_atr=2.5, max_hold=MAX_HOLD, slip=SLIP):
        return _sim(self.O, self.H, self.L, self.C, self.atr, self.ema50, self.macdh, self.rsi,
                    self.score, WARMUP, thr, stop_atr, target_atr, trail_atr, max_hold, slip)
