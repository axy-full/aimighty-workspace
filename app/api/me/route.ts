import { NextResponse } from "next/server";
import { requireUser, isSuperAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id, name, email, role } = got.user;
  /* `owner` is decided here, against the server's own idea of who owns the
     workspace, so the client never has to carry that address. */
  return NextResponse.json({ id, name, email, role, owner: isSuperAdmin(email) });
}
