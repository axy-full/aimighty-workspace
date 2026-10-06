export const runtime = "nodejs";

/** Settings › Connections in the shell (lib/shell/settings.ts: `?view=workspace&tab=<section>`). */
const SIGN_IN_RETURN_PATH = "/suites?view=workspace&tab=connections";

/**
 * The old return address of the Higgsfield sign-in, which is off for Release 1
 * (lib/higgsfield-consumer/retired.ts › SIGN_IN_OFF). Whatever the query
 * carries (a code, a state, an error), nothing is read, exchanged or stored:
 * the browser simply lands on Settings › Connections, with no message.
 */
export function GET(request: Request) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL(SIGN_IN_RETURN_PATH, request.url).toString(),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
