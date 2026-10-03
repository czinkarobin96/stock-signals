"""Research runs on the S&P 500: factor edge test, universe backtest, walk-forward."""
import itertools
import json
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np
import pandas as pd

from . import universe, vec

OUT = Path(__file__).resolve().parent.parent / "data" / "research.json"
HORIZONS = (5, 10, 20)
TD = 252
MIN_ALIVE = 100

FACTOR_INFO = {
    "trend_short": ("Ár > EMA50", True),
    "trend_long": ("EMA50 > EMA200", True),
    "rsi_rising": ("RSI 45–68 és emelkedő", True),
    "rsi_overbought": ("RSI > 75 (túlvett)", True),
    "rsi_oversold": ("RSI < 30 (túladott)", True),
    "macd_up": ("MACD hiszt. pozitív, erősödik", True),
    "macd_down": ("MACD hiszt. negatív, gyengül", True),
    "breakout20": ("20 napos csúcs kitörés", True),
    "breakout_vol": ("Kitörés + 1,5× forgalom", True),
    "below_both": ("Ár EMA50 és EMA200 alatt", True),
    "pullback_uptrend": ("Visszahúzódás emelkedő trendben", False),
    "oversold_uptrend": ("RSI<35 emelkedő trendben", False),
    "mom_6m": ("6 hónapos momentum > 20%", False),
    "near_52w_high": ("52 hetes csúcs közelében", False),
    "score_ge3": ("Összpontszám ≥ 3", True),
    "score_ge4": ("Összpontszám ≥ 4 (BUY)", True),
    "score_ge5": ("Összpontszám ≥ 5", True),
}

JOB: Dict = {"status": "idle", "progress": 0.0, "message": "", "result": None, "started": None}


# ---------------------------------------------------------------- helpers
def _sharpe(r: np.ndarray) -> float:
    r = r[~np.isnan(r)]
    sd = r.std(ddof=1) if len(r) > 2 else 0
    return float(r.mean() / sd * np.sqrt(TD)) if sd > 0 else 0.0


def _eq_stats(r: np.ndarray) -> dict:
    r = r[~np.isnan(r)]
    if len(r) < 2:
        return {"total": 0.0, "cagr": 0.0, "maxdd": 0.0, "sharpe": 0.0}
    eq = np.cumprod(1 + r)
    dd = (eq / np.maximum.accumulate(eq) - 1).min()
    yrs = len(r) / TD
    return {"total": float(eq[-1] - 1), "cagr": float(eq[-1] ** (1 / yrs) - 1),
            "maxdd": float(dd), "sharpe": _sharpe(r)}


def _trade_stats(ret: np.ndarray) -> dict:
    if len(ret) == 0:
        return {"n": 0, "win_rate": 0.0, "avg": 0.0, "avg_win": 0.0, "avg_loss": 0.0, "profit_factor": None}
    w, l = ret[ret > 0], ret[ret <= 0]
    return {"n": int(len(ret)), "win_rate": float((ret > 0).mean()), "avg": float(ret.mean()),
            "avg_win": float(w.mean()) if len(w) else 0.0, "avg_loss": float(l.mean()) if len(l) else 0.0,
            "profit_factor": float(w.sum() / -l.sum()) if l.sum() < 0 else None}


def _curve(dates, r: np.ndarray, every: int = 2) -> list:
    eq = np.cumprod(1 + np.nan_to_num(r)) * 100
    keep = sorted(set(range(0, len(eq), every)) | {len(eq) - 1})
    return [{"time": dates[i].strftime("%Y-%m-%d"), "value": round(float(eq[i]), 2)} for i in keep]


# ---------------------------------------------------------------- dataset
class Dataset:
    def __init__(self, prepared: Dict[str, vec.Prepared]):
        self.syms = [s for s in prepared if s != "SPY"]
        self.prep = prepared
        self.idx = sorted(set().union(*[set(p.index) for p in prepared.values()]))
        self.idx = pd.DatetimeIndex(self.idx)
        self.T, self.N = len(self.idx), len(self.syms)
        self.pos = {s: self.idx.get_indexer(prepared[s].index) for s in prepared}
        alive = np.zeros(self.T)
        bh = np.zeros(self.T)
        for s in self.syms:
            p, pos = prepared[s], self.pos[s]
            alive[pos[vec.WARMUP:]] += 1
            ret = np.zeros(len(p.C))
            ret[1:] = p.C[1:] / p.C[:-1] - 1
            bh[pos[vec.WARMUP:]] += ret[vec.WARMUP:]
        self.alive = alive
        self.valid = alive >= min(MIN_ALIVE, int(0.6 * self.N))
        with np.errstate(invalid="ignore", divide="ignore"):
            self.bh = np.where(self.valid, bh / np.maximum(alive, 1), np.nan)
        spy = prepared["SPY"]
        sr = np.zeros(len(spy.C)); sr[1:] = spy.C[1:] / spy.C[:-1] - 1
        self.spy = np.full(self.T, np.nan); self.spy[self.pos["SPY"]] = sr
        self.spy[~self.valid] = np.nan


