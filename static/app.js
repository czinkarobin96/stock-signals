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

initChart();
connect();

// ================= BACKTEST =================
const f1 = (n) => (n == null ? "–" : (n * 100).toFixed(1) + "%");
const f2 = (n) => (n == null ? "∞" : n.toFixed(2));
let btChart = null, btSeries = {};

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === b));
  for (const v of ["dash", "bt", "rs"]) $("#view-" + v).hidden = b.dataset.view !== v;
  if (b.dataset.view === "rs") rsInit();
  if (b.dataset.view === "dash" && chart) setTimeout(() => chart.timeScale().fitContent(), 50);
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
