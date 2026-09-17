import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const SYMBOL = "XAUUSD_PROXY_GC";

export async function GET() {
  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });

  const [{ data: dashboard, error: dashboardError }, { data: closedLoop, error: healthError }] = await Promise.all([
    db.rpc("dashboard_snapshot", { p_symbol: SYMBOL, p_limit: 180 }),
    db.rpc("closed_loop_health", { p_symbol: SYMBOL }),
  ]);

  if (dashboardError || !dashboard) {
    return NextResponse.json({ error: dashboardError?.message ?? "No market data" }, { status: 503 });
  }

  const rawBars = Array.isArray(dashboard.bars) ? dashboard.bars : [];
  if (!rawBars.length) return NextResponse.json({ error: "No market data" }, { status: 503 });

  const bars = rawBars.map((b: Record<string, unknown>) => ({
    ts: String(b.ts),
    close: Number(b.close),
    rsi: Number(b.rsi ?? 50),
    wt1: Number(b.wt1 ?? 0),
    wt2: Number(b.wt2 ?? 0),
    squeeze: Number(b.squeeze ?? 0),
    signal: b.signal ?? null,
  }));
  const last = bars.at(-1)!;
  const first = bars[0];
  const prediction = dashboard.prediction ?? {};

  return NextResponse.json({
    mode: "paper",
    symbol: "XAU/USD · GC=F proxy",
    price: last.close,
    changePct: first.close ? ((last.close / first.close) - 1) * 100 : 0,
    modelProbability: Number(prediction.probability ?? 0.5),
    action: prediction.action ?? "NO_TRADE",
    riskState: prediction.risk_state ?? "NO_MODEL",
    modelVersion: prediction.model_version ?? "untrained",
    bars,
    paper: dashboard.paper ?? {},
    benchmark: dashboard.benchmark ?? {},
    ingestion: dashboard.ingestion ?? {},
    limitations: dashboard.limitations ?? [],
    closedLoop: healthError ? { error: healthError.message } : (closedLoop ?? {}),
  });
}
