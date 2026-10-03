"""'What to buy now': transparent buckets + what history says about each one.

Buckets are fixed, simple rules (not tuned after looking at results):
  TREND   market (SPY) above EMA200, stock above EMA200 with EMA50>EMA200, and
          cross-sectional momentum rank >= 60th percentile (avg of 6-1m, 12-1m)
  RISK    stock below EMA200 and momentum rank <= 40th percentile
  NEUTRAL everything else
For every bucket we measure realised forward returns of the *same rule* over
the available history, so numbers on the page are observations, not promises.
"""
import json
import math
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from . import research, universe, vec

OUT = Path(__file__).resolve().parent.parent / "data" / "picks.json"
HORIZONS = (21, 63, 126)
TREND, NEUTRAL, RISK = "TREND", "NEUTRAL", "RISK"
MOM_MIN = 0.60
EXT_PCT = 1.12            # >12% above EMA50 counts as extended
RSI_HOT = 75
DRIFT = 0.08              # assumed long-run market return per year (an assumption, not a measurement)
Z80 = 1.2816              # 10th/90th percentile of the normal distribution
STOP_ATR = 3.0            # initial protective stop for a multi-month hold
RISK_PER_TRADE = 0.01     # 1% of portfolio at risk per position
MAX_POS = 0.10
SPEC_VOL = 0.70            # above this annualised volatility a stock is flagged speculative

PICKS: Dict = {"status": "idle", "progress": 0.0, "message": "", "result": None}


class Panels:
    """Date x symbol arrays aligned on the research Dataset's common index."""

    def __init__(self, ds: research.Dataset):
        T, N = ds.T, ds.N
        cols = {"C": "Close", "O": "Open", "ema50": "ema50", "ema200": "ema200", "rsi": "rsi", "atr": "atr", "H": "High"}
        arr = {k: np.full((T, N), np.nan) for k in cols}
        for k, s in enumerate(ds.syms):
            df, pos = ds.prep[s].df, ds.pos[s]
            for n, c in cols.items():
                arr[n][pos, k] = df[c].to_numpy(float)
        self.ds, self.idx = ds, ds.idx
        self.d = {n: pd.DataFrame(a, index=ds.idx, columns=ds.syms) for n, a in arr.items()}
        spy = ds.prep["SPY"].df
        reg = pd.Series(np.nan, index=ds.idx)
        reg.loc[spy.index] = (spy["Close"] > spy["ema200"]).astype(float).to_numpy()
        self.regime = reg.ffill().fillna(0).astype(bool)
        self.spy = spy


def classify(P: Panels) -> dict:
    C, ema50, ema200, rsi = (P.d[k] for k in ("C", "ema50", "ema200", "rsi"))
    m61 = C.shift(21) / C.shift(126) - 1
    m121 = C.shift(21) / C.shift(252) - 1
    valid = m121.notna() & ema200.notna() & rsi.notna()
    m61, m121 = m61.where(valid), m121.where(valid)
    mrank = (m61.rank(axis=1, pct=True) + m121.rank(axis=1, pct=True)) / 2
    reg = pd.DataFrame(np.repeat(P.regime.to_numpy()[:, None], C.shape[1], axis=1), index=C.index, columns=C.columns)
    up = (C > ema200) & (ema50 > ema200)
    trend = valid & reg & up & (mrank >= MOM_MIN)
    risk = valid & ~trend & (C < ema200) & (mrank <= 0.4)
    cat = pd.DataFrame(NEUTRAL, index=C.index, columns=C.columns, dtype=object)
    cat = cat.mask(risk, RISK).mask(trend, TREND).where(valid)
    ext = (rsi >= RSI_HOT) | (C > EXT_PCT * ema50)
    return {"cat": cat, "m61": m61, "m121": m121, "mrank": mrank, "valid": valid, "ext": ext, "up": up}


