import { NextResponse } from "next/server";
import { requireAdmin, withTenant } from "@/lib/auth";
import { activeWriter } from "@/lib/enhance";
import { invalidateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Configuration check only. A settings probe must not trigger unquoted,
 * unmetered generation. A priced Atomik request verifies actual generation.
 */
export const POST = withTenant(async function POST() {
  const got = await requireAdmin();
  if (got.response) return got.response;
  invalidateSettings();
  const writer = await activeWriter();
  if (writer.writer === "none") {
    return NextResponse.json({
      ok: true,
      writer,
      ms: 0,
      sample:
        "Pro: prompts reach the engine exactly as written. There is no writer to test.",
    });
  }
  return NextResponse.json(
    {
      ok: writer.configured,
      writer,
      model: writer.model,
      ms: 0,
      check: "configuration",
      generationVerified: false,
      sample: writer.configured
        ? "Writer credentials are configured. Create a priced Atomik draft to verify generation."
        : "Connect the writer in workspace settings before creating a draft.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
