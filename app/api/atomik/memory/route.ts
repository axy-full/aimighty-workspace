import { NextResponse } from "next/server";
import { requireSession, withTenant } from "@/lib/auth";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { MemoryError, addMemory, findForForget, forgetMemory, importMemory, listMemory, memoryView } from "@/lib/atomikMemory";

export const dynamic = "force-dynamic";

/**
 * Atomik memory (lib/atomikMemory.ts): what the workspace asked its agent to
 * keep in mind. Free — nothing here calls a model or a vendor — and for a
 * signed-in person only: an API token neither reads nor writes it.
 *
 *  GET  ?projectId=   the workspace's entries and that project's, waiting ones included
 *  POST {action:"add"}     a person keeps something (a message, an asset, a line of their own)
 *  POST {action:"import"}  a paste from another assistant, as entries waiting for review
 *  POST {action:"find"}    "forget …": which kept entries it is about (read-only)
 *  POST {action:"forget"}  the entries a person confirmed, archived — never erased
 */

/** A 20,000-character paste, in any script, with its JSON around it. */
const BODY_BYTES = 100_000;

const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

function failure(error: unknown) {
  if (error instanceof MemoryError) return reply({ error: error.message }, error.status);
  console.error("Atomik memory request failed");
  return reply({ error: "Memory could not be read or saved. Try again." }, 500);
}

export const GET = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  try {
    const projectId = new URL(req.url).searchParams.get("projectId");
    return reply({ entries: await listMemory(projectId || null, got.user.id) });
  } catch (error) { return failure(error); }
});

export const POST = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(await readBoundedText(req, BODY_BYTES));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestBodyError(400);
    body = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) return reply({ error: "Paste at most 20,000 characters at a time." }, 413);
    return reply({ error: "Invalid request JSON." }, 400);
  }
  const me = got.user.id;
  try {
    switch (body.action) {
      case "add": {
        const entry = await addMemory({ kind: body.kind, text: body.text, projectId: body.projectId, assetId: body.assetId, source: body.source, origin: body.origin }, me);
        return reply({ entry: await memoryView(entry, me) }, 201);
      }
      case "import": {
        const made = await importMemory({ text: body.text, projectId: body.projectId, from: body.from }, me);
        return reply({ entries: await Promise.all(made.entries.map((entry) => memoryView(entry, me))), skipped: made.skipped }, 201);
      }
      case "find":
        return reply(await findForForget(body.text, body.projectId, me));
      case "forget":
        return reply({ forgotten: await forgetMemory(body.ids, me, body.reason === "dismissed" ? "dismissed" : "forgotten") });
      default:
        return reply({ error: "Choose add, import, find or forget." }, 400);
    }
  } catch (error) { return failure(error); }
}, { requireRequestScope: true });
