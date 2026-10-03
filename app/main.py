import asyncio
import datetime as dt
from pathlib import Path
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import data, db
from .signals import exit_check, score

ROOT = Path(__file__).resolve().parent.parent
QUOTE_INTERVAL = 15  # seconds
NY = ZoneInfo("America/New_York")

app = FastAPI(title="Stock Signals")
db.init()

state: Dict = {"quotes": {}, "signals": {}, "updated": None}
clients: List[WebSocket] = []


def market_status() -> dict:
    now = dt.datetime.now(NY)
    open_t, close_t = dt.time(9, 30), dt.time(16, 0)
    is_open = now.weekday() < 5 and open_t <= now.time() < close_t
    return {"open": is_open, "ny_time": now.strftime("%H:%M")}


def watchlist() -> List[str]:
    with db.conn() as c:
        return [r["symbol"] for r in c.execute("SELECT symbol FROM watchlist ORDER BY rowid")]


def open_positions() -> List[dict]:
    with db.conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM positions WHERE closed=0 ORDER BY id DESC")]


def all_symbols() -> List[str]:
    return sorted(set(watchlist()) | {p["symbol"] for p in open_positions()})


def build_signals() -> None:
    for s in all_symbols():
        df = data.history(s)
        if df is not None:
            state["signals"][s] = score(df)


def portfolio_view() -> dict:
    rows, invested, value = [], 0.0, 0.0
    for p in open_positions():
        q = state["quotes"].get(p["symbol"])
        price = q["price"] if q else p["entry_price"]
        df = data.history(p["symbol"])
        ex = exit_check(df, p["entry_price"], p["entry_date"]) if df is not None else None
        if ex and price <= ex["stop"] and ex["action"] != "SELL":
            ex = {**ex, "action": "SELL", "why": f"Élő ár a stop ({ex['stop']}) alatt"}
        cost, val = p["qty"] * p["entry_price"], p["qty"] * price
        invested += cost
        value += val
        rows.append({
            **p, "price": price, "pnl": val - cost,
            "pnl_pct": (price / p["entry_price"] - 1) * 100, "exit": ex,
        })
    return {
        "positions": rows,
        "invested": invested, "value": value,
        "pnl": value - invested,
        "pnl_pct": (value / invested - 1) * 100 if invested else 0.0,
    }


def snapshot() -> dict:
    syms = watchlist()
    wl = []
    for s in syms:
        q = state["quotes"].get(s, {})
        sig = state["signals"].get(s)
        wl.append({"symbol": s, **q, "signal": sig})
    return {
        "market": market_status(),
        "updated": state["updated"],
        "watchlist": wl,
        "portfolio": portfolio_view(),
    }


async def broadcast() -> None:
    snap = snapshot()
    for ws in list(clients):
        try:
            await ws.send_json(snap)
        except Exception:
            if ws in clients:
                clients.remove(ws)


async def refresh(full: bool = False) -> None:
    syms = all_symbols()
    state["quotes"] = await asyncio.to_thread(data.quotes, syms)
    if full or not state["signals"]:
        await asyncio.to_thread(build_signals)
    state["updated"] = dt.datetime.now().isoformat(timespec="seconds")
    await broadcast()


async def loop() -> None:
    n = 0
    while True:
        try:
            # signals rebuild every ~15 min (cache TTL decides if data is refetched)
            await refresh(full=(n % 60 == 0))
        except Exception as e:  # keep the loop alive
            print("refresh error:", e)
        n += 1
        await asyncio.sleep(QUOTE_INTERVAL)


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(loop())


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    clients.append(ws)
    try:
        await ws.send_json(snapshot())
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if ws in clients:
            clients.remove(ws)


@app.get("/api/snapshot")
def api_snapshot() -> dict:
    return snapshot()


@app.get("/api/chart/{symbol}")
def api_chart(symbol: str, days: int = 180) -> dict:
    symbol = symbol.upper()
    df = data.history(symbol)
    if df is None:
        raise HTTPException(404, "Nincs adat ehhez a tickerhez")
    df = df.tail(days)

    def line(col: str):
        return [{"time": i.strftime("%Y-%m-%d"), "value": round(float(v), 2)}
                for i, v in df[col].items() if v == v]

    return {
        "symbol": symbol,
        "candles": [
            {"time": i.strftime("%Y-%m-%d"), "open": round(float(r.Open), 2),
             "high": round(float(r.High), 2), "low": round(float(r.Low), 2),
             "close": round(float(r.Close), 2)}
            for i, r in df.iterrows()
        ],
        "volume": [
            {"time": i.strftime("%Y-%m-%d"), "value": float(r.Volume),
             "color": "rgba(52,211,153,.35)" if r.Close >= r.Open else "rgba(248,113,113,.35)"}
            for i, r in df.iterrows()
        ],
        "ema20": line("ema20"), "ema50": line("ema50"), "ema200": line("ema200"),
        "signal": state["signals"].get(symbol) or score(data.history(symbol)),
    }


class WatchItem(BaseModel):
    symbol: str


@app.post("/api/watchlist")
async def add_watch(item: WatchItem) -> dict:
    sym = item.symbol.strip().upper()
    if not sym.replace(".", "").replace("-", "").isalnum() or len(sym) > 8:
        raise HTTPException(400, "Érvénytelen ticker")
    if await asyncio.to_thread(data.history, sym) is None:
        raise HTTPException(404, f"{sym}: nem található adat")
    with db.conn() as c:
        c.execute("INSERT OR IGNORE INTO watchlist(symbol) VALUES (?)", (sym,))
    await refresh(full=True)
    return {"ok": True}


@app.delete("/api/watchlist/{symbol}")
async def del_watch(symbol: str) -> dict:
    with db.conn() as c:
        c.execute("DELETE FROM watchlist WHERE symbol=?", (symbol.upper(),))
    await broadcast()
    return {"ok": True}


class Position(BaseModel):
    symbol: str
    qty: float
    entry_price: float
    entry_date: Optional[str] = None
    note: str = ""


@app.post("/api/positions")
async def add_position(p: Position) -> dict:
    sym = p.symbol.strip().upper()
    if p.qty <= 0 or p.entry_price <= 0:
        raise HTTPException(400, "A mennyiség és az ár legyen pozitív")
    if await asyncio.to_thread(data.history, sym) is None:
        raise HTTPException(404, f"{sym}: nem található adat")
    with db.conn() as c:
        c.execute(
            "INSERT INTO positions(symbol,qty,entry_price,entry_date,note) VALUES (?,?,?,?,?)",
            (sym, p.qty, p.entry_price, p.entry_date or dt.date.today().isoformat(), p.note),
        )
    await refresh(full=True)
    return {"ok": True}


@app.delete("/api/positions/{pid}")
async def close_position(pid: int) -> dict:
    with db.conn() as c:
        c.execute("UPDATE positions SET closed=1 WHERE id=?", (pid,))
    await broadcast()
    return {"ok": True}


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(ROOT / "static" / "index.html")
