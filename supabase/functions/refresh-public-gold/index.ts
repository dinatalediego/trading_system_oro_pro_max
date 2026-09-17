import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const SYMBOL = "XAUUSD_PROXY_GC";
const PROVIDER = "yahoo_gc_futures";
const FEATURE_VERSION = "bootstrap_v1";

type Bar = { ts: string; open: number; high: number; low: number; close: number; volume: number | null };
type Feature = { ts: string; close: number; rsi: number | null; atr: number | null; wt1: number | null; wt2: number | null; squeeze: number | null; signal: "BUY" | "SELL" | null };

function ema(v: number[], n: number) { const a = 2 / (n + 1), o: number[] = []; let p = v[0] ?? 0; for (let i = 0; i < v.length; i++) { const x = Number.isFinite(v[i]) ? v[i] : p; p = i === 0 ? x : a * x + (1 - a) * p; o.push(p); } return o; }
function rma(v: number[], n: number) { const a = 1 / n, o: number[] = []; let p = v[0] ?? 0; for (let i = 0; i < v.length; i++) { const x = Number.isFinite(v[i]) ? v[i] : p; p = i === 0 ? x : a * x + (1 - a) * p; o.push(p); } return o; }
function sma(v: number[], i: number, n: number) { if (i + 1 < n) return NaN; let s = 0; for (let j = i - n + 1; j <= i; j++) s += v[j]; return s / n; }
function lr(v: number[], i: number, n: number) { if (i + 1 < n) return NaN; const xb = (n - 1) / 2; let yb = 0; for (let j = 0; j < n; j++) yb += v[i - n + 1 + j]; yb /= n; let a = 0, b = 0; for (let j = 0; j < n; j++) { const dx = j - xb; a += dx * (v[i - n + 1 + j] - yb); b += dx * dx; } return yb + (b ? a / b : 0) * xb; }
function chunks<T>(a: T[], n: number) { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function sigmoid(x: number) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x)))); }

function calc(b: Bar[]): Feature[] {
  const c = b.map(x => x.close), h = b.map(x => x.high), l = b.map(x => x.low), ap = b.map(x => (x.high + x.low + x.close) / 3);
  const chg = c.map((x, i) => i ? x - c[i - 1] : 0), ag = rma(chg.map(x => Math.max(x, 0)), 14), al = rma(chg.map(x => Math.max(-x, 0)), 14);
  const rsi = c.map((_, i) => al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]));
  const tr = b.map((x, i) => i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1]), Math.abs(x.low - c[i - 1]))), atr = rma(tr, 14);
  const esa = ema(ap, 10), dev = ema(ap.map((x, i) => Math.abs(x - esa[i])), 10), ci = ap.map((x, i) => dev[i] === 0 ? 0 : (x - esa[i]) / (.015 * dev[i])), w1 = ema(ci, 21), w2 = w1.map((_, i) => sma(w1, i, 4));
  const sq = c.map((_, i) => { if (i < 19) return NaN; let hh = -Infinity, ll = Infinity; for (let j = i - 19; j <= i; j++) { hh = Math.max(hh, h[j]); ll = Math.min(ll, l[j]); } const base = ((hh + ll) / 2 + sma(c, i, 20)) / 2, vals = c.map(x => x - base), z = lr(vals, i, 20); return Number.isFinite(z) && atr[i] > 0 ? (z / atr[i]) * 15 : NaN; });
  return b.map((x, i) => { const p1 = i ? w1[i - 1] : NaN, p2 = i ? w2[i - 1] : NaN; let s: "BUY" | "SELL" | null = null; if (i && Number.isFinite(w2[i]) && Number.isFinite(p2)) { if (p1 <= p2 && w1[i] > w2[i]) s = "BUY"; else if (p1 >= p2 && w1[i] < w2[i]) s = "SELL"; } return { ts: x.ts, close: x.close, rsi: Number.isFinite(rsi[i]) ? rsi[i] : null, atr: Number.isFinite(atr[i]) ? atr[i] : null, wt1: Number.isFinite(w1[i]) ? w1[i] : null, wt2: Number.isFinite(w2[i]) ? w2[i] : null, squeeze: Number.isFinite(sq[i]) ? sq[i] : null, signal: s }; });
}