# ---------------------------------------------------------------- 1) factors
def factor_analysis(ds: Dataset, progress: Callable) -> dict:
    T, N = ds.T, ds.N
    panels = {k: np.zeros((T, N), bool) for k in FACTOR_INFO}
    fwd = {h: np.full((T, N), np.nan) for h in HORIZONS}
    for k, s in enumerate(ds.syms):
        p, pos = ds.prep[s], ds.pos[s]
        f = vec.factors(p.df)
        for name, arr in f.items():
            a = arr.copy(); a[:vec.WARMUP] = False
            panels[name][pos, k] = a
        for thr in (3, 4, 5):
            a = p.score >= thr; a[:vec.WARMUP] = False
            panels[f"score_ge{thr}"][pos, k] = a
        n = len(p.C)
        for h in HORIZONS:
            v = np.full(n, np.nan)
            v[: n - h] = p.C[h:] / p.O[1: n - h + 1] - 1 - 2 * vec.SLIP
            fwd[h][pos, k] = v
    out = {}
    for h in HORIZONS:
        fw = fwd[h]
        with np.errstate(all="ignore"):
            mkt = np.nanmean(fw, axis=1)
        ex = fw - mkt[:, None]
        okfw = ~np.isnan(fw)
        base = {"avg": float(np.nanmean(fw)), "win_rate": float((fw[okfw] > 0).mean())}
        rows = []
        for name, F in panels.items():
            m = F & okfw
            n_ev = int(m.sum())
            if n_ev < 300:
                continue
            cnt = m.sum(axis=1)
            sm = np.where(m, ex, 0.0).sum(axis=1)
            dates_ok = np.where(cnt > 0)[0]
            dm = sm[dates_ok] / cnt[dates_ok]
            half = len(dm) // 2
            se = dm.std(ddof=1) / np.sqrt(len(dm) / h)  # overlapping windows -> fewer independent obs
            t = float(dm.mean() / se) if se > 0 else 0.0
            a, b = float(dm[:half].mean()), float(dm[half:].mean())
            sign = np.sign(dm.mean())
            if abs(t) >= 2 and np.sign(a) == sign and np.sign(b) == sign:
                verdict = "positive" if sign > 0 else "negative"
            elif abs(t) >= 2:
                verdict = "unstable"
            else:
                verdict = "none"
            vals = fw[m]
            rows.append({"name": name, "label": FACTOR_INFO[name][0], "in_score": FACTOR_INFO[name][1],
                         "n": n_ev, "avg": float(vals.mean()), "win_rate": float((vals > 0).mean()),
                         "excess": float(dm.mean()), "t": t, "half1": a, "half2": b, "verdict": verdict})
        rows.sort(key=lambda r: r["t"], reverse=True)
        out[str(h)] = {"baseline": base, "rows": rows}
        progress(None, f"Tényezők kiértékelve ({h} napos horizont)")
    return out


# ---------------------------------------------------------------- portfolio sims
def sim_all(ds: Dataset, **params) -> dict:
    P = np.zeros(ds.T)
    held = 0
    t_sym, t_entry, t_ret = [], [], []
    for k, s in enumerate(ds.syms):
        p, pos = ds.prep[s], ds.pos[s]
        r, ei, xi, ret, why = p.sim(**params)
        P[pos] += r
        held += int((xi - ei + 1).sum())
        t_entry.append(pos[ei]); t_ret.append(ret)
    with np.errstate(invalid="ignore", divide="ignore"):
        R = np.where(ds.valid, P / np.maximum(ds.alive, 1), np.nan)
    return {"R": R, "entry": np.concatenate(t_entry), "ret": np.concatenate(t_ret),
            "exposure": held / max(ds.alive.sum(), 1)}


