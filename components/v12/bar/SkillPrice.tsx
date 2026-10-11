"use client";
import { useEffect, useState } from "react";
import { formatQuote } from "@/lib/v12/campaign";
import { needsWords, previewQuote, type SkillRow } from "@/lib/v12/skills";
import { LOADING, QUOTE_FAULT, type Quote } from "@/lib/v12/quote";
import type { UnpricedId } from "@/lib/v12/unpriced";
import { useEngineQuote } from "@/lib/v12/useQuote";
import type { SkillsApi } from "@/lib/shell/use-skills";
import { Price } from "@/components/v12/ui/Price";

/**
 * A "/" row's price (lib/v12/skills.ts). A built-in is a Campaign format: its one price is the engines route at Make's own
 * settings (`useEngineQuote`, a read that reserves nothing), or "quoted" with the reason from lib/v12/unpriced.ts. A saved
 * skill is priced by its free preview (POST /api/atomik/skills/[id]/run {dryRun:true}): it plans nothing, files nothing and
 * charges nothing, and its steps' estimates add up to "up to N cr". Nothing here spends.
 */
export function SkillPrice({ row, api }: { row: SkillRow; api: SkillsApi }) {
  return row.kind === "built-in" ? <BuiltInPrice row={row} /> : <SavedPrice row={row} api={api} />;
}

function BuiltInPrice({ row }: { row: Extract<SkillRow, { kind: "built-in" }> }) {
  const asked = formatQuote(row.format);
  const quote = useEngineQuote("source" in asked ? asked.source : null);
  return "source" in asked ? <Price quote={quote} /> : <Price quote={null} reason={asked.reason} />;
}

type Read = { quote: Quote } | { reason: UnpricedId };
/* One preview per skill version while the page is open: typing a command re-draws the list, never re-asks. */
const READ = new Map<string, Read>();

function SavedPrice({ row, api }: { row: Extract<SkillRow, { kind: "saved" }>; api: SkillsApi }) {
  const key = `${row.skill.id}:${row.skill.version}:${row.skill.updatedAt}`;
  const [read, setRead] = useState<{ key: string; value: Read } | null>(null);
  useEffect(() => {
    if (READ.has(key)) return;
    let live = true;
    api.preview(row.skill.id, { values: {}, engines: {} }).then(
      (preview) => {
        const asked = previewQuote(preview);
        const value: Read = "reason" in asked ? { reason: asked.reason } : { quote: asked };
        READ.set(key, value);
        if (live) setRead({ key, value });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        /* A blank parameter is not a fault: the price waits for the run form's words. */
        const value: Read = needsWords(message) ? { reason: "skillPriceLater" } : { quote: { state: "error", message: message && message !== "Failed to fetch" ? message : QUOTE_FAULT } };
        if (needsWords(message)) READ.set(key, value);
        if (live) setRead({ key, value });
      },
    );
    return () => { live = false; };
  }, [api, key, row.skill.id]);
  const value = READ.get(key) ?? (read?.key === key ? read.value : null);
  if (!value) return <Price quote={LOADING} />;
  return "reason" in value ? <Price quote={null} reason={value.reason} /> : <Price quote={value.quote} />;
}
