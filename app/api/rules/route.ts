import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { effectiveRules, addRule, ruleProblem } from "@/lib/rules";

export const dynamic = "force-dynamic";

/** Every rule in force here, platform and workspace, each with its source. */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  return NextResponse.json({ rules: await effectiveRules() });
});

/** A rule the team writes: one sentence, a scope, and whether it steers the writer or rides on the prompt. */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const problem = ruleProblem(body);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  const rule = await addRule({ text: String(body.text), scope: body.scope ? String(body.scope) : undefined, apply: body.apply ? String(body.apply) : undefined }, got.user.id);
  return NextResponse.json({ rule: { ...rule, source: "workspace" }, rules: await effectiveRules() });
});
