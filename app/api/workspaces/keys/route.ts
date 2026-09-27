import { NextResponse } from "next/server";
import { requireOwner, requireUser, withTenant } from "@/lib/auth";
import { VENDOR_KEYS, vendorKey } from "@/lib/vendorKeys";
import { creditState } from "@/lib/credits";

export const dynamic = "force-dynamic";

/** Availability only: customers never receive credentials, fingerprints or account balances. */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  return NextResponse.json({
    usesPlatformKeys: true, mode: "platform", managed: true, canPlatform: true,
    credits: await creditState(),
    keys: VENDOR_KEYS.map((key) => ({ ...key, set: Boolean(vendorKey(key.name)), masked: null })),
  }, { headers: { "Cache-Control": "private, no-store" } });
});

async function managedOnly() {
  const got = await requireOwner();
  if (got.response) return got.response;
  return NextResponse.json({ error: "Engines are managed by Particl. This workspace pays only in Particl credits." }, { status: 403 });
}

// Keep existing routes explicit for old clients; saved keys are not deleted.
export const PUT = withTenant(managedOnly, { requireRequestScope: true });
export const PATCH = withTenant(managedOnly, { requireRequestScope: true });
export const DELETE = withTenant(managedOnly, { requireRequestScope: true });
