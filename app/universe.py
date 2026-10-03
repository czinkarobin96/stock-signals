"""S&P 500 universe + on-disk price cache for research runs."""
import json
import re
import time
import warnings
from pathlib import Path
from typing import Callable, Dict, List, Optional

import pandas as pd
import requests
import yfinance as yf

from . import yflock

warnings.filterwarnings("ignore")

DATA = Path(__file__).resolve().parent.parent / "data"
PRICES = DATA / "prices"
PRICES.mkdir(parents=True, exist_ok=True)
WIKI = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
PRICE_TTL = 20 * 3600


def sp500() -> List[str]:
    f = DATA / "sp500.json"
    if f.exists() and time.time() - f.stat().st_mtime < 7 * 86400:
        return json.loads(f.read_text())
    try:
        t = requests.get(WIKI, headers={"User-Agent": "Mozilla/5.0 stock-signals research"}, timeout=20).text
        syms = re.findall(r'class="external text"[^>]*>([A-Z][A-Z.\-]{0,5})</a></td>', t)
        syms = sorted({s.replace(".", "-") for s in syms})
        if len(syms) > 400:
            f.write_text(json.dumps(syms))
            return syms
    except Exception:
        pass
    return json.loads(f.read_text()) if f.exists() else []


def _is_daily(d: pd.DataFrame) -> bool:
    """Guard against intraday frames sneaking into the daily cache."""
    gaps = d.index.to_series().diff().dropna()
    return len(gaps) > 0 and gaps.median() >= pd.Timedelta(hours=20)


def _path(sym: str) -> Path:
    return PRICES / f"{sym}.pkl"


def load_prices(symbols: List[str], years: int = 8,
                progress: Optional[Callable[[float, str], None]] = None) -> Dict[str, pd.DataFrame]:
    """Daily OHLCV per symbol; batched downloads, cached on disk for ~20h."""
    out: Dict[str, pd.DataFrame] = {}
    todo = []
    for s in symbols:
        p = _path(s)
        if p.exists() and time.time() - p.stat().st_mtime < PRICE_TTL:
            d = pd.read_pickle(p)
            if _is_daily(d):
                out[s] = d
                continue
        todo.append(s)
    def fetch(part: List[str]) -> None:
        with yflock.lock:
            raw = yf.download(part, period=f"{years}y", interval="1d", group_by="ticker",
                              progress=False, threads=True, auto_adjust=True, timeout=25)
        for s in part:
            try:
                if isinstance(raw.columns, pd.MultiIndex):
                    lv = 0 if s in raw.columns.get_level_values(0) else 1
                    d = raw.xs(s, axis=1, level=lv)
                else:
                    d = raw
                d = d.dropna(subset=["Close"])
                if len(d) > 400 and _is_daily(d):
                    d = d[["Open", "High", "Low", "Close", "Volume"]]
                    d.index = d.index.tz_localize(None)
                    d.to_pickle(_path(s))
                    out[s] = d
            except Exception:
                pass

    chunk = 25
    for k in range(0, len(todo), chunk):
        part = todo[k:k + chunk]
        if progress:
            progress(k / max(len(todo), 1), f"Letöltés: {k}/{len(todo)} ticker")
        try:
            fetch(part)
        except Exception:
            pass
        missing = [s for s in part if s not in out]
        if missing and len(missing) < len(part):  # partial result: retry the rest once
            for j in range(0, len(missing), 8):
                try:
                    fetch(missing[j:j + 8])
                except Exception:
                    pass
    return out
