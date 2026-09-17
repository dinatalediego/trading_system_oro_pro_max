import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });

  const { data: bars, error: barsError } = await db
    .from("gold_market_features")
    .select("ts,close,rsi,wt1,wt2,squeeze,rule_signal")
    .eq("symbol", "XAUUSD")
    .order("ts", { ascending: false })
    .limit(120);
  const { data: prediction } = await db
    .from("model_predictions")
    .select("action,probability,model_version,risk_state,created_at")
    .eq("symbol", "XAUUSD")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (barsError || !bars?.length) return NextResponse.json({ error: barsError?.message ?? "No market data" }, { status: 503 });
  const ordered = [...bars].reverse();
  const last = ordered.at(-1)!;
  const first = ordered[0];
  return NextResponse.json({
    mode: "live",
    symbol: "XAU/USD",
    price: Number(last.close),
    changePct: ((Number(last.close) / Number(first.close)) - 1) * 100,
    modelProbability: Number(prediction?.probability ?? 0.5),
    action: prediction?.action ?? "NO_TRADE",
    riskState: prediction?.risk_state ?? "NO_MODEL",
    modelVersion: prediction?.model_version ?? "untrained",
    bars: ordered.map((b) => ({ ts: b.ts, close: Number(b.close), rsi: Number(b.rsi), wt1: Number(b.wt1), wt2: Number(b.wt2), squeeze: Number(b.squeeze), signal: b.rule_signal })),
  });
}
