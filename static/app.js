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
// lightweight-charts' autoSize throws on display:none containers (tab switches),
// so size charts ourselves and skip zero-size observations.
function makeChart(el, opts) {
  const c = LightweightCharts.createChart(el, { ...opts, width: el.clientWidth || 600, height: el.clientHeight || 320 });
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth, h = el.clientHeight;
    if (w > 0 && h > 0) c.resize(w, h);
  });
  ro.observe(el);
  const remove = c.remove.bind(c);
  c.remove = () => { ro.disconnect(); remove(); };
  return c;
}

function initChart() {
  const el = $("#chart");
  chart = makeChart(el, {
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

function ensureChart() { if (!chart) initChart(); }

async function loadChart(sym) {
  // the dashboard may be hidden (recommendations are the landing tab): build/load the chart when it is shown
  if ($("#view-dash").hidden) { loadedChart = null; return; }
  ensureChart();
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
  const fit = () => { if ($("#chart").isConnected) chart.timeScale().fitContent(); };
  requestAnimationFrame(fit); setTimeout(fit, 300);
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

connect();

// ================= BACKTEST =================
const f1 = (n) => (n == null ? "–" : (n * 100).toFixed(1) + "%");
const f2 = (n) => (n == null ? "∞" : n.toFixed(2));
let btChart = null, btSeries = {};

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === b));
  for (const v of ["pk", "dash", "bt", "rs"]) $("#view-" + v).hidden = b.dataset.view !== v;
  if (b.dataset.view === "rs") rsInit();
  if (b.dataset.view === "pk") pkInit();
  if (b.dataset.view === "dash") {
    ensureChart();
    if (selected && loadedChart !== selected) loadChart(selected);
    else setTimeout(() => chart.timeScale().fitContent(), 50);
  }
}));
$("#bt-run").addEventListener("click", runBacktest);

function metric(label, val, c = "") { return `<div class="m"><span>${label}</span><b class="${c}">${val}</b></div>`; }

function secCard(title, s, extra = "") {
  const t = s.trades, e = s.equity;
  return `<div class="glass btsec"><h3><span>${title}</span><span>${extra}</span></h3><div class="metrics">
    ${metric("Összes hozam", f1(e.total), cls(e.total))}
    ${metric("Évesített (CAGR)", f1(e.cagr), cls(e.cagr))}
    ${metric("Max drawdown", f1(e.maxdd), "down")}
    ${metric("Sharpe", f2(e.sharpe))}
    ${metric("Ügyletek", t.n)}
    ${metric("Nyerő arány", f1(t.win_rate))}
    ${metric("Profit factor", f2(t.profit_factor), t.profit_factor > 1.2 ? "up" : t.profit_factor < 1 ? "down" : "")}
    ${metric("Átl. ügylet", f1(t.avg), cls(t.avg))}
  </div></div>`;
}

function verdictBox(r) {
  const o = r.stats.out_of_sample, bh = r.benchmark.buyhold;
  const pf = o.trades.profit_factor ?? 99;
  let kind = "", head, body;
  if (pf >= 1.3 && o.equity.sharpe >= 0.8) { kind = "good"; head = "Biztató, de még nem bizonyíték"; body = "A kontroll időszakon is nyereséges a szabályrendszer."; }
  else if (pf < 1.1) { kind = "bad"; head = "Nincs bizonyított előny a kontroll időszakon"; body = `A kontroll (out-of-sample) időszakon a profit factor ${f2(o.trades.profit_factor)}, ami gyakorlatilag nulla várható érték költségek után. Éles pénzzel ezt a szabálykészletet még nem érdemes követni, finomítani kell.`; }
  else { head = "Gyenge-közepes előny"; body = "A kontroll időszakon pozitív, de vékony az edge."; }
  const lag = r.stats.all.equity.total < bh.total
    ? ` A passzív vásárlás-és-tartás (${f1(bh.total)}) ugyanezen a mintán többet hozott, a stratégia (${f1(r.stats.all.equity.total)}) viszont kisebb drawdownnal (${f1(r.stats.all.equity.maxdd)} vs ${f1(bh.maxdd)}) és ${f1(r.exposure)} piaci kitettséggel működött.` : "";
  return `<div class="glass verdict ${kind}"><div><b>${head}</b><span class="muted">${body}${lag}
    <br><i>Figyelem: a watchlist ma is népszerű mega-capekből áll (túlélési torzítás: a buy&hold itt kedvezőbbnek látszik a valóságnál), a minta 1 piaci ciklus.</i></span></div></div>`;
}

