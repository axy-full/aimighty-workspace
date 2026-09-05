import { NextResponse } from "next/server";
import { requireOwner, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { setWorkspaceKeys } from "@/lib/platform";
import { VENDOR_KEYS, type VendorKeyName } from "@/lib/vendorKeys";
import { mask, keyringConfigured } from "@/lib/keyring";

export const dynamic = "force-dynamic";
const NAMES = new Set<string>(VENDOR_KEYS.map((k) => k.name));

/**
 * The workspace's vendor keys — the owner's alone. Read back masked: a key
 * is shown as its last four characters, enough to tell which one it is and
 * never enough to use it. The platform's own workspace uses the
 * deployment's keys and has nothing to manage here.
 */
export const GET = withTenant(async function GET() {
  const got = await requireOwner();
  if (got.response) return got.response;
  const ws = requireTenant();
  return NextResponse.json({
    usesPlatformKeys: ws.usesPlatformKeys,
    keyring: keyringConfigured(),
    keys: VENDOR_KEYS.map((k) => ({ name: k.name, label: k.label, does: k.does, set: Boolean(ws.keys[k.name]), masked: ws.keys[k.name] ? mask(ws.keys[k.name]) : null })),
  });
});

/** Set or rotate one key. The value is sealed before it is stored and never echoed back. */
export const PUT = withTenant(async function PUT(req: Request) {
  const got = await requireOwner();
  if (got.response) return got.response;
  const ws = requireTenant();
  if (ws.usesPlatformKeys) return NextResponse.json({ error: "This workspace runs on the deployment's keys." }, { status: 400 });
  if (!keyringConfigured()) return NextResponse.json({ error: "The deployment can't hold keys yet — KEYRING_SECRET is not set." }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "") as VendorKeyName;
  const value = String(body.value ?? "").trim();
  if (!NAMES.has(name)) return NextResponse.json({ error: "Unknown vendor." }, { status: 400 });
  if (value.length < 8 || value.length > 4096 || /\s/.test(value)) return NextResponse.json({ error: "That doesn't look like a key." }, { status: 400 });
  await setWorkspaceKeys(ws.id, { ...ws.keys, [name]: value });
  return NextResponse.json({ ok: true, name, masked: mask(value) });
});

export const DELETE = withTenant(async function DELETE(req: Request) {
  const got = await requireOwner();
  if (got.response) return got.response;
  const ws = requireTenant();
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "");
  if (!NAMES.has(name)) return NextResponse.json({ error: "Unknown vendor." }, { status: 400 });
  const next = { ...ws.keys };
  delete next[name];
  await setWorkspaceKeys(ws.id, next);
  return NextResponse.json({ ok: true, name });
});
