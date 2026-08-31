import { requireUser } from "@/lib/auth";
import { TOOLS, runTool, makeCaller } from "@/lib/mcp";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The workspace as an MCP server, reachable over a URL.
 *
 * This is what lets someone connect from a client that can't run anything on
 * their machine — a Claude custom connector, a ChatGPT connector, a hosted
 * agent. The local stdio bridge in mcp/ is a thin client of this same
 * endpoint, so the tools behave identically wherever they're called from.
 *
 * Authentication is the workspace's own API token in an Authorization header,
 * so scopes and monthly ceilings apply here exactly as they do everywhere
 * else — a read-only token can list and fetch, and is refused a render.
 */

const PROTOCOL_FALLBACK = "2024-11-05";

const ok = (id: unknown, result: unknown) =>
  Response.json({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) {
    // Answer in the shape MCP clients understand, not just a bare 401 body.
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized — supply a workspace API token as a Bearer token." } },
      { status: 401 }
    );
  }

  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { msg = await req.json(); }
  catch { return fail(null, -32700, "Parse error"); }

  const { id, method, params } = msg;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: (params?.protocolVersion as string) ?? PROTOCOL_FALLBACK,
      capabilities: { tools: {} },
      serverInfo: { name: "aimighty-workspace", version: "1.1.0" },
    });
  }

  // Notifications carry no id and expect no body back.
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments ?? {}) as Record<string, string | number | boolean | undefined>;
    const origin = new URL(req.url).origin;
    const call = makeCaller(origin, req.headers.get("authorization") ?? "");
    try {
      const text = await runTool(name, args, call, origin);
      return ok(id, { content: [{ type: "text", text }] });
    } catch (e) {
      // A refused render or a bad project name is information for the model,
      // not a broken call — hand it back as a readable result.
      return ok(id, {
        content: [{ type: "text", text: `Failed: ${(e as Error).message}` }],
        isError: true,
      });
    }
  }

  return fail(id, -32601, `Method not found: ${method}`);
}

/** A plain GET makes the endpoint self-describing when someone opens it. */
export async function GET() {
  return Response.json({
    name: "aimighty-workspace",
    transport: "mcp/streamable-http",
    usage: "POST JSON-RPC here with an 'Authorization: Bearer aw_…' header.",
    tools: TOOLS.map((t) => t.name),
  });
}
