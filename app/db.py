import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "stocks.db"
DEFAULT_WATCHLIST = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA",
    "AMD", "AVGO", "NFLX", "JPM", "V", "COST", "LLY",
]


def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    with conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS watchlist (symbol TEXT PRIMARY KEY)")
        c.execute(
            """CREATE TABLE IF NOT EXISTS positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                qty REAL NOT NULL,
                entry_price REAL NOT NULL,
                entry_date TEXT NOT NULL,
                note TEXT DEFAULT '',
                closed INTEGER DEFAULT 0
            )"""
        )
        if c.execute("SELECT COUNT(*) FROM watchlist").fetchone()[0] == 0:
            c.executemany(
                "INSERT INTO watchlist(symbol) VALUES (?)", [(s,) for s in DEFAULT_WATCHLIST]
            )