def _section(ds, sim, lo, hi) -> dict:
    sel = (sim["entry"] >= lo) & (sim["entry"] < hi)
    return {"equity": _eq_stats(sim["R"][lo:hi]), "trades": _trade_stats(sim["ret"][sel])}


# ---------------------------------------------------------------- 2) universe backtest
def universe_backtest(ds: Dataset, progress: Callable) -> dict:
    vi = np.where(ds.valid)[0]
    v0, v1 = vi[0], vi[-1] + 1
    cut = v0 + int((v1 - v0) * 0.6)
    res = {"period": [ds.idx[v0].strftime("%Y-%m-%d"), ds.idx[v1 - 1].strftime("%Y-%m-%d")],
           "split_date": ds.idx[cut].strftime("%Y-%m-%d"), "n_symbols": ds.N, "thresholds": []}
    curves = {}
    for thr in (3, 4, 5):
        sim = sim_all(ds, thr=thr)
        res["thresholds"].append({
            "threshold": thr, "exposure": float(sim["exposure"]),
            "all": _section(ds, sim, v0, v1), "in_sample": _section(ds, sim, v0, cut),
            "out_of_sample": _section(ds, sim, cut, v1),
        })
        if thr == 4:
            curves["strategy"] = _curve(ds.idx[v0:v1], sim["R"][v0:v1])
            yr = pd.Series(sim["R"][v0:v1], index=ds.idx[v0:v1])
            years = {}
            for name, arr in (("strategy", sim["R"]), ("buyhold", ds.bh), ("spy", ds.spy)):
                s = pd.Series(arr[v0:v1], index=ds.idx[v0:v1]).fillna(0)
                years[name] = {str(y): float((1 + g).prod() - 1) for y, g in s.groupby(s.index.year)}
            res["yearly"] = years
        progress(None, f"Univerzum-backtest: küszöb ≥ {thr} kész")
    curves["buyhold"] = _curve(ds.idx[v0:v1], ds.bh[v0:v1])
    curves["spy"] = _curve(ds.idx[v0:v1], ds.spy[v0:v1])
    res["curves"] = curves
    res["benchmark"] = {"buyhold": _eq_stats(ds.bh[v0:v1]), "spy": _eq_stats(ds.spy[v0:v1])}
    return res


# ---------------------------------------------------------------- 3) walk-forward
GRID = {"thr": (3, 4, 5), "stop_atr": (1.5, 2.0, 3.0), "target_atr": (2.0, 3.0, 5.0)}
DEFAULT = (4, 2.0, 3.0)
TRAIN, TEST = 504, 126


