import { createClient } from "jsr:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL")!, key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(url, key, { auth: { persistSession: false } });
const SYMBOL = "XAUUSD_PROXY_GC", MODEL = "logistic_direction_15m_proxy", FV = "bootstrap_v1";
const FNS = ["rsi_centered", "wt_gap", "squeeze_scaled", "return_1", "atr_pct"];
const COST = 0.00015;

function sig(x: number) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x)))); }
function mean(a: number[]) { return a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1); }
function std(a: number[], m: number) { return Math.sqrt(mean(a.map(x => (x - m) * (x - m)))) || 1; }

async function load() {
  const all: any[] = [];
  for (let page = 0; page < 8; page++) {
    const from = page * 1000, to = from + 999;
    const { data, error } = await db.from("gold_market_features").select("ts,close,rsi,atr,wt1,wt2,squeeze").eq("symbol", SYMBOL).eq("feature_set_version", FV).order("ts", { ascending: true }).range(from, to);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all.slice(-7000);
}

type Fit = { mu: number[]; sd: number[]; w: number[]; b: number };
function fit(X: number[][], Y: number[], trainEnd: number): Fit {
  const mu = FNS.map((_, j) => mean(X.slice(0, trainEnd).map(x => x[j]))), sd = FNS.map((_, j) => std(X.slice(0, trainEnd).map(x => x[j]), mu[j]));
  const Z = X.slice(0, trainEnd).map(x => x.map((v, j) => (v - mu[j]) / sd[j]));
  let w = new Array(FNS.length).fill(0), b = 0;
  const lr = .05, l2 = .001;
  for (let e = 0; e < 450; e++) {
    const gw = new Array(w.length).fill(0); let gb = 0;
    for (let i = 0; i < trainEnd; i++) { let z = b; for (let j = 0; j < w.length; j++) z += w[j] * Z[i][j]; const d = sig(z) - Y[i]; gb += d; for (let j = 0; j < w.length; j++) gw[j] += d * Z[i][j]; }
    b -= lr * gb / trainEnd; for (let j = 0; j < w.length; j++) w[j] -= lr * (gw[j] / trainEnd + l2 * w[j]);
  }
  return { mu, sd, w, b };
}

function probability(x: number[], f: Fit) { let z = f.b; for (let j = 0; j < f.w.length; j++) z += f.w[j] * ((x[j] - f.mu[j]) / f.sd[j]); return sig(z); }
function evaluate(X: number[][], Y: number[], R: number[], start: number, end: number, f: Fit) {
  const probs: number[] = [], ys: number[] = [], net: number[] = [];
  let wins = 0, correct = 0;
  for (let i = start; i < end; i++) {
    const p = probability(X[i], f); probs.push(p); ys.push(Y[i]); if ((p >= .5 ? 1 : 0) === Y[i]) correct++;
    const side = p >= .62 ? 1 : p <= .38 ? -1 : 0;
    if (side) { const rr = side * R[i] - COST; net.push(rr); if (rr > 0) wins++; }
  }
  const eps = 1e-9, brier = mean(probs.map((p, i) => (p - ys[i]) ** 2)), logloss = -mean(probs.map((p, i) => ys[i] * Math.log(p + eps) + (1 - ys[i]) * Math.log(1 - p + eps)));
  let eq = 0, peak = 0, mdd = 0; for (const x of net) { eq += x; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); }
  return { test_rows: end - start, brier, logloss, accuracy: correct / Math.max(end - start, 1), trades: net.length, coverage: net.length / Math.max(end - start, 1), win_rate: net.length ? wins / net.length : 0, mean_net_return: net.length ? mean(net) : 0, total_net_return: net.reduce((s, x) => s + x, 0), max_drawdown_return: mdd };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const token = req.headers.get("x-refresh-token");
  const { data: t } = await db.from("runtime_settings").select("value").eq("key", "public_refresh_token").limit(1).maybeSingle();
  if (!t?.value || token !== t.value) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { data: audit, error: auditError } = await db.from("retraining_runs").insert({ model_name: MODEL, trigger_type: "schedule", status: "running" }).select("id").single();
  if (auditError) return Response.json({ ok: false, error: auditError.message }, { status: 500 });

  try {
    const rows = await load();
    if (rows.length < 1200) { await db.from("retraining_runs").update({ finished_at: new Date().toISOString(), status: "skipped", rows_seen: rows.length, details: { reason: "need >=1200 feature rows" } }).eq("id", audit.id); return Response.json({ ok: false, error: `need >=1200 feature rows, have ${rows.length}` }, { status: 409 }); }

    const X: number[][] = [], Y: number[] = [], R: number[] = [], T: string[] = [];
    for (let i = 1; i < rows.length - 15; i++) {
      const r = rows[i], p = rows[i - 1], f = rows[i + 15];
      if ([r.close, r.rsi, r.atr, r.wt1, r.wt2, r.squeeze, p.close, f.close].some(v => v == null || !Number.isFinite(Number(v)))) continue;
      const ret = Math.log(Number(f.close) / Number(r.close));
      X.push([(Number(r.rsi) - 50) / 50, Number(r.wt1) - Number(r.wt2), Number(r.squeeze) / 40, Math.log(Number(r.close) / Number(p.close)), Number(r.atr) / Math.max(Number(r.close), 1)]);
      Y.push(ret > 0.00010 ? 1 : 0); R.push(ret); T.push(r.ts);
    }
    const n = X.length;
    if (n < 1000) throw new Error(`insufficient usable rows ${n}`);

    const boundaries = [Math.floor(n * .55), Math.floor(n * .70), Math.floor(n * .85), n];
    const folds: any[] = [];
    for (let k = 0; k < 3; k++) {
      const trainEnd = boundaries[k], testEnd = boundaries[k + 1];
      if (trainEnd < 500 || testEnd - trainEnd < 150) continue;
      const f = fit(X, Y, trainEnd), metrics = evaluate(X, Y, R, trainEnd, testEnd, f);
      folds.push({ fold: k + 1, train_rows: trainEnd, test_start: T[trainEnd], test_end: T[testEnd - 1], ...metrics });
    }
    if (folds.length < 3) throw new Error(`need 3 walk-forward folds, have ${folds.length}`);

    const totalRows = folds.reduce((s, x) => s + x.test_rows, 0), totalTrades = folds.reduce((s, x) => s + x.trades, 0);
    const weighted = (name: string) => folds.reduce((s, x) => s + Number(x[name]) * x.test_rows, 0) / totalRows;
    const totalNet = folds.reduce((s, x) => s + x.total_net_return, 0), meanNet = totalTrades ? totalNet / totalTrades : 0, positiveFolds = folds.filter(x => x.mean_net_return > 0).length;
    const metrics: any = { protocol: "expanding_walk_forward_3fold", folds, test_rows: totalRows, brier: weighted("brier"), logloss: weighted("logloss"), accuracy: weighted("accuracy"), trades: totalTrades, coverage: totalTrades / totalRows, win_rate: totalTrades ? folds.reduce((s, x) => s + x.win_rate * x.trades, 0) / totalTrades : 0, mean_net_return: meanNet, total_net_return: totalNet, max_drawdown_return: Math.min(...folds.map(x => x.max_drawdown_return)), positive_folds: positiveFolds, threshold_long: .62, threshold_short: .38, label_cost_buffer: .00010, backtest_cost_per_trade: COST, proxy_only: true };

    const eligible = metrics.test_rows >= 600 && metrics.trades >= 30 && metrics.positive_folds >= 2 && metrics.mean_net_return > 0 && metrics.brier < .26 && metrics.max_drawdown_return > -.05;
    const finalFit = fit(X, Y, n), version = `logistic_proxy_wf_${new Date().toISOString().replace(/[-:.TZ]/g, "")}`, dataset = `yahoo_gc_futures_1m_${rows[0].ts}_${rows.at(-1).ts}`;
    const params = { feature_names: FNS, mean: finalFit.mu, std: finalFit.sd, weights: finalFit.w, intercept: finalFit.b, horizon_minutes: 15, long_threshold: .62, short_threshold: .38, training: "expanding_walk_forward_evaluation_then_refit_all", proxy_only: true };
    const { data: prev } = await db.from("model_runs").select("id,model_version,metrics").eq("model_name", MODEL).eq("status", "champion").order("created_at", { ascending: false }).limit(1).maybeSingle();
    let promote = eligible;
    if (prev?.metrics) { const pm = prev.metrics as any; promote = eligible && metrics.brier <= Number(pm.brier ?? 1) + .01 && metrics.mean_net_return >= Number(pm.mean_net_return ?? -1) * .90; }

    const { data: mr, error: me } = await db.from("model_runs").insert({ model_name: MODEL, model_version: version, dataset_version: dataset, feature_set_version: FV, train_start: T[0], train_end: T.at(-1), metrics, params, status: "candidate" }).select("id").single();
    if (me) throw me;
    await db.from("backtest_runs").insert({ model_version: version, dataset_version: dataset, start_ts: folds[0].test_start, end_ts: folds.at(-1).test_end, assumptions: { instrument: "GC=F proxy", horizon_minutes: 15, cost_per_trade_return: COST, walk_forward: true, folds: 3, live_promotion_allowed: false }, metrics });

    if (promote) {
      if (prev?.id) await db.from("model_runs").update({ status: "retired" }).eq("id", prev.id);
      await db.from("model_runs").update({ status: "champion" }).eq("id", mr.id);
      await db.from("model_promotion_events").insert({ model_version: version, from_stage: "backtest", to_stage: "paper", decision: "promote", gate_metrics: metrics, reason: "Passed three-fold expanding walk-forward proxy gate; broker/live promotion remains forbidden.", actor: "train-baseline" });
    } else {
      await db.from("model_promotion_events").insert({ model_version: version, from_stage: "backtest", to_stage: "candidate", decision: "hold", gate_metrics: metrics, reason: "Did not pass the walk-forward paper-only gate or current champion comparison.", actor: "train-baseline" });
    }

    await db.from("retraining_runs").update({ finished_at: new Date().toISOString(), status: "success", rows_seen: n, candidate_version: version, promoted: promote, metrics, details: { previous_champion: prev?.model_version ?? null, protocol: "expanding_walk_forward_3fold", live_enabled: false } }).eq("id", audit.id);
    return Response.json({ ok: true, modelVersion: version, promotedToPaper: promote, metrics, liveEnabled: false });
  } catch (e) {
    await db.from("retraining_runs").update({ finished_at: new Date().toISOString(), status: "failed", details: { error: String(e) } }).eq("id", audit.id);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
