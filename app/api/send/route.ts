import { after, NextResponse } from "next/server";
import { CACHE_NS } from "@/lib/config";
import { neonLimiter } from "@/lib/notify-db";
import { handleSend } from "@/lib/send-handler";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// "Send to Telegram" / "Send to email" buttons on the dashboard. Sends the list to Kavya's own configured recipient only.
export async function POST(req: Request) {
  try {
    const out = await handleSend(req, {
      limiterFor: (channel) => neonLimiter(`${CACHE_NS}:send:${channel}`), // one limit row per channel (production: v1:send:telegram)
      schedule: (task) => after(task),
    });
    return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Sending is unavailable right now. Please try again." }, { status: 503 });
  }
}
