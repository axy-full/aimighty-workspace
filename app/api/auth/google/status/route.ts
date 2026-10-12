import { NextResponse } from "next/server";
import { googleConfig } from "@/lib/googleSignIn";

export const dynamic = "force-dynamic";

/** Whether "Continue with Google" is on here: the client id, its secret and the public origin are all set. Says nothing else. */
export function GET() {
  return NextResponse.json({ enabled: googleConfig() !== null }, { headers: { "Cache-Control": "no-store" } });
}
