# Signal Glass

US részvények swing-jelzései élő, glassmorphism dashboardon. (Localhost fejlesztés; MCP/webhook és szerver később.)

## Indítás
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000
```
Majd: http://localhost:8000

## Felépítés
- `app/indicators.py` – EMA, RSI, MACD, ATR
- `app/signals.py` – swing-pontozás (BUY/WATCH/NEUTRAL/AVOID) + SELL/TAKE_PROFIT logika nyitott pozícióra
- `app/data.py` – yfinance adatletöltés + cache (15 percenként napi bar, 15 mp-enként árfolyam)
- `app/main.py` – FastAPI, REST + WebSocket (`/ws`) live push
- `app/backtest.py` – referencia (lassú, élő kódot hívó) backtest a Backtest fülhöz
- `app/vec.py` – vektorizált tényezők + numba szimulátor (a referenciával bájtra egyező ügyletlista, lásd `tests/test_parity.py`)
- `app/universe.py` – S&P 500 lista + lemezes árgyorsítótár (`data/prices/`)
- `app/research.py` – Kutatás fül: ① tényező-előny teszt, ② univerzum-backtest, ③ walk-forward
- `app/picks.py` – Ajánlások fül: fix besorolás (erős trend / semleges / magas kockázat), történeti kimenetek, hozam-sáv, stop, pozícióméret, magyarázatok
- `static/` – dashboard (Lightweight Charts, vanilla JS)

Az adatok oktatási célúak, nem pénzügyi tanácsadás.

## Tesztek
```bash
.venv/bin/python tests/test_parity.py
.venv/bin/python tests/test_picks.py
```