def _bucket(vals: np.ndarray, ex: Optional[pd.Series], h: int) -> dict:
    d = {"n": int(len(vals)), "median": float(np.median(vals)), "p10": float(np.percentile(vals, 10)),
         "p90": float(np.percentile(vals, 90)), "win": float((vals > 0).mean())}
    if ex is not None and len(ex) > 10:
        se = ex.std(ddof=1) / np.sqrt(len(ex) / h)
        half = len(ex) // 2
        d.update({"excess": float(ex.mean()), "t": float(ex.mean() / se) if se > 0 else 0.0,
                  "half1": float(ex.iloc[:half].mean()), "half2": float(ex.iloc[half:].mean())})
    return d


def history_stats(P: Panels, S: dict) -> dict:
    cat, valid, ext = S["cat"], S["valid"], S["ext"]
    C, O = P.d["C"], P.d["O"]
    ok = (valid.sum(axis=1) >= 100).to_numpy()
    masks = {"ALL": valid, TREND: cat == TREND, NEUTRAL: cat == NEUTRAL, RISK: cat == RISK,
             "TREND_HOT": (cat == TREND) & ext, "TREND_CLEAN": (cat == TREND) & ~ext}
    out: Dict = {}
    for h in HORIZONS:
        f = (C.shift(-h) / O.shift(-1) - 1 - 2 * vec.SLIP).where(valid)
        mkt = f.mean(axis=1)
        rows = {}
        for name, m0 in masks.items():
            m = (m0 & f.notna())
            m = m.mul(ok, axis=0).astype(bool)
            vals = f.where(m).to_numpy().ravel(); vals = vals[~np.isnan(vals)]
            if len(vals) < 300:
                continue
            ex = None if name == "ALL" else (f.where(m).mean(axis=1) - mkt)[m.sum(axis=1) > 0].dropna()
            rows[name] = _bucket(vals, ex, h)
        out[str(h)] = rows
    return out


