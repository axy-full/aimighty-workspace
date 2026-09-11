import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { listBoards, createBoard } from "@/lib/boards";

export const dynamic = "force-dynamic";

/** A project's boards (§8). `?projectId=` lists; POST makes one, empty — building is free. */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  if (!projectId) return NextResponse.json({ error: "Which project?" }, { status: 400 });
  return NextResponse.json({ boards: await listBoards(projectId) });
});

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const b = await req.json().catch(() => ({}));
  const projectId = typeof b.projectId === "string" ? b.projectId : "";
  if (!projectId) return NextResponse.json({ error: "Which project?" }, { status: 400 });
  const board = await createBoard(projectId, typeof b.name === "string" ? b.name : "Board");
  return NextResponse.json({ board }, { status: 201 });
});
