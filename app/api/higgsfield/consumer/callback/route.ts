export const runtime = "nodejs";

/** Settings › Connections in the shell (lib/shell/settings.ts: `?view=workspace&tab=<section>`). */
const SIGN_IN_RETURN_PATH = "/suites?view=workspace&tab=connections";

/**
 * The old return address of the Higgsfield sign-in, which is off for Release 1
 * (lib/higgsfield-consumer/retired.ts › SIGN_IN_OFF). Whatever the query
 * carries (a code, a state, an error), nothing is read, exchanged or stored:
 * the browser simply lands on Settings › Connections, with no message.
 */
export function GET() {
  return new Response(null, {
    status: 303,
    headers: {
      /* Relative, so the browser stays on the origin it came back to (and keeps its session there). */
      Location: SIGN_IN_RETURN_PATH,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
