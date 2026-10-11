import { after, NextResponse } from "next/server";
import { handleScout } from "@/lib/scout-handler";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // after() keeps the function alive until the (optional) copy to Kavya has been delivered.
    const data = await handleScout(req, { schedule: (task) => after(task) });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Something went wrong while building the list. Please try again." }, { status: 500 });
  }
}