async function runBacktest() {
  const btn = $("#bt-run"), th = $("#bt-th").value, yrs = $("#bt-years").value;
  btn.disabled = true; btn.innerHTML = `<span class="spin"></span>Fut…`;
  $("#bt-body").innerHTML = `<div class="glass empty"><span class="spin"></span>Szimuláció fut ${snap?.watchlist.length || ""} tickeren… (első alkalommal ~10–20 mp)</div>`;
  try {
    const r = await fetch(`/api/backtest?threshold=${th}&years=${yrs}`);
    if (!r.ok) throw new Error((await r.json()).detail || "Hiba");
    const res = await r.json();
    renderBacktest(res);
    loadSweep(yrs);
  } catch (e) {
    $("#bt-body").innerHTML = `<div class="glass empty">Hiba: ${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = "Futtatás"; }
}

function renderBacktest(r) {
  const st = r.stats;
  $("#bt-body").innerHTML = `
    ${verdictBox(r)}
    <div class="btgrid">
      ${secCard("Teljes időszak", st.all, r.period[0] + " → " + r.period[1])}
      ${secCard("Tanuló (in-sample)", st.in_sample, "→ " + r.split_date)}
      ${secCard("Kontroll (out-of-sample)", st.out_of_sample, r.split_date + " →")}
    </div>
    <div class="glass" style="padding:18px 20px">
      <div class="cardhead"><h2>Tőkegörbe (100 = kezdés)</h2>
        <div class="legend"><span class="l" style="--c:#8b8cff"><i class="sw" style="background:#8b8cff"></i>Stratégia</span><span class="l"><i class="sw" style="background:#fbbf24"></i>Buy&amp;hold watchlist</span><span class="l"><i class="sw" style="background:#9aa4c7"></i>SPY</span></div></div>
      <div id="bt-chart"></div>
    </div>
    <div class="glass" id="sweep-card" style="padding:18px 20px"><div class="cardhead"><h2>Küszöb-összehasonlítás</h2></div><div class="muted"><span class="spin"></span>Számolás…</div></div>
    <div class="btcols">
      <div class="glass"><div class="cardhead"><h2>Tickerenként</h2></div><div class="tablewrap short"><table><thead><tr><th>Ticker</th><th class="r">Ügylet</th><th class="r">Nyerő</th><th class="r">Stratégia</th><th class="r">Buy&amp;hold</th></tr></thead><tbody>
        ${r.per_symbol.map((p) => `<tr style="cursor:default"><td class="sym">${esc(p.symbol)}</td><td class="r">${p.n}</td><td class="r">${f1(p.win_rate)}</td><td class="r ${cls(p.strategy)}">${f1(p.strategy)}</td><td class="r ${cls(p.buyhold)}">${f1(p.buyhold)}</td></tr>`).join("")}
      </tbody></table></div></div>
      <div class="glass"><div class="cardhead"><h2>Utolsó ügyletek</h2></div><div class="tablewrap short"><table><thead><tr><th>Ticker</th><th>Belépő</th><th>Kilépő</th><th class="r">Hozam</th><th>Ok</th></tr></thead><tbody>
        ${r.trades.slice(0, 60).map((t) => `<tr style="cursor:default"><td class="sym">${esc(t.symbol)}</td><td>${t.entry_date.slice(2)}</td><td>${t.exit_date.slice(2)}</td><td class="r ${cls(t.ret)}">${pct(t.ret * 100)}</td><td class="muted small">${esc(t.reason)}</td></tr>`).join("")}
      </tbody></table></div></div>
    </div>`;
  drawEquity(r.curves);
}

function drawEquity(c) {
  if (btChart) { btChart.remove(); btChart = null; }
  btChart = makeChart($("#bt-chart"), {
    layout: { background: { color: "transparent" }, textColor: "#9aa4c7", fontFamily: "inherit" },
    grid: { vertLines: { color: "rgba(255,255,255,.05)" }, horzLines: { color: "rgba(255,255,255,.05)" } },
    rightPriceScale: { borderColor: "rgba(255,255,255,.12)" }, timeScale: { borderColor: "rgba(255,255,255,.12)" },
  });
  const add = (data, color, w) => { const s = btChart.addLineSeries({ color, lineWidth: w, priceLineVisible: false }); s.setData(data); return s; };
  add(c.buyhold, "#fbbf24", 1); if (c.spy.length) add(c.spy, "#9aa4c7", 1); add(c.strategy, "#8b8cff", 3);
  btChart.timeScale().fitContent();
  const mine = btChart, fit = () => { if (btChart === mine) mine.timeScale().fitContent(); };
  requestAnimationFrame(fit); setTimeout(fit, 300);
}

async function loadSweep(yrs) {
  try {
    const rows = await (await fetch(`/api/backtest/sweep?years=${yrs}`)).json();
    const el = $("#sweep-card"); if (!el) return;
    el.innerHTML = `<div class="cardhead"><h2>Küszöb-összehasonlítás</h2><span class="muted small">Magasabb küszöb = szigorúbb, ritkább BUY</span></div>
      <div class="tablewrap"><table class="sweep"><thead><tr><th>Küszöb</th><th class="r">Ügylet</th><th class="r">Nyerő</th><th class="r">Profit factor</th><th class="r">Hozam (össz.)</th><th class="r">Max DD</th><th class="r">Sharpe</th><th class="r">Kontroll PF</th><th class="r">Kontroll hozam</th></tr></thead><tbody>
      ${rows.map((x) => `<tr style="cursor:default"><td class="sym">≥ ${x.threshold}</td><td class="r">${x.all.trades.n}</td><td class="r">${f1(x.all.trades.win_rate)}</td><td class="r">${f2(x.all.trades.profit_factor)}</td><td class="r ${cls(x.all.equity.total)}">${f1(x.all.equity.total)}</td><td class="r down">${f1(x.all.equity.maxdd)}</td><td class="r">${f2(x.all.equity.sharpe)}</td><td class="r"><b>${f2(x.out_of_sample.trades.profit_factor)}</b></td><td class="r ${cls(x.out_of_sample.equity.total)}">${f1(x.out_of_sample.equity.total)}</td></tr>`).join("")}
      </tbody></table></div>`;
  } catch (e) { /* non-critical */ }
}

// ================= RESEARCH =================
let rsPoll = null, rsData = null, rsH = "10", rsCharts = [];

function rsInit() {
  if (rsData || rsPoll) return;
  rsStatus(true);
}
$("#rs-run").addEventListener("click", async () => {
  const r = await fetch("/api/research/start", { method: "POST" });
  if (!(await r.json()).started) toast("Már fut egy kutatás", true);
  rsStatus(false);
});

async function rsStatus(full) {
  clearTimeout(rsPoll); rsPoll = null;
  try {
    const s = await (await fetch(`/api/research/status?full=${full}`)).json();
    const prog = $("#rs-prog");
    if (s.status === "running") {
      prog.hidden = false; $("#rs-run").disabled = true;
      $("#rs-msg").textContent = s.message; $("#rs-pct").textContent = Math.round(s.progress * 100) + "%";
      $("#rs-bar").style.width = s.progress * 100 + "%";
      rsPoll = setTimeout(() => rsStatus(false), 1500);
    } else if (s.status === "done") {
      prog.hidden = true; $("#rs-run").disabled = false;
      if (full || !rsData) {
        const d = await (await fetch("/api/research/status?full=true")).json();
        rsData = d.result; renderResearch();
      } else { rsStatus(true); }
    } else if (s.status === "error") {
      prog.hidden = true; $("#rs-run").disabled = false; toast("Kutatás hiba: " + s.message, true);
    }
  } catch (e) { rsPoll = setTimeout(() => rsStatus(false), 3000); }
}

function lines(el, defs) {
  const c = makeChart(el, {
    layout: { background: { color: "transparent" }, textColor: "#9aa4c7", fontFamily: "inherit" },
    grid: { vertLines: { color: "rgba(255,255,255,.05)" }, horzLines: { color: "rgba(255,255,255,.05)" } },
    rightPriceScale: { borderColor: "rgba(255,255,255,.12)" }, timeScale: { borderColor: "rgba(255,255,255,.12)" },
  });
  defs.forEach(([data, color, w]) => { if (!data || !data.length) return; const s = c.addLineSeries({ color, lineWidth: w, priceLineVisible: false }); s.setData(data); });
  const fit = () => { if (!c.dead && el.isConnected) c.timeScale().fitContent(); };
  fit(); requestAnimationFrame(fit); setTimeout(fit, 300);
  rsCharts.push(c);
}
const legend = (items) => `<div class="legend">${items.map(([n, c]) => `<span class="l"><i class="sw" style="background:${c}"></i>${n}</span>`).join("")}</div>`;
const bps = (n) => (n == null ? "–" : (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%");

function renderResearch() {
  rsCharts.forEach((c) => { c.dead = true; c.remove(); }); rsCharts = [];
  const d = rsData; if (!d) return;
  $("#rs-gen").textContent = `${d.n_symbols} ticker · ${d.data_period[0]} → ${d.data_period[1]} · futtatva: ${d.generated}`;
  const wf = d.walkforward, un = d.universe;
  const t4 = un.thresholds.find((x) => x.threshold === 4);

  // ---- overall verdict
  const sel = wf.selected, bh = wf.buyhold;
  const pf = sel.trades.profit_factor;
  const posFactors = d.factors["10"].rows.filter((r) => r.verdict === "positive");
  const liveEdge = posFactors.filter((r) => r.in_score).length, newEdge = posFactors.filter((r) => !r.in_score);
  let kind = "bad", head = "Nincs bizonyított előny, ezzel a szabálykészlettel nem érdemes élesben kereskedni";
  if (sel.equity.sharpe > bh.sharpe && sel.equity.total > 0 && (pf || 0) > 1.3) { kind = "good"; head = "A walk-forward alapján van előny, de tovább kell validálni"; }
  else if (sel.equity.total > 0 && (pf || 0) > 1.15) { kind = ""; head = "Gyenge, de pozitív előny, még nem elég meggyőző"; }
  const verdict = `<div class="glass verdict ${kind}"><div><b>${head}</b><span class="muted">
    Walk-forward (soha nem látott időszakok, ${wf.n_folds} kör): a kiválasztott paraméterekkel <b>${f1(sel.equity.total)}</b> hozam, Sharpe ${f2(sel.equity.sharpe)}, profit factor ${f2(pf)}, max drawdown ${f1(sel.equity.maxdd)}; közben a passzív univerzum-tartás ${f1(bh.total)} (Sharpe ${f2(bh.sharpe)}), az SPY ${f1(wf.spy.total)}.
    A ${wf.n_combos} paraméter-kombinációból ${wf.grid_span.n_positive} pozitív, ${wf.grid_span.n_beat_bh_sharpe} jobb Sharpe-ú a passzív tartásnál ugyanebben az időszakban.
    Az egyedi tényezők közül statisztikailag megbízható (|t|≥2, mindkét félidőben azonos irány) előnye: ${posFactors.length ? posFactors.map((r) => esc(r.label)).join(", ") : "egynek sincs"} (10 napos horizont).
    <br><i>Torzítások: a jelenlegi S&amp;P 500 tagok listáján túlélési torzítás van (a ma is bennlévő cégek utólag "nyertesek"), ezért a buy&hold itt a valóságosnál kedvezőbb. A többszörös tesztelés miatt a kis t-értékek (2–3) sem végleges bizonyíték.</i></span></div></div>`;

  // ---- factors
  const fh = d.factors;
  const factorCard = `<div class="glass rsec"><div class="cardhead"><h2>① Tényezők: van-e előrejelző erejük?</h2>
      <div class="seg" id="seg-h">${["5", "10", "20"].map((h) => `<button data-h="${h}" class="${h === rsH ? "on" : ""}">${h} napos hozam</button>`).join("")}</div></div>
    <p class="lead">Minden jelzés után másnap nyitáson belépünk és N napig tartunk. A "többlet" a piac aznapi átlagához képesti hozam, így a trend (a piac felfelé tart) nem torzít. A t-érték ≥ 2 és két félidőben azonos irány kell a "van előny" minősítéshez.</p>
    <div class="tablewrap" id="ftab-wrap"><table><thead><tr><th>Tényező</th><th class="r">Esemény</th><th class="r">Átl. hozam</th><th class="r">Többlet</th><th class="r">Nyerő</th><th>t-érték</th><th class="r">1. fél</th><th class="r">2. fél</th><th>Ítélet</th></tr></thead><tbody id="ftab"></tbody></table></div></div>`;

  // ---- universe
  const urows = un.thresholds.map((x) => `<tr style="cursor:default"><td class="sym">BUY ≥ ${x.threshold}</td><td class="r">${x.all.trades.n}</td><td class="r">${f1(x.all.trades.win_rate)}</td><td class="r">${f2(x.all.trades.profit_factor)}</td><td class="r ${cls(x.all.equity.total)}">${f1(x.all.equity.total)}</td><td class="r down">${f1(x.all.equity.maxdd)}</td><td class="r">${f2(x.all.equity.sharpe)}</td><td class="r">${f1(x.exposure)}</td><td class="r"><b>${f2(x.out_of_sample.trades.profit_factor)}</b></td><td class="r ${cls(x.out_of_sample.equity.total)}">${f1(x.out_of_sample.equity.total)}</td></tr>`).join("");
  const years = Object.keys(un.yearly.strategy);
  const yrow = (n, k) => `<tr style="cursor:default"><td class="sym">${n}</td>${years.map((y) => { const v = un.yearly[k][y]; return `<td class="r ${cls(v)}">${f1(v)}</td>`; }).join("")}</tr>`;
  const uniCard = `<div class="glass rsec"><div class="cardhead"><h2>② Stratégia a teljes univerzumon (${un.n_symbols} részvény)</h2>${legend([["Stratégia (BUY≥4)", "#8b8cff"], ["Univerzum buy&hold", "#fbbf24"], ["SPY", "#9aa4c7"]])}</div>
    <p class="lead">Egyenlő súlyú portfólió: minden részvény egy szeletet kap, ami pozíció nélkül készpénz. Időszak: ${un.period[0]} → ${un.period[1]}; kontroll-időszak: ${un.split_date} után.</p>
    <div id="rs-uni-chart" class="rs-chart"></div>
    <div class="tablewrap" style="margin-top:14px"><table><thead><tr><th>Szabály</th><th class="r">Ügylet</th><th class="r">Nyerő</th><th class="r">PF</th><th class="r">Hozam</th><th class="r">Max DD</th><th class="r">Sharpe</th><th class="r">Kitettség</th><th class="r">Kontroll PF</th><th class="r">Kontroll hozam</th></tr></thead><tbody>${urows}</tbody></table></div>
    <div class="tablewrap" style="margin-top:14px"><table><thead><tr><th>Évenként</th>${years.map((y) => `<th class="r">${y}</th>`).join("")}</tr></thead><tbody>${yrow("Stratégia", "strategy")}${yrow("Buy&hold", "buyhold")}${yrow("SPY", "spy")}</tbody></table></div></div>`;

  // ---- walk-forward
  const kp = (t, e, extra = "") => `<div class="glass btsec"><h3><span>${t}</span></h3><div class="metrics">${metric("Hozam", f1(e.total), cls(e.total))}${metric("Sharpe", f2(e.sharpe))}${metric("Max DD", f1(e.maxdd), "down")}${metric("Évesített", f1(e.cagr), cls(e.cagr))}</div></div>`;
  const frows = wf.folds.map((f, i) => `<tr style="cursor:default"><td>${i + 1}</td><td class="muted small">${f.test[0]} → ${f.test[1]}</td><td>küszöb ${f.params.thr} · stop ${f.params.stop_atr} · cél ${f.params.target_atr} ATR</td><td class="r">${f2(f.train_sharpe)}</td><td class="r ${cls(f.test_return)}">${f1(f.test_return)}</td><td class="r ${cls(f.default_return)}">${f1(f.default_return)}</td><td class="r ${cls(f.buyhold_return)}">${f1(f.buyhold_return)}</td></tr>`).join("");
  const wfCard = `<div class="glass rsec"><div class="cardhead"><h2>③ Walk-forward (${wf.n_folds} kör)</h2>${legend([["Kiválasztott paraméterek", "#8b8cff"], ["Alapértelmezett (4/2/3)", "#34d399"], ["Univerzum buy&hold", "#fbbf24"], ["SPY", "#9aa4c7"]])}</div>
    <p class="lead">Minden körben a ${Math.round(wf.train_bars / 252)} éves tanuló szakaszon kiválasztjuk a legjobb paramétereket (BUY-küszöb × stop × célár, ${wf.n_combos} kombináció), majd egy soha nem látott ${wf.test_bars / 21} hónapos szakaszon mérjük őket. A görbe csak ezekből a kontroll-szakaszokból áll (${wf.oos_period[0]} → ${wf.oos_period[1]} fedésben).</p>
    <div class="kpi4">${kp("Kiválasztott", sel.equity)}${kp("Alapértelmezett 4/2/3", wf.default.equity)}${kp("Univerzum buy&hold", wf.buyhold)}${kp("SPY", wf.spy)}</div>
    <div id="rs-wf-chart" class="rs-chart"></div>
    <div class="tablewrap short" style="margin-top:14px"><table><thead><tr><th>#</th><th>Kontroll-szakasz</th><th>Kiválasztott paraméterek</th><th class="r">Tanuló Sharpe</th><th class="r">Kontroll hozam</th><th class="r">Alapért.</th><th class="r">Buy&amp;hold</th></tr></thead><tbody>${frows}</tbody></table></div></div>`;

  $("#rs-body").innerHTML = verdict + factorCard + uniCard + wfCard;
  renderFactorRows();
  $("#seg-h").addEventListener("click", (e) => { const b = e.target.closest("[data-h]"); if (!b) return; rsH = b.dataset.h; document.querySelectorAll("#seg-h button").forEach((x) => x.classList.toggle("on", x === b)); renderFactorRows(); });
  lines($("#rs-uni-chart"), [[un.curves.buyhold, "#fbbf24", 1], [un.curves.spy, "#9aa4c7", 1], [un.curves.strategy, "#8b8cff", 3]]);
  lines($("#rs-wf-chart"), [[wf.curves.buyhold, "#fbbf24", 1], [wf.curves.spy, "#9aa4c7", 1], [wf.curves.default, "#34d399", 1], [wf.curves.selected, "#8b8cff", 3]]);
}

function renderFactorRows() {
  const fh = rsData.factors[rsH], maxT = Math.max(...fh.rows.map((r) => Math.abs(r.t)), 3);
  const verd = { positive: "Van előny", negative: "Káros jel", unstable: "Instabil", none: "Nincs bizonyíték" };
  $("#ftab").innerHTML = `<tr style="cursor:default" class="muted"><td>Piaci átlag (alap)</td><td class="r">–</td><td class="r">${bps(fh.baseline.avg)}</td><td class="r">0</td><td class="r">${f1(fh.baseline.win_rate)}</td><td></td><td></td><td></td><td></td></tr>` +
    fh.rows.map((r) => `<tr style="cursor:default"><td>${esc(r.label)} <span class="chip ${r.in_score ? "live" : "new"}">${r.in_score ? "pontszámban" : "új ötlet"}</span></td><td class="r">${r.n.toLocaleString("hu-HU")}</td><td class="r ${cls(r.avg)}">${bps(r.avg)}</td><td class="r ${cls(r.excess)}"><b>${bps(r.excess)}</b></td><td class="r">${f1(r.win_rate)}</td><td>${r.t.toFixed(1)}<i class="tbar" style="width:${Math.abs(r.t) / maxT * 70}px;background:${r.t >= 0 ? "var(--up)" : "var(--down)"}"></i></td><td class="r ${cls(r.half1)}">${bps(r.half1)}</td><td class="r ${cls(r.half2)}">${bps(r.half2)}</td><td><span class="chip ${r.verdict}">${verd[r.verdict]}</span></td></tr>`).join("");
}

// ================= RECOMMENDATIONS =================
let pk = null, pkH = "126", pkPoll = null, pkScreen = { cat: "ALL", sector: "ALL", q: "", sort: "score", dir: -1, limit: 40 };
const HLABEL = { "21": "1 hónap", "63": "3 hónap", "126": "6 hónap" };
const HDAYS = { "21": 30, "63": 91, "126": 182 };
const CAT = { TREND: ["Erős trend", "good"], NEUTRAL: ["Semleges", ""], RISK: ["Magas kockázat", "bad"] };
let pkPortfolio = 0;
try { pkPortfolio = +localStorage.getItem("pk_portfolio") || 0; } catch (e) { }

function pkInit() { if (!pk && !pkPoll) pkLoad(); }

async function pkLoad() {
  clearTimeout(pkPoll); pkPoll = null;
  try {
    const d = await (await fetch("/api/picks")).json();
    if (d.result) { pk = d.result; renderPicks(); }
    if (d.status === "running") {
      if (!pk) $("#pk-hero").innerHTML = `<div class="empty" style="grid-column:1/-1"><span class="spin"></span>${esc(d.message)} (${Math.round(d.progress * 100)}%) · első betöltésnél ~1–2 perc</div>`;
      pkPoll = setTimeout(pkLoad, 2000);
    } else if (d.status === "error") {
      $("#pk-hero").innerHTML = `<div class="empty" style="grid-column:1/-1">Hiba: ${esc(d.message)}</div>`;
    }
  } catch (e) { pkPoll = setTimeout(pkLoad, 3000); }
}

const sgn = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(0) + "%";
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");

function confidence() {
  const t = pk.history[pkH]?.TREND;
  const sig = t && Math.abs(t.t) >= 2 && Math.sign(t.half1) === Math.sign(t.half2);
  return sig ? { lvl: 2, name: "Közepes", t } : { lvl: 1, name: "Alacsony", t };
}

function renderPicks() {
  const m = pk.market, c = confidence(), t = c.t;
  const head = m.regime
    ? `A piac emelkedő trendben van, a trendkövető jelöltek keresése indokolt`
    : `A piac nem emelkedő trendben van, óvatosság: most nincs új „erős trend" jelölt`;
  $("#pk-hero").innerHTML = `
    <div>
      <h2>${esc(head)}</h2>
      <p class="sub">Az alábbiakban az S&amp;P 500 ${m.n} részvényéből azok szerepelnek, amelyek <b>most</b> a legerősebb, legkevésbé kockázatos trendben vannak, és azok, amelyeket jobb elkerülni. Adatok: ${esc(pk.date)} zárás.</p>
      <div class="facts">
        <div class="fact"><span>S&amp;P 500 (SPY) az EMA200-hoz képest</span><b class="${cls(m.spy_d200)}">${sgn(m.spy_d200)}</b></div>
        <div class="fact"><span>Részvények az EMA200 felett</span><b>${(m.breadth * 100).toFixed(0)}%</b></div>
        <div class="fact"><span>Erős trend jelölt</span><b class="up">${m.n_trend}</b></div>
        <div class="fact"><span>Magas kockázat</span><b class="down">${m.n_risk}</b></div>
      </div>
      <div class="pfin"><label class="muted small" style="display:flex;align-items:center;gap:8px">Portfóliód összege ($) a pozícióméretekhez
        <input id="pk-pf" type="number" min="0" step="100" placeholder="pl. 10000" value="${pkPortfolio || ""}"></label></div>
    </div>
    <div class="conf"><h3>Bizonyossági szint: ${c.name}</h3>
      <div class="meter"><i class="on"></i><i class="${c.lvl >= 2 ? "on" : ""}"></i><i></i></div>
      <p>${t ? `A múltban az „erős trend" csoport ${HLABEL[pkH]} alatt a piacnál átlagosan <b>${Math.abs(t.excess * 100).toFixed(1)}%-kal</b> ${t.excess >= 0 ? "jobban" : "rosszabbul"} teljesített (t=${t.t.toFixed(1)}), ami ${c.lvl >= 2 ? "statisztikailag megbízható" : "<b>nem megbízható</b> különbség"}. ` : ""}A jelölt tehát <b>nem garantált nyertes</b>: azt mutatja, hol a legkedvezőbb a kép, nem azt, hogy mi fog felmenni. A hozam-sávok a részvény saját ingadozásából számolt becslések, nem előrejelzések.</p>
    </div>`;

  const by = Object.fromEntries(pk.rows.map((r) => [r.symbol, r]));
  const sel = (arr) => arr.map((s) => by[s]).filter(Boolean);
  $("#pk-body").innerHTML = `
    <section><div class="sechead"><div><h2>Mire érdemes figyelni most</h2>
      <p>Erős trendben lévő, nem szélsőségesen ingadozó részvények, kockázattal korrigált momentum szerint rangsorolva, szektoronként legfeljebb 2. <b>Javasolt tartási idő: 3–6 hónap</b>: a vizsgálatunk szerint heti-napi horizonton semmilyen jelnek nincs előnye.</p></div>
      <div class="seg" id="pk-h">${["21", "63", "126"].map((h) => `<button data-h="${h}" class="${h === pkH ? "on" : ""}">${HLABEL[h]}</button>`).join("")}</div></div>
      <div class="cards" id="pk-top" style="margin-top:14px">${sel(pk.top).map((r) => card(r, false)).join("") || `<div class="glass empty" style="grid-column:1/-1">Jelenleg nincs a feltételeknek megfelelő jelölt.</div>`}</div></section>
    <section><div class="sechead"><div><h2>Mibe ne fektess most</h2>
      <p>Nincs emelkedő trend, gyenge relatív erő, gyakran mély esés után. Fontos: a múlt <b>nem</b> mutatta, hogy ezek biztosan rosszabbul teljesítenek, ez kockázati óvatosság: nincs mellettük trend, és nagyobb a hozamuk szórása.</p></div></div>
      <div class="cards" id="pk-avoid" style="margin-top:14px">${sel(pk.avoid).map((r) => card(r, true)).join("")}</div></section>
    <section class="glass rsec" id="pk-hist"></section>
    <section class="glass rsec" id="pk-screen"></section>
    <details class="glass"><summary>Hogyan készülnek ezek a számok? Mit tudunk és mit nem?</summary><div class="meth">
      <div><b>Besorolás.</b> <i>Erős trend</i>: a piac (SPY) az EMA200 felett, a részvény az EMA200 felett és EMA50&gt;EMA200, a 6 és 12 hónapos (az utolsó hónapot kihagyó) hozama együtt legalább a 60. percentilisben van az S&amp;P 500-on belül. <i>Magas kockázat</i>: az ár az EMA200 alatt és a momentum a gyengébb 40%-ban. A küszöböket előre rögzítettem, nem utólag hangoltam.</div>
      <div><b>Rangsor.</b> A jelöltek között a 12 hónapos hozam / éves volatilitás szerint rendezek (kockázattal korrigált erő), a spekulatív (&gt;70% éves volatilitású) papírokat a top listából kizárom. Ez észszerű heurisztika, de a múltbeli adaton külön nem validáltam.</div>
      <div><b>Hozam-sáv.</b> Feltevés: hosszú távú piaci hozam ${(pk.assumptions.drift * 100).toFixed(0)}%/év, a szórás a részvény saját (60 és 252 napos) volatilitása, lognormális eloszlással. A „jó/rossz eset" a 90./10. percentilis. <b>Ez nem tartalmaz részvény-specifikus előrejelzést</b>, mert a vizsgálat nem talált megbízható előnyt.</div>
      <div><b>Védő stop és pozícióméret.</b> Stop: ár − ${pk.assumptions.stop_atr}×ATR. Pozícióméret: a portfólió ${(pk.assumptions.risk_per_trade * 100).toFixed(0)}%-át kockáztatod a stoppig, legfeljebb ${(pk.assumptions.max_pos * 100).toFixed(0)}% egy részvényben.</div>
      <div><b>Torzítások.</b> A lista a mai S&amp;P 500 tagjaiból áll (túlélési torzítás), a vizsgált időszak ${esc(pk.history_period[0])} – ${esc(pk.history_period[1])}, nagyrészt emelkedő piac. A fundamentumokat (eredmény, értékeltség), hírt, esedékes eredményjelentést <b>nem</b> vizsgálja. Ezeket vásárlás előtt magadnak kell ellenőrizned. Az oldal nem pénzügyi tanácsadás.</div>
    </div></details>`;

  $("#pk-pf").addEventListener("change", (e) => { pkPortfolio = +e.target.value || 0; try { localStorage.setItem("pk_portfolio", pkPortfolio); } catch (x) { } renderPicks(); });
  $("#pk-h").addEventListener("click", (e) => { const b = e.target.closest("[data-h]"); if (b) { pkH = b.dataset.h; renderPicks(); } });
  $("#pk-body").addEventListener("click", pkClick);
  renderHistory(); renderScreener();
}

function card(r, risk) {
  const o = r.outlook[pkH];
  const lo = -0.6, hi = 1.0, pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const reasonsHtml = r.reasons.map((x, i) => `<li class="${x.k}${i >= 3 ? " more" : ""}">${esc(x.t)}</li>`).join("");
  const bandHtml = risk ? "" : `
    <div><div class="band"><div class="track"></div>
      <div class="rng" style="left:${pos(o.lo)}%;width:${pos(o.hi) - pos(o.lo)}%"></div>
      <div class="zero" style="left:${pos(0)}%"></div><div class="mid" style="left:${pos(o.mid)}%"></div>
      <span class="lbl md" style="left:${pos(o.mid)}%">medián ≈ ${sgn(o.mid)}</span>
      <span class="lbl lo" style="left:${Math.max(8, pos(o.lo))}%">${sgn(o.lo)}</span>
      <span class="lbl hi" style="left:${Math.min(92, pos(o.hi))}%">${sgn(o.hi)}</span></div>
      <div class="bandnote">${HLABEL[pkH]} alatt, 80%-os sáv (rossz ↔ jó eset). Esély a pozitív hozamra: <b>${(o.p_up * 100).toFixed(0)}%</b>${r.vol > 0.5 ? " · nagy ingadozásnál a medián az átlagos hozam alatt van (volatilitási veszteség)" : ""}</div></div>`;
  const amount = pkPortfolio ? ` ≈ ${money(pkPortfolio * r.size_pct)} (${Math.floor((pkPortfolio * r.size_pct) / r.price)} db)` : "";
  const hold = risk ? "" : `<div class="hold">
      <div><span>Javasolt tartás</span><b>3–6 hónap</b></div>
      <div><span>Felülvizsgálat</span><b>${addDays(pk.date, 182)}</b></div>
      <div><span>Védő stop</span><b class="down">${usd(r.stop)} (${sgn(-r.stop_pct)})</b></div>
      <div><span>Max. pozícióméret</span><b>${(r.size_pct * 100).toFixed(0)}%${amount}</b></div></div>
    <div class="plan"><b>Kilépés:</b> EMA200 alá záráskor vagy ${usd(r.stop)} alatt; a stop 3×ATR-rel követi a csúcsot.</div>`;
  const cat = CAT[r.cat];
  return `<div class="glass pcard ${risk ? "risk" : ""}" data-s="${esc(r.symbol)}">
    <div class="pc-top"><div><div class="pc-sym">${esc(r.symbol)}</div><div class="pc-name">${esc(r.name)}</div></div>
      <div class="pc-price"><b>${usd(r.price)}</b><span class="${cls(r.chg)}">${sgn(r.chg)} ma</span></div></div>
    <div class="tags"><span class="tag ${cat[1]}">${cat[0]}</span><span class="tag">${esc(r.sector)}</span>${r.spec ? '<span class="tag warn">spekulatív</span>' : ""}${r.ext && !risk ? '<span class="tag warn">felfűtött</span>' : ""}<span class="tag">vol ${(r.vol * 100).toFixed(0)}%/év</span></div>
    ${bandHtml}${hold}
    <ul class="rs">${reasonsHtml}</ul>
    <div class="pc-actions">${r.reasons.length > 3 ? `<button class="btn sm line" data-act="more">Részletek</button>` : ""}
      <button class="btn sm line" data-act="chart">Chart</button>${risk ? "" : `<button class="btn sm" data-act="bought">Megvettem</button>`}</div>
  </div>`;
}

async function pkClick(e) {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const card = b.closest("[data-s]"), sym = card.dataset.s;
  if (b.dataset.act === "more") { card.classList.toggle("open"); b.textContent = card.classList.contains("open") ? "Kevesebb" : "Részletek"; return; }
  const r = pk.rows.find((x) => x.symbol === sym);
  if (b.dataset.act === "chart") { await showOnDashboard(sym); return; }
  if (b.dataset.act === "bought") {
    if (!(await api("POST", "/api/watchlist", { symbol: sym }))) return;
    document.querySelector('[data-view=dash]').click();
    const f = $("#add-pos"); f.symbol.value = sym; f.entry_price.value = r.price.toFixed(2); f.qty.focus();
    f.scrollIntoView({ behavior: "smooth", block: "center" });
    toast(`${sym}: add meg a darabszámot, és rögzítsd a pozíciót`);
  }
}

async function showOnDashboard(sym) {
  if (!snap || !snap.watchlist.find((w) => w.symbol === sym)) { if (!(await api("POST", "/api/watchlist", { symbol: sym }))) return; }
  document.querySelector('[data-view=dash]').click();
  setTimeout(() => { loadedChart = null; selectSymbol(sym); }, 400);
}

function renderHistory() {
  const H = pk.history[pkH]; if (!H) return;
  const rows = [["ALL", "Teljes S&P 500 (viszonyítás)"], ["TREND", "Erős trend (jelölt)"], ["TREND_CLEAN", "ebből nem felfűtött"], ["TREND_HOT", "ebből felfűtött"], ["NEUTRAL", "Semleges"], ["RISK", "Magas kockázat"]];
  const ver = (v) => { if (!v || v.t == null) return `<span class="chip">viszonyítás</span>`; const ok = Math.abs(v.t) >= 2 && Math.sign(v.half1) === Math.sign(v.half2); return ok ? `<span class="chip ${v.excess > 0 ? "positive" : "negative"}">${v.excess > 0 ? "jobb a piacnál" : "rosszabb a piacnál"}</span>` : `<span class="chip">nincs bizonyíték</span>`; };
  const f = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
  const tr = rows.filter(([k]) => H[k]).map(([k, label]) => { const v = H[k]; return `<tr style="cursor:default"><td>${label}</td><td class="r">${v.n.toLocaleString("hu-HU")}</td><td class="r"><b>${f(v.median)}</b></td><td class="r down">${f(v.p10)}</td><td class="r up">${f(v.p90)}</td><td class="r">${f(v.win)}</td><td class="r ${cls(v.excess)}">${v.excess == null ? "–" : (v.excess > 0 ? "+" : "") + f(v.excess)}</td><td class="r">${v.t == null ? "–" : v.t.toFixed(1)}</td><td>${ver(v)}</td></tr>`; }).join("");
  const T = H.TREND, A = H.ALL, R = H.RISK, HOT = H.TREND_HOT;
  const sig = T && Math.abs(T.t) >= 2;
  const take = [
    T && `Az <b>erős trend</b> jelöltek mediánja ${HLABEL[pkH]} alatt <b>${f(T.median)}</b>, a teljes S&amp;P 500-é ${f(A.median)}. A piachoz mért többlet ${(T.excess > 0 ? "+" : "") + f(T.excess)} (t=${T.t.toFixed(1)}): ${sig ? "statisztikailag kimutatható, de" : "<b>statisztikailag nem megbízható</b>,"} ezért a „jelölt" nem jelent bizonyított előnyt.`,
    R && `A <b>magas kockázatú</b> csoport mediánja ${f(R.median)}, tehát a múltban <b>nem</b> maradt el a piactól. A „ne fektess" üzenet kockázatról szól (nincs trend, nagyobb szórás), nem biztos veszteségről.`,
    HOT && `A <b>felfűtött</b> erős-trend papírok a múltban jobban szerepeltek (${(HOT.excess > 0 ? "+" : "") + f(HOT.excess)} többlet), de ez kevés, egymást átfedő eseményen és főleg a 2020–2026-os technológiai rali idején történt, ezért nem tekintem megbízható jelnek, és a „felfűtött" címke csak figyelmeztetés.`,
    `A <b>10–90% sáv</b> mutatja, mekkora volt a valódi szórás: a kimenetelek 80%-a ${f(A.p10)} és ${f(A.p90)} közé esett ${HLABEL[pkH]} alatt, azaz bármelyik részvényre erős a bizonytalanság.`,
  ].filter(Boolean).map((t) => `<div>${t}</div>`).join("");
  $("#pk-hist").innerHTML = `<div class="cardhead"><h2>Mit mutat a múlt? Ugyanezek a szabályok az elmúlt években</h2><span class="muted small">${HLABEL[pkH]} tartás, ${esc(pk.history_period[0])} → ${esc(pk.history_period[1])}</span></div>
    <p class="lead">Ez az ellenőrzés: ha a besorolás működne, a „jelölt" sor mediánja és nyerési aránya a „teljes S&amp;P 500" sor fölött lenne, megbízható t-értékkel (≥2, mindkét félidőben azonos irányban).</p>
    <div class="tablewrap"><table class="hist"><thead><tr><th>Csoport</th><th class="r">Esemény</th><th class="r">Medián hozam</th><th class="r">Rossz eset (10%)</th><th class="r">Jó eset (90%)</th><th class="r">Pozitív</th><th class="r">Többlet</th><th class="r">t</th><th>Ítélet</th></tr></thead><tbody>${tr}</tbody></table></div>
    <div class="takeaway">${take}</div>`;
}

