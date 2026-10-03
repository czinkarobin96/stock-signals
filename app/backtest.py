"""Event-driven backtest of the live swing rules.

Re-uses signals.score / signals.exit_check so the test measures exactly what
the dashboard shows. Signals form on a bar's close; fills happen at the next
bar's open (no look-ahead). Stops/targets are checked intrabar using levels
known at the previous close; a gap through the stop fills at the open.
"""
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from . import data
from .signals import exit_check, score

WARMUP = 210          # bars needed for EMA200 to settle
SLIP = 0.0005         # 0.05% per side
MAX_HOLD = 60         # bars (≈3 months)
TRADING_DAYS = 252


def simulate(df: pd.DataFrame, symbol: str, threshold: int) -> tuple:
    n = len(df)
    O, H, L, C = (df[c].to_numpy() for c in ("Open", "High", "Low", "Close"))
    idx = df.index
    r = np.zeros(n)
    trades: List[dict] = []
    in_pos = pending_entry = pending_exit = False
    ref = entry_px = 0.0
    entry_i = 0
    entry_date = ""
    reason = ""

    def record(j: int, px: float, why: str) -> None:
        trades.append({
            "symbol": symbol, "entry_date": idx[entry_i].strftime("%Y-%m-%d"),
            "exit_date": idx[j].strftime("%Y-%m-%d"), "entry": round(entry_px, 2),
            "exit": round(px, 2), "ret": px / entry_px - 1, "bars": j - entry_i, "reason": why,
        })

    for j in range(WARMUP, n):
        exited_now = False
        if in_pos and pending_exit:
            px = O[j] * (1 - SLIP)
            r[j] = px / ref - 1
            record(j, px, reason)
            in_pos = pending_exit = False
            exited_now = True
        elif pending_entry:
            entry_px = O[j] * (1 + SLIP)
            entry_i, entry_date = j, idx[j].strftime("%Y-%m-%d")
            ref, in_pos, pending_entry = entry_px, True, False

        if in_pos and not exited_now:
            lv = exit_check(df.iloc[:j], entry_px, entry_date)
            stop, target = lv["stop"], lv["target"]
            px, why = None, ""
            if O[j] <= stop:
                px, why = O[j], "stop (gap)"
            elif L[j] <= stop:
                px, why = stop, "stop"
            elif H[j] >= target:
                px, why = target, "célár"
            if px is not None:
                px *= 1 - SLIP
                r[j] = px / ref - 1
                record(j, px, why)
                in_pos = False
                exited_now = True
            else:
                if j - entry_i >= MAX_HOLD:
                    px = C[j] * (1 - SLIP)
                    r[j] = px / ref - 1
                    record(j, px, "időkorlát")
                    in_pos = False
                    exited_now = True
                else:
                    r[j] = C[j] / ref - 1
                    ref = C[j]
                    ex = exit_check(df.iloc[: j + 1], entry_px, entry_date)
                    if ex["action"] != "HOLD":
                        pending_exit, reason = True, ex["why"].split("(")[0].strip()
                        if j == n - 1:
                            pass

        if not in_pos and not pending_entry and j + 1 < n:
            if score(df.iloc[: j + 1])["score"] >= threshold:
                pending_entry = True

    if in_pos:  # still open at the end: mark to last close
        px = C[-1]
        record(n - 1, px, "nyitott (adatvége)")
    return pd.Series(r, index=idx), trades


def _equity_stats(ret: pd.Series) -> dict:
    ret = ret.dropna()
    if ret.empty:
        return {"total": 0, "cagr": 0, "maxdd": 0, "sharpe": 0}
    eq = (1 + ret).cumprod()
    years = max(len(ret) / TRADING_DAYS, 1e-9)
    dd = (eq / eq.cummax() - 1).min()
    sd = ret.std()
    return {
        "total": float(eq.iloc[-1] - 1),
        "cagr": float(eq.iloc[-1] ** (1 / years) - 1),
        "maxdd": float(dd),
        "sharpe": float(ret.mean() / sd * np.sqrt(TRADING_DAYS)) if sd > 0 else 0.0,
    }