function scoreModel(f: Feature, p: any, prevClose: number | null) {
  try {
    const names: string[] = p.feature_names, mu: number[] = p.mean, sd: number[] = p.std, w: number[] = p.weights;
    const raw: Record<string, number> = { rsi_centered: ((f.rsi ?? 50) - 50) / 50, wt_gap: (f.wt1 ?? 0) - (f.wt2 ?? 0), squeeze_scaled: (f.squeeze ?? 0) / 40, return_1: prevClose && prevClose > 0 ? Math.log(f.close / prevClose) : 0, atr_pct: (f.atr ?? 0) / Math.max(f.close, 1) };
    let z = Number(p.intercept ?? 0); for (let i = 0; i < names.length; i++) z += Number(w[i] ?? 0) * ((Number(raw[names[i]] ?? 0) - Number(mu[i] ?? 0)) / Math.max(Number(sd[i] ?? 1), 1e-9)); return sigmoid(z);
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const supplied = req.headers.get("x-refresh-token");
  const { data: tokenRow } = await db.from("runtime_settings").select("value").eq("key", "public_refresh_token").limit(1).maybeSingle();
  if (!tokenRow?.value || supplied !== tokenRow.value) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const { data: recent } = await db.from("data_ingestion_runs").select("started_at").eq("provider", PROVIDER).eq("status", "success").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (recent && now.getTime() - new Date(recent.started_at).getTime() < 120000) return Response.json({ ok: true, skipped: "rate_limit" });

  const { data: run, error: runError } = await db.from("data_ingestion_runs").insert({ provider: PROVIDER, dataset: "GC=F 1m bootstrap", status: "running", details: { canonical: false, proxy_for: "XAUUSD", source: "public" } }).select("id").single();
  if (runError) return Response.json({ ok: false, error: runError.message }, { status: 500 });

  try {
    const { data: lastRow } = await db.from("market_bars").select("ts").eq("symbol", SYMBOL).eq("provider", PROVIDER).order("ts", { ascending: false }).limit(1).maybeSingle();
    const { count: featureCount } = await db.from("gold_market_features").select("ts", { head: true, count: "exact" }).eq("symbol", SYMBOL).eq("feature_set_version", FEATURE_VERSION);
    const needBackfill = (featureCount ?? 0) < 1000, range = (!lastRow || needBackfill) ? "7d" : "1d";
    const marketUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent("GC=F")}?range=${range}&interval=1m&includePrePost=true&events=div%2Csplits`;
    const res = await fetch(marketUrl, { headers: { "User-Agent": "Mozilla/5.0 GoldDecisionLab/1.0" } });
    if (!res.ok) throw new Error(`market source ${res.status}`);
    const payload = await res.json(), result = payload?.chart?.result?.[0];
    if (!result) throw new Error(payload?.chart?.error?.description || "no chart result");
    const timestamps: number[] = result.timestamp || [], q = result.indicators?.quote?.[0] || {}, bars: Bar[] = [];
    for (let i = 0; i < timestamps.length; i++) { const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i]; if ([o, h, l, c].every(v => typeof v === "number" && Number.isFinite(v))) bars.push({ ts: new Date(timestamps[i] * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: typeof q.volume?.[i] === "number" ? q.volume[i] : null }); }
    if (bars.length < 30) throw new Error(`insufficient bars: ${bars.length}`);

    const cutoff = lastRow && !needBackfill ? new Date(new Date(lastRow.ts).getTime() - 120 * 60000).getTime() : 0, writeBars = bars.filter(x => new Date(x.ts).getTime() > cutoff);
    for (const part of chunks(writeBars, 400)) { const rows = part.map(x => ({ symbol: SYMBOL, timeframe: "1m", ts: x.ts, open: x.open, high: x.high, low: x.low, close: x.close, tick_volume: x.volume, provider: PROVIDER, ingestion_run_id: run.id })); const { error } = await db.from("market_bars").upsert(rows, { onConflict: "symbol,timeframe,ts,provider" }); if (error) throw error; }

    const allFeatures = calc(bars), featureWrite = needBackfill ? allFeatures : allFeatures.slice(-360);
    for (const part of chunks(featureWrite, 300)) { const rows = part.map(f => ({ symbol: SYMBOL, ts: f.ts, feature_set_version: FEATURE_VERSION, close: f.close, rsi: f.rsi, atr: f.atr, wt1: f.wt1, wt2: f.wt2, squeeze: f.squeeze, rule_signal: f.signal, features: { provider: PROVIDER, proxy: true }, available_at: f.ts })); const { error } = await db.from("gold_market_features").upsert(rows, { onConflict: "symbol,ts,feature_set_version" }); if (error) throw error; }

    const last = allFeatures.at(-1)!, prevClose = allFeatures.length > 1 ? allFeatures[allFeatures.length - 2].close : null;
    const { data: champion } = await db.from("model_runs").select("model_version,params").eq("model_name", "logistic_direction_15m_proxy").eq("status", "champion").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const { data: riskRow } = await db.from("risk_limits").select("config").eq("name", "global").limit(1).maybeSingle();
    const risk = (riskRow?.config ?? {}) as any;
    const minProbability = Number(risk.min_probability ?? .62), maxTradesPerDay = Number(risk.max_trades_per_day ?? 2), maxOpenPositions = Number(risk.max_open_positions ?? 1);
    const modelP = champion ? scoreModel(last, champion.params, prevClose) : null;
    const sep = (last.wt1 != null && last.wt2 != null) ? Math.abs(last.wt1 - last.wt2) : 0, mom = Math.min(Math.abs(last.squeeze ?? 0) / 40, 1), edge = Math.min(.30, Math.min(sep / 80, .18) + mom * .10);
    const heuristicP = last.signal === "SELL" ? Math.max(.20, .50 - edge) : Math.min(.80, .50 + edge), probability = modelP ?? heuristicP;
    let action: "BUY" | "SELL" | "NO_TRADE" = "NO_TRADE";
    if (last.signal === "BUY" && (last.rsi ?? 50) < 70 && (last.squeeze ?? 0) > 0 && probability >= minProbability) action = "BUY";
    if (last.signal === "SELL" && (last.rsi ?? 50) > 30 && (last.squeeze ?? 0) < 0 && probability <= 1 - minProbability) action = "SELL";
    const modelVersion = champion?.model_version ?? "rules_bootstrap_v1", riskState = champion ? "PAPER_PROXY_MODEL" : "PAPER_PROXY_ONLY";

    const { data: prevPrediction } = await db.from("model_predictions").select("features_ts").eq("symbol", SYMBOL).order("created_at", { ascending: false }).limit(1).maybeSingle();
    let predictionId: number | null = null;
    if (prevPrediction?.features_ts !== last.ts) { const { data: pred, error } = await db.from("model_predictions").insert({ symbol: SYMBOL, prediction_ts: last.ts, horizon_minutes: 15, action, probability, expected_return: null, risk_state: riskState, model_version: modelVersion, features_ts: last.ts, explanation: { proxy: true, rule_signal: last.signal, rsi: last.rsi, wt_spread: sep, squeeze: last.squeeze, model_probability: modelP, min_probability: minProbability, not_for_live_execution: true } }).select("id").single(); if (error) throw error; predictionId = pred.id; }

    const { data: costSetting } = await db.from("runtime_settings").select("value").eq("key", "paper_cost_return").limit(1).maybeSingle();
    const costReturn = Number(costSetting?.value ?? .00015), price = last.close;
    const { data: openOrders } = await db.from("paper_orders").select("id,side,filled_at,fill_price,quantity").eq("symbol", SYMBOL).eq("status", "filled");
    for (const o of openOrders || []) { if (o.filled_at && now.getTime() - new Date(o.filled_at).getTime() >= 15 * 60000) { const gross = (price - Number(o.fill_price)) * (o.side === "BUY" ? 1 : -1) * Number(o.quantity), costs = Math.abs(Number(o.fill_price) * Number(o.quantity)) * costReturn, net = gross - costs; await db.from("execution_outcomes").upsert({ paper_order_id: o.id, closed_at: last.ts, close_price: price, gross_pnl: gross, costs, net_pnl: net, outcome_label: net > 0 ? "WIN" : net < 0 ? "LOSS" : "FLAT", metadata: { proxy: true, cost_return: costReturn, costs_provisional: true, horizon_minutes: 15 } }); await db.from("paper_orders").update({ status: "closed" }).eq("id", o.id); } }

    if (action !== "NO_TRADE" && predictionId) { const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0); const { count: dailyCount } = await db.from("paper_orders").select("id", { count: "exact", head: true }).eq("symbol", SYMBOL).gte("requested_at", dayStart.toISOString()); const { count: openCount } = await db.from("paper_orders").select("id", { count: "exact", head: true }).eq("symbol", SYMBOL).eq("status", "filled"); if ((dailyCount ?? 0) < maxTradesPerDay && (openCount ?? 0) < maxOpenPositions) await db.from("paper_orders").insert({ prediction_id: predictionId, symbol: SYMBOL, side: action, requested_at: last.ts, requested_price: price, filled_at: last.ts, fill_price: price, quantity: 1, status: "filled", metadata: { mode: "paper", proxy: true, horizon_minutes: 15, live_enabled: false } }); }

    await db.rpc("evaluate_prediction_outcomes", { p_symbol: SYMBOL, p_cost_return: costReturn, p_limit: 1000 });
    const age = (now.getTime() - new Date(last.ts).getTime()) / 60000;
    await db.from("data_quality_results").insert([{ ingestion_run_id: run.id, dataset: "GC=F 1m", check_name: "bars_nonempty", status: "pass", observed: bars.length, expected: { min: 30 } }, { ingestion_run_id: run.id, dataset: "GC=F 1m", check_name: "latest_bar_age_minutes", status: age < 30 ? "pass" : "warn", observed: age, expected: { max_market_open: 30 } }]);
    await db.from("data_ingestion_runs").update({ finished_at: new Date().toISOString(), status: "success", rows_written: writeBars.length, watermark: last.ts, details: { range, feature_rows: featureWrite.length, action, probability, model_version: modelVersion, proxy: true } }).eq("id", run.id);
    return Response.json({ ok: true, range, bars: bars.length, written: writeBars.length, featureRows: featureWrite.length, latest: last.ts, action, probability, modelVersion, liveEnabled: false });
  } catch (e) {
    await db.from("data_ingestion_runs").update({ finished_at: new Date().toISOString(), status: "failed", details: { error: String(e) } }).eq("id", run.id);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
