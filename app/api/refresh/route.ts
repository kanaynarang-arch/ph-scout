import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { purgeExpired } from "@/lib/cache";
import { runScout } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handle(req: Request) {
  // Check the secret BEFORE doing any work.
  if (!authorised(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    // Same pipeline as one Generate: same API budget, warms the saved copies.
    const r = await runScout({});
    const purged = await purgeExpired();
    return NextResponse.json({
      ok: true,
      source: r.source,
      counted: r.counted,
      ai: r.ai,
      launches: r.ranked.length + r.tooEarly.length + r.moreLaunches.length,
      warnings: r.warnings.length,
      purged,
      tookMs: r.tookMs,
    });
  } catch {
    return NextResponse.json({ ok: false, error: "refresh failed" }, { status: 500 });
  }
}

export const GET = handle; // Vercel Cron sends GET with the bearer secret
export const POST = handle;
