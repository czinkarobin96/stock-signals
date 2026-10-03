import time
import warnings
from typing import Dict, List, Optional

import pandas as pd
import yfinance as yf

from .indicators import enrich

warnings.filterwarnings("ignore")

_hist: Dict[str, tuple] = {}
HIST_TTL = 15 * 60


def history(symbol: str) -> Optional[pd.DataFrame]:
    """~2 years of daily bars with indicators, cached."""
    hit = _hist.get(symbol)
    if hit and time.time() - hit[0] < HIST_TTL:
        return hit[1]
    try:
        df = yf.Ticker(symbol).history(period="2y", interval="1d", auto_adjust=True)
    except Exception:
        return hit[1] if hit else None
    if df is None or len(df) < 60:
        return hit[1] if hit else None
    df.index = df.index.tz_localize(None)
    df = enrich(df)
    _hist[symbol] = (time.time(), df)
    return df


def quotes(symbols: List[str]) -> Dict[str, dict]:
    """Latest price + day change. One batched intraday request."""
    out: Dict[str, dict] = {}
    if not symbols:
        return out
    try:
        raw = yf.download(
            symbols, period="5d", interval="5m", group_by="ticker",
            progress=False, threads=True, auto_adjust=True, prepost=True,
        )
    except Exception:
        raw = None
    for s in symbols:
        try:
            d = raw[s] if len(symbols) > 1 else raw
            d = d.dropna(subset=["Close"])
            price = float(d["Close"].iloc[-1])
            day = d.index[-1].date()
            prior = d[d.index.date < day]
            prev_close = float(prior["Close"].iloc[-1]) if len(prior) else price
            out[s] = {
                "price": price,
                "prev_close": prev_close,
                "change": price - prev_close,
                "change_pct": (price / prev_close - 1) * 100 if prev_close else 0.0,
                "ts": d.index[-1].isoformat(),
            }
        except Exception:
            h = history(s)
            if h is not None:
                p = float(h["Close"].iloc[-1])
                pc = float(h["Close"].iloc[-2])
                out[s] = {"price": p, "prev_close": pc, "change": p - pc,
                          "change_pct": (p / pc - 1) * 100, "ts": h.index[-1].isoformat()}
    return out


_hist_long: Dict[str, tuple] = {}
LONG_TTL = 6 * 3600


def history_long(symbol: str, years: int = 5) -> Optional[pd.DataFrame]:
    """Multi-year daily bars with indicators, for backtesting (cached)."""
    key = f"{symbol}:{years}"
    hit = _hist_long.get(key)
    if hit and time.time() - hit[0] < LONG_TTL:
        return hit[1]
    try:
        df = yf.Ticker(symbol).history(period=f"{years}y", interval="1d", auto_adjust=True)
    except Exception:
        return hit[1] if hit else None
    if df is None or len(df) < 260:
        return hit[1] if hit else None
    df.index = df.index.tz_localize(None)
    df = enrich(df)
    _hist_long[key] = (time.time(), df)
    return df
