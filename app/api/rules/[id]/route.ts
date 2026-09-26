import { NextResponse } from "next/server";
import { requireAdmin, withTenant } from "@/lib/auth";
import { effectiveRules, patchRule, deleteRule, ruleProblem, setPlatformRuleOff } from "@/lib/rules";
import { getPlatformLayer } from "@/lib/platform";

export const dynamic = "force-dynamic";

/** A workspace rule can change in full; a platform rule can only be switched off or on here. Admins only:
 *  a rule changes every prompt the workspace writes. */
export const PATCH = withTenant(async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const platform = (await getPlatformLayer()).rules.find((r) => r.id === id);
  if (platform) {
    if (typeof body.on !== "boolean") return NextResponse.json({ error: "A platform rule can only be switched off or on here." }, { status: 400 });
    await setPlatformRuleOff(id, !body.on, got.user.id);
    return NextResponse.json({ rules: await effectiveRules() });
  }
  if (body.text !== undefined || body.scope !== undefined || body.apply !== undefined) {
    const problem = ruleProblem({ text: body.text ?? "x", scope: body.scope, apply: body.apply });
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }
  const rule = await patchRule(id, {
    text: body.text !== undefined ? String(body.text) : undefined,
    scope: body.scope !== undefined ? String(body.scope) : undefined,
    apply: body.apply !== undefined ? String(body.apply) : undefined,
    on: typeof body.on === "boolean" ? body.on : undefined,
  });
  if (!rule) return NextResponse.json({ error: "No such rule here." }, { status: 404 });
  return NextResponse.json({ rule: { ...rule, source: "workspace" }, rules: await effectiveRules() });
});

export const DELETE = withTenant(async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  if ((await getPlatformLayer()).rules.some((r) => r.id === id)) {
    return NextResponse.json({ error: "A platform rule is switched off here, not removed." }, { status: 400 });
  }
  if (!(await deleteRule(id))) return NextResponse.json({ error: "No such rule here." }, { status: 404 });
  return NextResponse.json({ rules: await effectiveRules() });
});