def walk_forward(ds: Dataset, progress: Callable) -> dict:
    combos = list(itertools.product(*GRID.values()))
    sims = {}
    for i, c in enumerate(combos):
        sims[c] = sim_all(ds, thr=c[0], stop_atr=c[1], target_atr=c[2])
        if i % 5 == 0:
            progress(None, f"Walk-forward: paraméter-rács {i + 1}/{len(combos)}")
    vi = np.where(ds.valid)[0]
    v0, v1 = vi[0], vi[-1] + 1
    folds, start = [], v0
    while start + TRAIN + TEST <= v1:
        folds.append((start, start + TRAIN, start + TRAIN + TEST))
        start += TEST
    if not folds:
        return {"error": "Nincs elég adat a walk-forwardhoz"}
    rows, oos, oos_def, oos_bh, oos_spy, oos_trades, dates = [], [], [], [], [], [], []
    for (a, b, c) in folds:
        best, best_s = None, -9
        for cb in combos:
            sim = sims[cb]
            n_tr = int(((sim["entry"] >= a) & (sim["entry"] < b)).sum())
            if n_tr < 150:
                continue
            sh = _sharpe(sim["R"][a:b])
            if sh > best_s:
                best, best_s = cb, sh
        sim = sims[best]
        oos.append(sim["R"][b:c]); oos_def.append(sims[DEFAULT]["R"][b:c])
        oos_bh.append(ds.bh[b:c]); oos_spy.append(ds.spy[b:c]); dates.append(ds.idx[b:c])
        sel = (sim["entry"] >= b) & (sim["entry"] < c)
        oos_trades.append(sim["ret"][sel])
        rows.append({
            "train": [ds.idx[a].strftime("%Y-%m-%d"), ds.idx[b - 1].strftime("%Y-%m-%d")],
            "test": [ds.idx[b].strftime("%Y-%m-%d"), ds.idx[c - 1].strftime("%Y-%m-%d")],
            "params": {"thr": best[0], "stop_atr": best[1], "target_atr": best[2]},
            "train_sharpe": best_s,
            "test_return": _eq_stats(sim["R"][b:c])["total"],
            "default_return": _eq_stats(sims[DEFAULT]["R"][b:c])["total"],
            "buyhold_return": _eq_stats(ds.bh[b:c])["total"],
        })
    R, Rd, Rb, Rs = (np.concatenate(x) for x in (oos, oos_def, oos_bh, oos_spy))
    D = pd.DatetimeIndex(np.concatenate([d.values for d in dates]))
    # how do ALL combos do over the whole out-of-sample span?
    o0, o1 = folds[0][1], folds[-1][2]
    span = []
    for cb in combos:
        e = _eq_stats(sims[cb]["R"][o0:o1])
        span.append({"params": {"thr": cb[0], "stop_atr": cb[1], "target_atr": cb[2]}, **e})
    bh_span = _eq_stats(ds.bh[o0:o1])
    return {
        "n_folds": len(folds), "n_combos": len(combos), "train_bars": TRAIN, "test_bars": TEST,
        "oos_period": [ds.idx[o0].strftime("%Y-%m-%d"), ds.idx[o1 - 1].strftime("%Y-%m-%d")],
        "selected": {"equity": _eq_stats(R), "trades": _trade_stats(np.concatenate(oos_trades))},
        "default": {"equity": _eq_stats(Rd)},
        "buyhold": _eq_stats(Rb), "spy": _eq_stats(Rs),
        "folds": rows,
        "curves": {"selected": _curve(D, R, 1), "default": _curve(D, Rd, 1),
                   "buyhold": _curve(D, Rb, 1), "spy": _curve(D, Rs, 1)},
        "grid_span": {
            "bh_total": bh_span["total"], "bh_sharpe": bh_span["sharpe"],
            "n_positive": int(sum(1 for x in span if x["total"] > 0)),
            "n_beat_bh_sharpe": int(sum(1 for x in span if x["sharpe"] > bh_span["sharpe"])),
            "totals": sorted(x["total"] for x in span),
            "best": max(span, key=lambda x: x["sharpe"]), "worst": min(span, key=lambda x: x["sharpe"]),
        },
    }


# ---------------------------------------------------------------- job runner
def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if (np.isnan(o) or np.isinf(o)) else float(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def _set(frac: Optional[float], msg: str) -> None:
    if frac is not None:
        JOB["progress"] = round(frac, 3)
    JOB["message"] = msg


def run_all(sample: Optional[int] = None) -> None:
    try:
        JOB.update(status="running", progress=0.0, message="Univerzum betöltése…", started=time.time(), result=None)
        syms = universe.sp500()
        if sample:
            syms = syms[:sample]
        syms = sorted(set(syms) | {"SPY"})
        prices = universe.load_prices(syms, 8, lambda f, m: _set(0.02 + 0.4 * f, m))
        _set(0.45, f"Indikátorok számítása ({len(prices)} ticker)…")
        prepared = {s: vec.Prepared(d) for s, d in prices.items()}
        ds = Dataset(prepared)
        _set(0.55, "1/3 Tényezők kiértékelése…")
        factors = factor_analysis(ds, lambda f, m: _set(None, m))
        _set(0.7, "2/3 Univerzum-backtest…")
        uni = universe_backtest(ds, lambda f, m: _set(None, m))
        _set(0.8, "3/3 Walk-forward…")
        wf = walk_forward(ds, lambda f, m: _set(None, m))
        res = _clean({"generated": time.strftime("%Y-%m-%d %H:%M"), "n_symbols": ds.N,
                      "data_period": [ds.idx[0].strftime("%Y-%m-%d"), ds.idx[-1].strftime("%Y-%m-%d")],
                      "factors": factors, "universe": uni, "walkforward": wf})
        OUT.write_text(json.dumps(res))
        JOB.update(status="done", progress=1.0, message="Kész", result=res)
    except Exception as e:  # surface to the UI
        import traceback
        traceback.print_exc()
        JOB.update(status="error", message=f"{type(e).__name__}: {e}")


def start(sample: Optional[int] = None) -> bool:
    if JOB["status"] == "running":
        return False
    threading.Thread(target=run_all, args=(sample,), daemon=True).start()
    return True


def load_saved() -> None:
    if OUT.exists() and JOB["result"] is None:
        try:
            JOB.update(status="done", progress=1.0, message="Mentett eredmény", result=json.loads(OUT.read_text()))
        except Exception:
            pass
