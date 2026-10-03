const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (n) => (n == null ? "–" : n.toLocaleString("en-US", { style: "currency", currency: "USD" }));
const pct = (n) => (n == null ? "–" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%");
const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");

let snap = null, selected = null, lastPrices = {}, chart, series = {}, loadedChart = null;

// ---------- toasts ----------
function toast(msg, err) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

// ---------- websocket ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => setConn(true);
  ws.onmessage = (e) => { snap = JSON.parse(e.data); render(); };
  ws.onclose = () => { setConn(false); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
}
function setConn(on) {
  const p = $("#conn");
  p.className = "pill " + (on ? "on" : "off");
  p.querySelector("b").textContent = on ? "Live" : "Újracsatlakozás…";
}

// ---------- render ----------
function render() {
  const m = snap.market;
  $("#market").className = "pill " + (m.open ? "on" : "off");
  $("#market").querySelector("b").textContent = m.open ? `Piac nyitva · NY ${m.ny_time}` : `Piac zárva · NY ${m.ny_time}`;
  $("#updated").textContent = snap.updated ? "Frissítve: " + snap.updated.split("T")[1] : "";

  const pf = snap.portfolio;
  $("#k-value").textContent = usd(pf.value);
  $("#k-invested").textContent = "Befektetve: " + usd(pf.invested);
  $("#k-pnl").textContent = usd(pf.pnl);
  $("#k-pnl").className = cls(pf.pnl);
  $("#k-pnlpct").textContent = pct(pf.pnl_pct);
  $("#k-pnlpct").className = cls(pf.pnl);
  $("#k-pos").textContent = pf.positions.length;
  const alerts = pf.positions.filter((p) => p.exit && p.exit.action !== "HOLD").length;
  $("#k-alerts").textContent = alerts ? `⚠ ${alerts} kilépési jelzés` : "Nincs kilépési jelzés";
  const buys = snap.watchlist.filter((w) => w.signal?.verdict === "BUY").length;
  const watch = snap.watchlist.filter((w) => w.signal?.verdict === "WATCH").length;
  $("#k-buy").textContent = buys;
  $("#k-watch").textContent = `${watch} figyelendő`;

  renderWatchlist();
  renderPositions();
  if (!selected && snap.watchlist.length) selectSymbol(snap.watchlist[0].symbol);
  else if (selected) renderSignal();
}

function renderWatchlist() {
  const rows = snap.watchlist.slice().sort((a, b) => (b.signal?.score ?? -9) - (a.signal?.score ?? -9));
  $("#wl").innerHTML = rows.map((w) => {
    const v = w.signal?.verdict;
    return `<tr data-s="${esc(w.symbol)}" class="${w.symbol === selected ? "sel" : ""}">
      <td class="sym">${esc(w.symbol)}</td>
      <td class="r price" data-p="${esc(w.symbol)}">${w.price != null ? usd(w.price) : "–"}</td>
      <td class="r ${cls(w.change_pct)}">${pct(w.change_pct)}</td>
      <td>${v ? `<span class="badge b-${v}">${v}</span>` : "–"}</td>
      <td class="r">${w.signal ? w.signal.score : "–"}</td>
      <td class="r"><button class="btn ghost" data-del="${esc(w.symbol)}" title="Eltávolítás">✕</button></td></tr>`;
  }).join("") || `<tr><td colspan="6" class="empty">Üres a watchlist.</td></tr>`;

  // flash on price change
  for (const w of snap.watchlist) {
    const prev = lastPrices[w.symbol];
    if (prev != null && w.price != null && w.price !== prev) {
      const cell = document.querySelector(`[data-p="${w.symbol}"]`);
      if (cell) { cell.classList.add(w.price > prev ? "flash-up" : "flash-down"); }
    }
    if (w.price != null) lastPrices[w.symbol] = w.price;
  }
}

function renderPositions() {
  const ps = snap.portfolio.positions;
  $("#positions").innerHTML = ps.map((p) => {
    const ex = p.exit || { action: "HOLD", why: "–" };
    return `<div class="pos ${ex.action}">
      <div class="row"><b class="sym">${esc(p.symbol)}</b>
        <span class="badge b-${ex.action}">${ex.action.replace("_", " ")}</span></div>
      <div class="row"><span>${p.qty} db @ ${usd(p.entry_price)} → ${usd(p.price)}</span>
        <b class="${cls(p.pnl)}">${usd(p.pnl)} (${pct(p.pnl_pct)})</b></div>
      <div class="why">${esc(ex.why)}</div>
      <div class="row"><span class="lvls">Stop ${ex.stop != null ? usd(ex.stop) : "–"} · Cél ${ex.target != null ? usd(ex.target) : "–"}${p.note ? " · " + esc(p.note) : ""}</span>
        <button class="btn ghost" data-close="${p.id}">Lezárás</button></div>
    </div>`;
  }).join("") || `<div class="empty">Még nincs nyitott pozíció. Add meg, mibe fektettél, és szólok, ha ideje kilépni.</div>`;
}

function renderSignal() {
  const w = snap.watchlist.find((x) => x.symbol === selected);
  const s = w?.signal;
  if (!s) { $("#sig-body").innerHTML = `<div class="muted">Nincs jelzés.</div>`; return; }
  const gauge = Math.max(0, Math.min(100, ((s.score + 2) / 8) * 100));
  $("#sig-body").innerHTML = `
    <div class="sig-top"><div><div class="big">${esc(w.symbol)}</div><div class="muted small">Pontszám: ${s.score} / 6</div></div>
      <span class="badge b-${s.verdict}" style="font-size:15px;padding:6px 14px">${s.verdict}</span></div>
    <div class="gauge"><i style="width:${gauge}%"></i></div>
    <ul class="reasons">${s.reasons.map((r) => `<li>${esc(r)}</li>`).join("") || "<li>Nincs erős tényező</li>"}</ul>
    <div class="levels">
      <div class="lv"><span>Stop</span><b class="down">${usd(s.stop)}</b></div>
      <div class="lv"><span>Ár</span><b>${usd(s.price)}</b></div>
      <div class="lv"><span>Cél</span><b class="up">${usd(s.target)}</b></div>
    </div>
    <p class="muted small" style="margin-top:12px">RSI ${s.rsi?.toFixed(0)} · ATR ${usd(s.atr)} · napi záróadat alapján</p>`;
}

// ---------- chart ----------
function initChart() {
  const el = $("#chart");
  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: "transparent" }, textColor: "#9aa4c7", fontFamily: "inherit" },
    grid: { vertLines: { color: "rgba(255,255,255,.05)" }, horzLines: { color: "rgba(255,255,255,.05)" } },
    rightPriceScale: { borderColor: "rgba(255,255,255,.12)" },
    timeScale: { borderColor: "rgba(255,255,255,.12)" },
    crosshair: { mode: 0 },
  });
  series.candle = chart.addCandlestickSeries({
    upColor: "#34d399", downColor: "#f87171", borderVisible: false,
    wickUpColor: "#34d399", wickDownColor: "#f87171",
  });
  series.ema20 = chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  series.ema50 = chart.addLineSeries({ color: "#60a5fa", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  series.ema200 = chart.addLineSeries({ color: "#f472b6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  series.vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  series.lines = [];
}

async function loadChart(sym) {
  $("#c-title").textContent = sym + " · napi chart";
  const r = await fetch(`/api/chart/${sym}`);
  if (!r.ok) return toast("Chart betöltése sikertelen", true);
  const d = await r.json();
  series.candle.setData(d.candles);
  series.ema20.setData(d.ema20);
  series.ema50.setData(d.ema50);
  series.ema200.setData(d.ema200);
  series.vol.setData(d.volume);
  series.lines.forEach((l) => series.candle.removePriceLine(l));
  series.lines = [
    series.candle.createPriceLine({ price: d.signal.stop, color: "#f87171", lineStyle: 2, lineWidth: 1, title: "stop" }),
    series.candle.createPriceLine({ price: d.signal.target, color: "#34d399", lineStyle: 2, lineWidth: 1, title: "cél" }),
  ];
  chart.timeScale().fitContent();
  // the container may still be laying out on first load; refit once it settles
  requestAnimationFrame(() => chart.timeScale().fitContent());
  setTimeout(() => chart.timeScale().fitContent(), 300);
  loadedChart = sym;
}

function selectSymbol(sym) {
  selected = sym;
  document.querySelectorAll("#wl tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.s === sym));
  renderSignal();
  if (loadedChart !== sym) loadChart(sym);
}

// ---------- events ----------
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    toast(e.detail || "Hiba történt", true);
    return false;
  }
  return true;
}

$("#wl").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { e.stopPropagation(); if (await api("DELETE", `/api/watchlist/${del.dataset.del}`)) toast(`${del.dataset.del} eltávolítva`); return; }
  const tr = e.target.closest("tr[data-s]");
  if (tr) selectSymbol(tr.dataset.s);
});
$("#positions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-close]");
  if (b && confirm("Lezárod ezt a pozíciót?")) await api("DELETE", `/api/positions/${b.dataset.close}`);
});
$("#add-watch").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, symbol = f.symbol.value.trim();
  if (!symbol) return;
  if (await api("POST", "/api/watchlist", { symbol })) { f.reset(); toast(`${symbol.toUpperCase()} hozzáadva`); }
});
$("#add-pos").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { symbol: f.symbol.value, qty: +f.qty.value, entry_price: +f.entry_price.value, entry_date: f.entry_date.value || null };
  if (await api("POST", "/api/positions", body)) { f.reset(); toast("Pozíció rögzítve"); }
});

initChart();
connect();
