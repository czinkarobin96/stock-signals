"""Swing signal scoring (rule based, daily bars).

Each factor adds/removes points; the total decides the verdict. Stop and
target levels are ATR based so every signal carries its own risk definition.
"""
from typing import Optional

import pandas as pd

STOP_ATR = 2.0
TARGET_ATR = 3.0
TRAIL_ATR = 2.5


def _f(x) -> Optional[float]:
    return None if pd.isna(x) else float(x)


def score(df: pd.DataFrame) -> dict:
    last, prev = df.iloc[-1], df.iloc[-2]
    reasons = []
    pts = 0

    if last.Close > last.ema50:
        pts += 1
        reasons.append("Ár az EMA50 felett (rövid trend ↑)")
    if last.ema50 > last.ema200:
        pts += 1
        reasons.append("EMA50 > EMA200 (hosszú trend ↑)")
    if 45 <= last.rsi <= 68 and last.rsi > prev.rsi:
        pts += 1
        reasons.append(f"RSI {last.rsi:.0f}, emelkedő, még nem túlvett")
    elif last.rsi > 75:
        pts -= 1
        reasons.append(f"RSI {last.rsi:.0f}: túlvett")
    elif last.rsi < 30:
        reasons.append(f"RSI {last.rsi:.0f}: túladott, visszapattanás-jelölt")
    if last.macd_hist > 0 and last.macd_hist > prev.macd_hist:
        pts += 1
        reasons.append("MACD hisztogram pozitív és erősödik")
    elif last.macd_hist < 0 and last.macd_hist < prev.macd_hist:
        pts -= 1
        reasons.append("MACD hisztogram negatív és gyengül")
    if last.Close > last.high20:
        pts += 1
        reasons.append("20 napos csúcs kitörése")
        if last.Volume > 1.5 * last.vol_avg20:
            pts += 1
            reasons.append("Kitörés magas forgalommal")
    if last.Close < last.ema50 and last.Close < last.ema200:
        pts -= 1
        reasons.append("Ár az EMA50 és EMA200 alatt")

    if pts >= 4:
        verdict = "BUY"
    elif pts >= 2:
        verdict = "WATCH"
    else:
        verdict = "NEUTRAL" if pts >= 0 else "AVOID"

    atr = float(last.atr)
    price = float(last.Close)
    return {
        "score": pts,
        "verdict": verdict,
        "reasons": reasons,
        "price": price,
        "rsi": _f(last.rsi),
        "atr": atr,
        "stop": round(price - STOP_ATR * atr, 2),
        "target": round(price + TARGET_ATR * atr, 2),
    }


def exit_check(df: pd.DataFrame, entry_price: float, entry_date: str) -> dict:
    """SELL logic for an open position: trailing stop, target, trend break."""
    last = df.iloc[-1]
    since = df[df.index >= pd.Timestamp(entry_date)]
    if since.empty:
        since = df.tail(1)
    highest = float(since["High"].max())
    atr = float(last.atr)
    trail = round(highest - TRAIL_ATR * atr, 2)
    hard_stop = round(entry_price - STOP_ATR * atr, 2)
    stop = max(trail, hard_stop)
    target = round(entry_price + TARGET_ATR * atr, 2)
    price = float(last.Close)

    action, why = "HOLD", "Trend ép, nincs kilépési jel"
    if price <= stop:
        action, why = "SELL", f"Stop szint ({stop}) alá esett az ár"
    elif last.Close < last.ema50 and last.macd_hist < 0:
        action, why = "SELL", "Trendtörés: EMA50 alatt, MACD negatív"
    elif price >= target:
        action, why = "TAKE_PROFIT", f"Célár ({target}) elérve, érdemes profitot realizálni / stopot húzni"
    elif last.rsi > 78:
        action, why = "TAKE_PROFIT", f"RSI {last.rsi:.0f}: erősen túlvett"
    return {"action": action, "why": why, "stop": stop, "target": target}
