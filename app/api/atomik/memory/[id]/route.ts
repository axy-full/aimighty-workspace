import { NextResponse } from "next/server";
import { requireSession, withTenant } from "@/lib/auth";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { MemoryError, forgetMemory, memoryView, updateMemory } from "@/lib/atomikMemory";

export const dynamic = "force-dynamic";

/**
 * One memory entry: PATCH edits it or accepts one that was waiting (the
 * version it replaces is archived in the same write); DELETE forgets it —
 * archived through lib/archive.ts, never erased (`?reason=dismissed` for a
 * proposal turned down). Free, and for a signed-in person only.
 */

type Ctx = { params: Promise<{ id: string }> };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

function failure(error: unknown) {
  if (error instanceof MemoryError) return reply({ error: error.message }, error.status);
  console.error("Atomik memory request failed");
  return reply({ error: "Memory could not be saved. Try again." }, 500);
}

export const PATCH = withTenant(async (req: Request, ctx: Ctx) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(await readBoundedText(req, 8192));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestBodyError(400);
    body = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) return reply({ error: "Keep a memory under 600 characters." }, 413);
    return reply({ error: "Invalid request JSON." }, 400);
  }
  try {
    const entry = await updateMemory(id, { text: body.text, kind: body.kind, projectId: body.projectId, accept: body.accept, updatedAt: body.updatedAt }, got.user.id);
    return reply({ entry: await memoryView(entry, got.user.id) });
  } catch (error) { return failure(error); }
}, { requireRequestScope: true });

export const DELETE = withTenant(async (req: Request, ctx: Ctx) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  try {
    const reason = new URL(req.url).searchParams.get("reason") === "dismissed" ? "dismissed" : "forgotten";
    const forgotten = await forgetMemory([id], got.user.id, reason);
    if (!forgotten) return reply({ error: "That memory is already gone." }, 404);
    return reply({ forgotten });
  } catch (error) { return failure(error); }
}, { requireRequestScope: true });
