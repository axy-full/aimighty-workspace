import { handleCrewMcp, isCrewMcpRequest } from "@/lib/crew/mcp";
import { recoveryRoute } from "@/lib/recovery";
import { callerFromToken, requireUser, withTenant } from "@/lib/auth";
import { creditsApply } from "@/lib/credits";
import { TOOLS, runTool, makeCaller } from "@/lib/mcp";
import { directEngineMcpTools, runDirectEngineTool } from "@/lib/directEngineMcp";
import { currentTenant } from "@/lib/tenant";
import { linkOrigin } from "@/lib/site";
import { hasSpendingCeiling } from "@/lib/tokenCeiling";

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

/**
 * Whether render_shot may send its quote as the approval: the token the tools act with has a monthly ceiling (owner, 20 Oct 2026;
 * lib/tokenSpend.ts). That is the bearer the client sent, which the tools forward (makeCaller), never the request's own session: a
 * browser that also holds a cookie is the session here, while the tools still act as the token.
 */
async function bearerMaySpend(req: Request): Promise<boolean> {
  const raw = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const acting = raw ? await callerFromToken(raw).catch(() => null) : null;
  return Boolean(acting?.token?.scope === "render" && hasSpendingCeiling(acting.token, creditsApply(acting.workspace)));
}

const ok = (id: unknown, result: unknown) =>
  Response.json({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

const workspacePost = withTenant(async function POST(req: Request) {
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
      serverInfo: { name: "particl", version: "1.2.0" },
    });
  }

  // Notifications carry no id and expect no body back.
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  if (method === "ping") return ok(id, {});
  /* The direct engines' tools are listed only where their engine gate lets this workspace have them (lib/directEngineMcp.ts). */
  if (method === "tools/list") return ok(id, { tools: [...TOOLS, ...(await directEngineMcpTools())] });

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments ?? {}) as Record<string, string | number | boolean | undefined>;
    /* The tools call this same server at its own address (the bearer never leaves it); the links they hand back use the public one. */
    const call = makeCaller(new URL(req.url).origin, req.headers.get("authorization") ?? "");
    /* The unit costs are told in, and whether this token may start paid work: only with a ceiling an admin set (lib/tokenSpend.ts). */
    const unit = { credits: creditsApply(currentTenant()?.workspace) };
    try {
      const text = (await runDirectEngineTool(name, args, call)) ?? (await runTool(name, args, call, linkOrigin(req), { ...unit, spends: name === "render_shot" ? await bearerMaySpend(req) : false }));
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
// JSON-RPC reads use POST; tools forward the same bearer to individually guarded routes.
}, { readOnlyPostTransport: true, mcpTransport: true });

/** A plain GET makes the endpoint self-describing when someone opens it. */
export const GET = withTenant(async function GET() {
  return Response.json({
    name: "particl",
    transport: "mcp/streamable-http",
    usage: "POST JSON-RPC here with an 'Authorization: Bearer aw_…' header.",
    tools: [...TOOLS, ...(await directEngineMcpTools())].map((t) => t.name),
  });
});

/** Crew credentials are strictly narrower than a workspace API token. */
const crewPost = recoveryRoute(handleCrewMcp);
export async function POST(req: Request, ctx: unknown) {
  return isCrewMcpRequest(req) ? crewPost(req) : workspacePost(req, ctx);
}
