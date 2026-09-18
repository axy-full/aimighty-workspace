import { consumerClientMetadata } from "@/lib/higgsfield-consumer/oauth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Public client metadata is intentionally unauthenticated and contains no credentials. */
export async function GET() {
  try {
    return Response.json(consumerClientMetadata(), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch {
    return Response.json(
      { error: "The connection is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
