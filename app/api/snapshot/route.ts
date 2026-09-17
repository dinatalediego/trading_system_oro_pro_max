import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type FeatureRow = {
  ts: string;
  close: number | string;
  rsi: number | string | null;
  wt1: number | string | null;
  wt2: number | string | null;
  squeeze: number | string | null;
  rule_signal: "BUY" | "SELL" | null;
};

async function loadBars(db: NonNullable<ReturnType<typeof getSupabaseAdmin>>, symbol: string) {
  return db
    .from("gold_market_features")
    .select("ts,close,rsi,wt1,wt2,squeeze,rule_signal")
    .eq("symbol", symbol)
    .order("ts", { ascending: false })
    .limit(120);
}

export async function GET() {
  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });

  let sourceSymbol = "XAUUSD";
  let mode: "live" | "proxy" = "live";
  let barsResult = await loadBars(db, sourceSymbol);

  if (barsResult.error || !barsResult.data?.length) {
    sourceSymbol = "GC=F";
    mode = "proxy";
    barsResult = await loadBars(db, sourceSymbol);
  }

  const { data: prediction } = await db
    .from("model_predictions")
    .select("action,probability,model_version,risk_state,created_at")
    .eq("symbol", sourceSymbol)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const bars = barsResult.data as FeatureRow[] | null;
  if (barsResult.error || !bars?.length) {
    return NextResponse.json({ error: barsResult.error?.message ?? "No market data" }, { status: 503 });
  }

  const ordered = [...bars].reverse();
  const last = ordered.at(-1)!;
  const first = ordered[0];
  const proxy = mode === "proxy";

  return NextResponse.json({
    mode,
    symbol: proxy ? "GC=F · public gold proxy" : "XAU/USD · broker feed",
    price: Number(last.close),
    changePct: ((Number(last.close) / Number(first.close)) - 1) * 100,
    modelProbability: Number(prediction?.probability ?? 0.5),
    action: prediction?.action ?? "NO_TRADE",
    riskState: prediction?.risk_state ?? (proxy ? "PUBLIC_PROXY_NO_EXECUTION" : "NO_MODEL"),
    modelVersion: prediction?.model_version ?? (proxy ? "rules-only-bootstrap" : "untrained"),
    bars: ordered.map((b) => ({
      ts: b.ts,
      close: Number(b.close),
      rsi: b.rsi == null ? 50 : Number(b.rsi),
      wt1: b.wt1 == null ? 0 : Number(b.wt1),
      wt2: b.wt2 == null ? 0 : Number(b.wt2),
      squeeze: b.squeeze == null ? 0 : Number(b.squeeze),
      signal: b.rule_signal,
    })),
  });
}