def _phi(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def outlook(vol: float, h: int) -> dict:
    """Return distribution for an h-day hold: lognormal around an assumed market drift.
    This encodes volatility (uncertainty), NOT stock-specific alpha."""
    t = h / 252
    s = max(vol, 0.05) * math.sqrt(t)
    m = math.log(1 + DRIFT * t) - s * s / 2
    return {"mid": math.exp(m) - 1, "lo": math.exp(m - Z80 * s) - 1, "hi": math.exp(m + Z80 * s) - 1,
            "p_up": _phi(m / s)}


def _pct(x: float, signed: bool = True) -> str:
    return f"{x * 100:+.0f}%" if signed else f"{x * 100:.0f}%"


def reasons(r: dict, regime_on: bool, spy_d200: float) -> List[dict]:
    """Plain-language explanation. k: good | warn | info."""
    out: List[dict] = []
    if r["cat"] == TREND:
        out.append({"k": "good", "t": f"Erős relatív erő: 6 hónapos hozama {_pct(r['m61'])}, 12 hónapos {_pct(r['m121'])}; "
                                      f"az S&P 500 részvényei között a {r['mrank'] * 100:.0f}. percentilisben van."})
        out.append({"k": "good", "t": f"Emelkedő trend: az ára az EMA200 felett {_pct(r['d200'])}, az EMA50 felett {_pct(r['d50'])}, "
                                      f"és az EMA50 az EMA200 fölött halad."})
        out.append({"k": "good", "t": f"A piac egésze (SPY) is emelkedő trendben van ({_pct(spy_d200)} az EMA200 felett): "
                                      f"ilyenkor a trendkövetés történetileg kevésbé volt veszélyes."})
        if r["ext"]:
            out.append({"k": "warn", "t": f"Rövid távon felfűtött (RSI {r['rsi']:.0f}, {_pct(r['d50'])} az EMA50 felett): "
                                          f"egy korrekció itt gyorsabban jöhet. A múltbeli adat nem mutatta, hogy ez rosszabb kimenetet adna, "
                                          f"de ingadozóbb lehet."})
    elif r["cat"] == RISK:
        out.append({"k": "warn", "t": f"Nincs emelkedő trend: az ára az EMA200 alatt van ({_pct(r['d200'])}), és a relatív ereje gyenge "
                                      f"({r['mrank'] * 100:.0f}. percentilis)."})
        if r["dd52"] < -0.2:
            out.append({"k": "warn", "t": f"A 52 hetes csúcsától {_pct(r['dd52'])}-ra van: mély esés után a felépülés bizonytalan."})
        out.append({"k": "info", "t": "A múltbeli adat nem mutatta, hogy az ilyen papírok rosszabbul teljesítenek, de nincs trend, ami "
                                      "mellettük szólna, és nagyobb a hozamuk szórása. Ez kockázati, nem előrejelzési megállapítás."})
    else:
        out.append({"k": "info", "t": f"Vegyes kép: a relatív ereje a {r['mrank'] * 100:.0f}. percentilis, a trend nem egyértelmű "
                                      f"(EMA200-hoz képest {_pct(r['d200'])})."})
    if r["spec"]:
        out.append({"k": "warn", "t": f"Spekulatív ingadozás: az éves volatilitása ~{r['vol'] * 100:.0f}%. Egy hónap alatt is előfordulhat "
                                      f"20–30%-os mozgás bármelyik irányban; kis pozícióméret indokolt."})
    elif r["vol"] > 0.45:
        out.append({"k": "warn", "t": f"Átlag feletti ingadozás (éves ~{r['vol'] * 100:.0f}%)."})
    if r["cat"] == TREND and r["dd52"] < -0.15:
        out.append({"k": "warn", "t": f"A 52 hetes csúcsától {_pct(r['dd52'])}-ra van."})
    return out


def snapshot(P: Panels, S: dict, info: Dict[str, dict]) -> dict:
    regime_on = bool(P.regime.iloc[-1])
    spy_d200 = float(P.spy["Close"].iloc[-1] / P.spy["ema200"].iloc[-1] - 1)
    C, ema50, ema200, rsi, atr = (P.d[k] for k in ("C", "ema50", "ema200", "rsi", "atr"))
    L = len(C) - 1
    lr = np.log(C / C.shift(1))
    vol60 = lr.rolling(60).std().iloc[L] * math.sqrt(252)
    vol252 = lr.rolling(252).std().iloc[L] * math.sqrt(252)
    hi252 = P.d["H"].rolling(252).max().iloc[L]
    last = {k: v.iloc[L] for k, v in (("c", C), ("e50", ema50), ("e200", ema200), ("rsi", rsi), ("atr", atr))}
    prev = C.iloc[L - 1]
    rows = []
    for s in C.columns:
        if not bool(S["valid"].iloc[L][s]) or np.isnan(last["c"][s]):
            continue
        price, e50, e200 = float(last["c"][s]), float(last["e50"][s]), float(last["e200"][s])
        vol = float(np.nanmean([vol60[s], vol252[s]]))
        atr_v = float(last["atr"][s])
        stop = price - STOP_ATR * atr_v
        stop_pct = (price - stop) / price
        cat = S["cat"].iloc[L][s]
        mr = float(S["mrank"].iloc[L][s])
        m61, m121 = float(S["m61"].iloc[L][s]), float(S["m121"].iloc[L][s])
        ext = bool(S["ext"].iloc[L][s])
        dd = price / float(hi252[s]) - 1
        r = {
            "symbol": s, "name": info.get(s, {}).get("name", s), "sector": info.get(s, {}).get("sector", "–"),
            "price": price, "chg": price / float(prev[s]) - 1, "cat": cat, "mrank": mr,
            "m61": m61, "m121": m121, "rsi": float(last["rsi"][s]), "ext": ext,
            "above200": price > e200, "d50": price / e50 - 1, "d200": price / e200 - 1,
            "vol": vol, "atr_pct": atr_v / price, "dd52": dd,
            "stop": round(stop, 2), "stop_pct": stop_pct,
            "size_pct": min(MAX_POS, RISK_PER_TRADE / stop_pct) if stop_pct > 0 else MAX_POS,
            "outlook": {str(h): outlook(vol, h) for h in HORIZONS},
            "score": m121 / vol if vol > 0 else 0.0,        # risk-adjusted momentum (ranking heuristic)
            "spec": vol > SPEC_VOL,
        }
        r["reasons"] = reasons(r, regime_on, spy_d200)
        rows.append(r)
    return {"rows": rows, "date": P.idx[L].strftime("%Y-%m-%d")}


def _diversified(rows: List[dict], n: int, per_sector: int = 2) -> List[str]:
    cnt: Dict[str, int] = {}
    out: List[str] = []
    for r in rows:
        if cnt.get(r["sector"], 0) >= per_sector:
            continue
        cnt[r["sector"]] = cnt.get(r["sector"], 0) + 1
        out.append(r["symbol"])
        if len(out) >= n:
            break
    return out


def pick_lists(rows: List[dict]) -> dict:
    trend = sorted([r for r in rows if r["cat"] == TREND and not r["spec"]], key=lambda r: -r["score"])
    risk = sorted([r for r in rows if r["cat"] == RISK], key=lambda r: (r["mrank"], r["dd52"]))
    return {"top": _diversified(trend, 8), "avoid": _diversified(risk, 8)}


def market_view(P: Panels, S: dict, rows: List[dict]) -> dict:
    spy = P.spy
    c, e200, e50 = float(spy["Close"].iloc[-1]), float(spy["ema200"].iloc[-1]), float(spy["ema50"].iloc[-1])
    n = len(rows)
    above = sum(1 for r in rows if r["above200"])
    return {"regime": bool(P.regime.iloc[-1]), "spy": c, "spy_d200": c / e200 - 1, "spy_d50": c / e50 - 1,
            "breadth": above / n if n else 0.0, "n": n,
            "n_trend": sum(1 for r in rows if r["cat"] == TREND), "n_risk": sum(1 for r in rows if r["cat"] == RISK)}


# ------------------------------------------------------------------ job
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
        PICKS["progress"] = round(frac, 3)
    PICKS["message"] = msg


def build(extra: Optional[List[str]] = None) -> dict:
    syms = sorted(set(universe.sp500()) | set(extra or []) | {"SPY"})
    prices = universe.load_prices(syms, 8, lambda f, m: _set(0.05 + 0.6 * f, m))
    _set(0.7, f"Indikátorok számítása ({len(prices)} ticker)…")
    prepared = {s: vec.Prepared(d) for s, d in prices.items()}
    ds = research.Dataset(prepared)
    P = Panels(ds)
    S = classify(P)
    _set(0.8, "Történeti kimenetek mérése…")
    hist = history_stats(P, S)
    snap = snapshot(P, S, universe.sp500_info())
    return _clean({"generated": time.strftime("%Y-%m-%d %H:%M"), "date": snap["date"],
                   "market": market_view(P, S, snap["rows"]), "rows": snap["rows"], "history": hist,
                   **pick_lists(snap["rows"]),
                   "history_period": [ds.idx[260].strftime("%Y-%m-%d"), ds.idx[-1].strftime("%Y-%m-%d")],
                   "assumptions": {"drift": DRIFT, "stop_atr": STOP_ATR, "risk_per_trade": RISK_PER_TRADE,
                                   "max_pos": MAX_POS, "mom_min": MOM_MIN}})


def run(extra: Optional[List[str]] = None) -> None:
    try:
        PICKS.update(status="running", progress=0.0, message="Adatok betöltése…")
        res = build(extra)
        OUT.write_text(json.dumps(res))
        PICKS.update(status="done", progress=1.0, message="Kész", result=res)
    except Exception as e:
        import traceback
        traceback.print_exc()
        PICKS.update(status="error", message=f"{type(e).__name__}: {e}")


def start(extra: Optional[List[str]] = None) -> bool:
    if PICKS["status"] == "running":
        return False
    threading.Thread(target=run, args=(extra,), daemon=True).start()
    return True


def load_saved() -> Optional[float]:
    """Load the last result from disk; returns its age in hours."""
    if OUT.exists() and PICKS["result"] is None:
        try:
            PICKS.update(status="done", progress=1.0, message="Mentett eredmény", result=json.loads(OUT.read_text()))
        except Exception:
            return None
    return (time.time() - OUT.stat().st_mtime) / 3600 if OUT.exists() else None
