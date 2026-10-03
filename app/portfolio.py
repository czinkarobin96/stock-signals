"""Portfolio-level strategies on the S&P 500 universe.

Rules are fixed a priori from the literature (not tuned on this data):
  * cross-sectional momentum: rank by 12-1 month return, hold the top 10-20%
  * regime filter: invested only while SPY closes above its 200-day average
  * risk sizing: inverse-volatility weights + 15% portfolio volatility target
Monthly rebalance at the month-end close, trades take effect the next day,
10 bps cost per unit of traded notional.
"""
from typing import Callable, Dict

import numpy as np
import pandas as pd

TD = 252
COST = 0.001
MIN_ELIG = 100
SKIP = 21


def _eq(r: np.ndarray) -> dict:
    r = r[~np.isnan(r)]
    eq = np.cumprod(1 + r)
    dd = (eq / np.maximum.accumulate(eq) - 1).min()
    sd = r.std(ddof=1)
    yrs = len(r) / TD
    return {"total": float(eq[-1] - 1), "cagr": float(eq[-1] ** (1 / yrs) - 1), "maxdd": float(dd),
            "vol": float(sd * np.sqrt(TD)), "sharpe": float(r.mean() / sd * np.sqrt(TD)) if sd > 0 else 0.0}


def _alpha(y: np.ndarray, x: np.ndarray, lag: int = 5) -> dict:
    """OLS alpha/beta vs SPY with a Newey-West (HAC) standard error for alpha."""
    X = np.column_stack([np.ones(len(x)), x])
    XtXi = np.linalg.inv(X.T @ X)
    b = XtXi @ X.T @ y
    u = y - X @ b
    S = (X * u[:, None]).T @ (X * u[:, None])
    for l in range(1, lag + 1):
        G = (X[l:] * u[l:, None]).T @ (X[:-l] * u[:-l, None])
        S += (1 - l / (lag + 1)) * (G + G.T)
    V = XtXi @ S @ XtXi
    return {"alpha": float(b[0] * TD), "beta": float(b[1]), "alpha_t": float(b[0] / np.sqrt(V[0, 0]))}


class Panel:
    def __init__(self, ds):
        self.ds = ds
        T, N = ds.T, ds.N
        C = np.full((T, N), np.nan)
        for k, s in enumerate(ds.syms):
            C[ds.pos[s], k] = ds.prep[s].C
        self.T, self.N, self.C = T, N, C
        Cdf = pd.DataFrame(C)
        R = (Cdf / Cdf.shift(1) - 1)
        self.R = np.nan_to_num(R.to_numpy())
        self.V = R.rolling(60).std().to_numpy()
        self.M = {lb: (Cdf.shift(SKIP) / Cdf.shift(lb) - 1).to_numpy() for lb in (126, 189, 252)}
        spy = np.full(T, np.nan)
        spy[ds.pos["SPY"]] = ds.prep["SPY"].C
        spy = pd.Series(spy).ffill()
        # robustness: only names already trading when the sample starts (drops later IPOs,
        # many of which entered the index *because* they had risen a lot)
        self.colmask = np.isfinite(C[0])
        self.spy_r = np.nan_to_num((spy / spy.shift(1) - 1).to_numpy())
        self.spy_on = (spy > spy.rolling(200).mean()).to_numpy()
        elig = np.isfinite(self.M[252]).sum(axis=1)
        self.s0 = int(np.argmax((elig >= MIN_ELIG) & ~np.isnan(spy.rolling(200).mean().to_numpy())))
        idx = ds.idx
        self.month_end = np.zeros(T, bool)
        m = idx.to_period("M")
        self.month_end[:-1] = m[1:] != m[:-1]

    def select(self, t, kind, frac, lb, invvol, vol_target, fullhist=False):
        w = np.zeros(self.N)
        m = self.M[lb][t]
        ok = np.isfinite(m) & np.isfinite(self.V[t])
        if fullhist:
            ok &= self.colmask
        elig = np.where(ok)[0]
        if len(elig) < 50:
            return w
        if kind == "ew":
            sel = elig
        else:
            k = max(1, int(round(frac * len(elig))))
            sel = elig[np.argsort(-m[elig])[:k]]
        if invvol:
            iv = 1.0 / self.V[t][sel]
            w[sel] = iv / iv.sum()
        else:
            w[sel] = 1.0 / len(sel)
        if vol_target:
            pv = (self.R[t - 59: t + 1][:, sel] @ w[sel]).std(ddof=1) * np.sqrt(TD)
            if pv > 0:
                w *= min(1.0, vol_target / pv)
        return w

    def run(self, kind="mom", frac=0.2, lb=252, regime=False, invvol=False, vol_target=None, fullhist=False):
        T = self.T
        w = np.zeros(self.N)
        out = np.zeros(T); expo = np.zeros(T)
        traded = 0.0
        for t in range(self.s0, T - 1):
            on = (not regime) or bool(self.spy_on[t])
            cost = 0.0
            if regime and not on and w.sum() > 0:
                cost += w.sum() * COST; traded += w.sum(); w = np.zeros(self.N)
            if on and (self.month_end[t] or w.sum() == 0):
                wn = self.select(t, kind, frac, lb, invvol, vol_target, fullhist)
                d = np.abs(wn - w).sum()
                cost += d * COST; traded += d; w = wn
            rt = self.R[t + 1]
            rg = float(w @ rt)
            out[t + 1] = rg - cost
            if w.sum() > 0:
                w = w * (1 + rt) / (1 + rg)
            expo[t + 1] = w.sum()
        return out, expo, traded

    def spy_series(self, regime):
        out = np.zeros(self.T); traded = 0.0; prev = 0.0
        for t in range(self.s0, self.T - 1):
            on = 1.0 if (not regime or self.spy_on[t]) else 0.0
            cost = abs(on - prev) * COST if t > self.s0 else on * COST
            traded += abs(on - prev); prev = on
            out[t + 1] = on * self.spy_r[t + 1] - cost
        return out


