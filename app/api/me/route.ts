import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id, name, email, role } = got.user;
  return NextResponse.json({ id, name, email, role });
}