def _trade_stats(trades: List[dict]) -> dict:
    if not trades:
        return {"n": 0, "win_rate": 0, "avg": 0, "avg_win": 0, "avg_loss": 0,
                "profit_factor": 0, "avg_bars": 0}
    rets = np.array([t["ret"] for t in trades])
    wins, losses = rets[rets > 0], rets[rets <= 0]
    gross_l = -losses.sum()
    return {
        "n": len(rets),
        "win_rate": float((rets > 0).mean()),
        "avg": float(rets.mean()),
        "avg_win": float(wins.mean()) if len(wins) else 0.0,
        "avg_loss": float(losses.mean()) if len(losses) else 0.0,
        "profit_factor": float(wins.sum() / gross_l) if gross_l > 0 else None,
        "avg_bars": float(np.mean([t["bars"] for t in trades])),
    }


def run(symbols: List[str], threshold: int = 4, years: int = 5) -> Optional[dict]:
    rets: Dict[str, pd.Series] = {}
    bh: Dict[str, pd.Series] = {}
    all_trades: List[dict] = []
    per_symbol = []
    for s in symbols:
        df = data.history_long(s, years)
        if df is None:
            continue
        r, trades = simulate(df, s, threshold)
        r = r.iloc[WARMUP:]
        rets[s] = r
        bh[s] = df["Close"].pct_change().iloc[WARMUP:]
        all_trades += trades
        per_symbol.append({
            "symbol": s, **_trade_stats(trades),
            "strategy": float((1 + r).prod() - 1),
            "buyhold": float((1 + bh[s]).prod() - 1),
        })
    if not rets:
        return None

    strat = pd.DataFrame(rets).mean(axis=1)           # equal-weight, flat = cash
    hold = pd.DataFrame(bh).mean(axis=1)
    spy_df = data.history_long("SPY", years)
    spy = spy_df["Close"].pct_change().reindex(strat.index).fillna(0) if spy_df is not None else None

    cut = strat.index[int(len(strat) * 0.6)]
    def period(mask_idx):
        sub = [t for t in all_trades if mask_idx(pd.Timestamp(t["entry_date"]))]
        return {"trades": _trade_stats(sub), "equity": _equity_stats(strat[mask_idx(strat.index)])}
    sections = {
        "all": {"trades": _trade_stats(all_trades), "equity": _equity_stats(strat)},
        "in_sample": period(lambda d: d < cut),
        "out_of_sample": period(lambda d: d >= cut),
    }
    exposure = float(np.mean([(r != 0).mean() for r in rets.values()]))

    def curve(ret: pd.Series):
        eq = (1 + ret).cumprod() * 100
        return [{"time": i.strftime("%Y-%m-%d"), "value": round(float(v), 2)} for i, v in eq.items()]

    all_trades.sort(key=lambda t: t["exit_date"], reverse=True)
    return {
        "threshold": threshold, "years": years, "symbols": list(rets),
        "period": [strat.index[0].strftime("%Y-%m-%d"), strat.index[-1].strftime("%Y-%m-%d")],
        "split_date": cut.strftime("%Y-%m-%d"),
        "exposure": exposure,
        "stats": sections,
        "benchmark": {"buyhold": _equity_stats(hold),
                      "spy": _equity_stats(spy) if spy is not None else None},
        "curves": {"strategy": curve(strat), "buyhold": curve(hold),
                   "spy": curve(spy) if spy is not None else []},
        "per_symbol": sorted(per_symbol, key=lambda x: x["strategy"], reverse=True),
        "trades": all_trades[:200],
        "assumptions": {"slippage": SLIP, "max_hold": MAX_HOLD, "warmup": WARMUP},
    }
