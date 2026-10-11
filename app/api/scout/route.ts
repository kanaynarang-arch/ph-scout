import { NextResponse } from "next/server";
import { runScout } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let refresh = false;
  try {
    const body = await req.json();
    refresh = body?.refresh === true;
  } catch {
    /* no body = plain Generate */
  }
  try {
    const data = await runScout({ refresh });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Something went wrong while building the list. Please try again." }, { status: 500 });
  }
}