STRATS = [
    ("ew", "Univerzum egyenlő súllyal (havi újrasúlyozás)", dict(kind="ew")),
    ("spy", "SPY (vásárlás és tartás)", None),
    ("spy_regime", "SPY + rezsim-szűrő (200 napos átlag)", None),
    ("mom20", "Momentum: felső 20%", dict(kind="mom", frac=0.2)),
    ("mom10", "Momentum: felső 10%", dict(kind="mom", frac=0.1)),
    ("mom20_regime", "Momentum 20% + rezsim-szűrő", dict(kind="mom", frac=0.2, regime=True)),
    ("mom20_full", "Momentum 20% + rezsim + inverz-vol súly + 15% vol-cél",
     dict(kind="mom", frac=0.2, regime=True, invvol=True, vol_target=0.15)),
    # robustness check against index-addition (survivorship) bias
    ("ew_fh", "Kontroll: egyenlő súly, csak 2018 előtt is jegyzett", dict(kind="ew", fullhist=True)),
    ("mom10_fh", "Kontroll: Momentum 10%, csak 2018 előtt is jegyzett", dict(kind="mom", frac=0.1, fullhist=True)),
    ("mom20_fh", "Kontroll: Momentum 20%, csak 2018 előtt is jegyzett", dict(kind="mom", frac=0.2, fullhist=True)),
    ("mom20_regime_fh", "Kontroll: Momentum 20% + rezsim, csak 2018 előtt is jegyzett",
     dict(kind="mom", frac=0.2, regime=True, fullhist=True)),
]


def research(ds, progress: Callable) -> dict:
    P = Panel(ds)
    s0, T = P.s0, P.T
    dates = ds.idx[s0 + 1:]
    spy_ret = P.spy_r[s0 + 1:]
    half = len(dates) // 2
    series: Dict[str, dict] = {}
    for key, label, kw in STRATS:
        if key == "spy":
            r, expo, traded = P.spy_r.copy(), np.ones(T), 0.0
            r[: s0 + 1] = 0
        elif key == "spy_regime":
            r = P.spy_series(True); expo = np.where(P.spy_on, 1.0, 0.0); traded = float(np.abs(np.diff(expo[s0:])).sum())
        else:
            r, expo, traded = P.run(**kw)
        series[key] = {"label": label, "r": r[s0 + 1:], "expo": expo[s0 + 1:], "traded": traded}
        progress(None, f"Portfólió: {label}")
    out = {"period": [dates[0].strftime("%Y-%m-%d"), dates[-1].strftime("%Y-%m-%d")],
           "mid_date": dates[half].strftime("%Y-%m-%d"), "strategies": []}
    curves, dds = {}, {}
    for key, label, _ in STRATS:
        s = series[key]; r = s["r"]
        eq = np.cumprod(1 + r)
        row = {"key": key, "label": label, **_eq(r),
               "half1": _eq(r[:half]), "half2": _eq(r[half:]),
               "exposure": float(s["expo"].mean()),
               "turnover": float(s["traded"] / (len(r) / TD))}
        row.update(_alpha(r, spy_ret) if key != "spy" else {"alpha": 0.0, "beta": 1.0, "alpha_t": 0.0})
        ser = pd.Series(r, index=dates)
        row["yearly"] = {str(y): float((1 + g).prod() - 1) for y, g in ser.groupby(ser.index.year)}
        out["strategies"].append(row)
        step = 2
        keep = sorted(set(range(0, len(eq), step)) | {len(eq) - 1})
        curves[key] = [{"time": dates[i].strftime("%Y-%m-%d"), "value": round(float(eq[i] * 100), 2)} for i in keep]
        dd = eq / np.maximum.accumulate(eq) - 1
        dds[key] = [{"time": dates[i].strftime("%Y-%m-%d"), "value": round(float(dd[i] * 100), 2)} for i in keep]
    out["curves"], out["drawdowns"] = curves, dds
    # sensitivity of the (untuned) momentum rule to its two main knobs
    grid = []
    for regime in (False, True):
        for lb in (126, 189, 252):
            for frac in (0.1, 0.2, 0.3):
                r, _, _ = P.run(kind="mom", frac=frac, lb=lb, regime=regime)
                e = _eq(r[s0 + 1:])
                grid.append({"regime": regime, "lookback": lb, "frac": frac, "cagr": e["cagr"],
                             "sharpe": e["sharpe"], "maxdd": e["maxdd"]})
        progress(None, "Portfólió: érzékenységi vizsgálat")
    out["sensitivity"] = grid
    return out
