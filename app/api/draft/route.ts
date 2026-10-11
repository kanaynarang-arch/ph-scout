import { NextResponse } from "next/server";
import { handleDraft } from "@/lib/draft";
import { draftFor, lookupSource } from "@/lib/draft-service";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Returns a DRAFT message for Kavya to read and edit. Nothing is sent anywhere by this route.
export async function POST(req: Request) {
  try {
    const out = await handleDraft(req, { lookup: lookupSource, draftFor });
    return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Drafting is unavailable right now. Please try again." }, { status: 503 });
  }
}