function renderScreener() {
  const S = pkScreen;
  const sectors = [...new Set(pk.rows.map((r) => r.sector))].sort();
  let rows = pk.rows.filter((r) => (S.cat === "ALL" || r.cat === S.cat) && (S.sector === "ALL" || r.sector === S.sector) &&
    (!S.q || (r.symbol + " " + r.name).toLowerCase().includes(S.q.toLowerCase())));
  const key = { score: (r) => r.score, mrank: (r) => r.mrank, m61: (r) => r.m61, vol: (r) => r.vol, p_up: (r) => r.outlook[pkH].p_up, price: (r) => r.price, symbol: (r) => r.symbol, dd52: (r) => r.dd52 }[S.sort];
  rows.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * S.dir);
  const total = rows.length; rows = rows.slice(0, S.limit);
  const th = (k, l, cl = "") => `<th class="sortable ${cl}" data-sort="${k}">${l}${S.sort === k ? (S.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
  $("#pk-screen").innerHTML = `<div class="cardhead"><h2>Teljes lista (${total} részvény)</h2>
    <div class="filters"><input id="sc-q" placeholder="Keresés…" value="${esc(S.q)}">
      <select id="sc-cat"><option value="ALL">Minden kategória</option><option value="TREND" ${S.cat === "TREND" ? "selected" : ""}>Erős trend</option><option value="NEUTRAL" ${S.cat === "NEUTRAL" ? "selected" : ""}>Semleges</option><option value="RISK" ${S.cat === "RISK" ? "selected" : ""}>Magas kockázat</option></select>
      <select id="sc-sec"><option value="ALL">Minden szektor</option>${sectors.map((x) => `<option ${S.sector === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></div></div>
    <div class="tablewrap" style="max-height:640px"><table><thead><tr>${th("symbol", "Ticker")}<th>Név</th><th>Kategória</th>${th("score", "Kock.korr. erő", "r")}${th("m61", "6 hó hozam", "r")}${th("vol", "Volatilitás", "r")}${th("p_up", "Esély + (" + HLABEL[pkH] + ")", "r")}${th("dd52", "Csúcstól", "r")}${th("price", "Ár", "r")}</tr></thead><tbody>
    ${rows.map((r) => `<tr data-sym="${esc(r.symbol)}"><td class="sym">${esc(r.symbol)}</td><td class="muted small">${esc(r.name)}</td><td><span class="tag ${CAT[r.cat][1]}">${CAT[r.cat][0]}</span>${r.spec ? ' <span class="tag warn">spek.</span>' : ""}</td><td class="r">${r.score.toFixed(2)}</td><td class="r ${cls(r.m61)}">${sgn(r.m61)}</td><td class="r">${(r.vol * 100).toFixed(0)}%</td><td class="r">${(r.outlook[pkH].p_up * 100).toFixed(0)}%</td><td class="r ${cls(r.dd52)}">${sgn(r.dd52)}</td><td class="r">${usd(r.price)}</td></tr>`).join("")}
    </tbody></table></div>${total > S.limit ? `<div style="text-align:center;margin-top:12px"><button class="btn line" id="sc-more">Még ${Math.min(40, total - S.limit)} megjelenítése</button></div>` : ""}`;
  $("#sc-q").addEventListener("input", (e) => { S.q = e.target.value; S.limit = 40; renderScreener(); $("#sc-q").focus(); $("#sc-q").setSelectionRange(S.q.length, S.q.length); });
  $("#sc-cat").addEventListener("change", (e) => { S.cat = e.target.value; S.limit = 40; renderScreener(); });
  $("#sc-sec").addEventListener("change", (e) => { S.sector = e.target.value; S.limit = 40; renderScreener(); });
  $("#sc-more")?.addEventListener("click", () => { S.limit += 40; renderScreener(); });
  $("#pk-screen thead").addEventListener("click", (e) => { const t = e.target.closest("[data-sort]"); if (!t) return; if (S.sort === t.dataset.sort) S.dir *= -1; else { S.sort = t.dataset.sort; S.dir = -1; } renderScreener(); });
  $("#pk-screen tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-sym]"); if (tr) showOnDashboard(tr.dataset.sym); });
}

// the recommendations are the landing page
pkInit();
