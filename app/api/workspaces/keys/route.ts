import { NextResponse } from "next/server";
import { requireOwner, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { updateWorkspaceVendorKey, setWorkspaceMode, platformKeysByDefault } from "@/lib/platform";
import { VENDOR_KEYS, type VendorKeyName } from "@/lib/vendorKeys";
import { mask, keyringConfigured } from "@/lib/keyring";
import { allowanceUsd, platformSpendThisMonth } from "@/lib/allowance";
import { creditState } from "@/lib/credits";

export const dynamic = "force-dynamic";
const NAMES = new Set<string>(VENDOR_KEYS.map((k) => k.name));

/**
 * The workspace's vendor keys — the owner's alone. Read back masked: a key
 * is shown as its last four characters, enough to tell which one it is and
 * never enough to use it.
 *
 * Three modes. The studio's own workspace (`legacy`) runs on the
 * deployment and manages nothing here. A new workspace runs on the
 * PLATFORM's keys with a monthly allowance, and any key it adds of its own
 * takes over for that vendor. A workspace on its OWN keys reaches only
 * what it has added.
 */
export const GET = withTenant(async function GET() {
  const got = await requireOwner();
  if (got.response) return got.response;
  const ws = requireTenant();
  const mode = ws.legacy ? "legacy" : ws.usesPlatformKeys ? "platform" : "own";
  const cap = allowanceUsd();
  const spent = cap != null ? await platformSpendThisMonth() : 0;
  return NextResponse.json({
    usesPlatformKeys: ws.usesPlatformKeys,
    mode,
    canPlatform: platformKeysByDefault(),
    keyring: keyringConfigured(),
    allowance: cap != null ? { usd: cap, spentUsd: spent } : null,
    credits: await creditState().catch(() => null),
    gatewayMinted: Boolean(ws.gatewayKeyId),
    keys: VENDOR_KEYS.map((k) => ({
      name: k.name, label: k.label, does: k.does,
      set: Boolean(ws.keys[k.name]),
      masked: ws.keys[k.name] ? mask(ws.keys[k.name]) : null,
    })),
  });
});

/** Set or rotate one key. The value is sealed before it is stored and never echoed back. */
export const PUT = withTenant(async function PUT(req: Request) {
  const got = await requireOwner();
  if (got.response) return got.response;
  const ws = requireTenant();
  if (ws.legacy) return NextResponse.json({ error: "The studio's own workspace runs on the deployment's keys." }, { status: 400 });
  if (!keyringConfigured()) return NextResponse.json({ error: "The deployment can't hold keys yet — KEYRING_SECRET is not set." }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "") as VendorKeyName;
  const value = String(body.value ?? "").trim();
  if (!NAMES.has(name)) return NextResponse.json({ error: "Unknown vendor." }, { status: 400 });
  if (value.length < 8 || value.length > 4096 || /\s/.test(value)) return NextResponse.json({ error: "That doesn't look like a key." }, { status: 400 });
  if (name === "higgsfield" && !/^[^:\s]+:[^:\s]+$/.test(value)) return NextResponse.json({ error: "Enter the Higgsfield API key ID and secret separated by a colon: KEY_ID:KEY_SECRET." }, { status: 400 });
  await updateWorkspaceVendorKey(ws.id, name, value, got.user.id);
  return NextResponse.json({ ok: true, name, masked: mask(value) });
}, { requireRequestScope: true });

export const DELETE = withTenant(async function DELETE(req: Request) {
  const got = await requireOwner();
  if (got.response) return got.response;
  const ws = requireTenant();
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "");
  if (!NAMES.has(name)) return NextResponse.json({ error: "Unknown vendor." }, { status: 400 });
  await updateWorkspaceVendorKey(ws.id, name, null, got.user.id);
  return NextResponse.json({ ok: true, name });
}, { requireRequestScope: true });

/** Whose keys the engines run on: the platform's (with its allowance) or the workspace's own. */
export const PATCH = withTenant(async function PATCH(req: Request) {
  const got = await requireOwner();
  if (got.response) return got.response;
  const ws = requireTenant();
  if (ws.legacy) return NextResponse.json({ error: "The studio's own workspace runs on the deployment." }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const mode = body.mode === "platform" ? "platform" : body.mode === "own" ? "own" : null;
  if (!mode) return NextResponse.json({ error: "mode must be platform or own." }, { status: 400 });
  if (mode === "platform" && !platformKeysByDefault()) {
    return NextResponse.json({ error: "The platform doesn't lend its keys on this deployment." }, { status: 400 });
  }
  await setWorkspaceMode(ws.id, mode === "platform", got.user.id);
  return NextResponse.json({ ok: true, mode });
}, { requireRequestScope: true });
