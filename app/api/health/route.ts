import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabaseConfigured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  return NextResponse.json({
    service: "gold-decision-lab",
    status: "ok",
    execution_mode: "PAPER",
    supabase_configured: supabaseConfigured,
    live_broker_enabled: false,
    timestamp: new Date().toISOString(),
  });
}
