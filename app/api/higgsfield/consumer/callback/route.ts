import { consumerCallbackLocation } from "@/lib/higgsfield-consumer/oauth";
import { retiredResponse } from "@/lib/higgsfield-consumer/retired";
export const runtime = "nodejs";
/**
 * The end of a sign-in started before the Higgsfield sign-in was retired
 * (lib/higgsfield-consumer/retired.ts). It never finishes the authorization:
 * nothing is exchanged or stored, and the browser returns to Workspace ›
 * Engines, which says the sign-in is retired.
 */
export async function GET() {
  try {
    return new Response(null, {
      status: 303,
      headers: {
        Location: consumerCallbackLocation("retired"),
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return retiredResponse();
  }
}
