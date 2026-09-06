import { NextResponse } from "next/server";
import { platformDb, platformReady, newId, now, SUPER_ADMIN_EMAIL } from "@/lib/platform";
import { reportInput } from "@/lib/reports";
import { sendMail, mailConfigured } from "@/lib/mail";
import { currentContext } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Anyone may report something; the desk reads every one. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const v = reportInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  await platformReady();
  const ctx = await currentContext().catch(() => null);
  const id = newId("rp");
  await platformDb().execute({
    sql: `INSERT INTO reports (id, url, reason, details, email, account_id, workspace_id, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    args: [id, v.value.url, v.value.reason, v.value.details, v.value.email, ctx?.user.id ?? null, ctx?.workspace?.id ?? null, now()],
  });
  if (mailConfigured() && SUPER_ADMIN_EMAIL) {
    const text = `A report came in.\n\nWhere: ${v.value.url}\nWhat: ${v.value.reason}\n${v.value.details ? `Details: ${v.value.details}\n` : ""}${v.value.email ? `From: ${v.value.email}\n` : ""}\nRead it on the platform desk.`;
    await sendMail({ to: SUPER_ADMIN_EMAIL, subject: "Content reported", text, html: `<p>${text.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>` }).catch(() => {});
  }
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
