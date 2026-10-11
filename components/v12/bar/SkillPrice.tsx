"use client";
import { useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { formatQuote } from "@/lib/v12/campaign";
import { needsWords, previewQuote, scopedFresh, type SkillRow } from "@/lib/v12/skills";
import { useSession } from "@/lib/session";
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
/* One preview per workspace, per skill version, and per setting of the engines Atomik may use, while the page is open: typing a command re-draws the
   list, never re-asks, and switching an engine on or off in Settings › Engines starts the next preview afresh. */
const READ = new Map<string, Read>();

/** The workspace's engines-off setting (`atomikEngines`), read for the list (at most every 10 s), as the part of a preview's key that says which engines were allowed. Null while it is read. */
const OFF_FRESH_MS = 10_000;
const enginesOffRead = scopedFresh<Promise<string>>(OFF_FRESH_MS);
function useEnginesOff(scope: string): string | null {
  const fetcher = useScopedFetch();
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const value = enginesOffRead(scope, Date.now(), () => fetcher("/api/settings", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((body: { settings?: { atomikEngines?: unknown } } | null) => (typeof body?.settings?.atomikEngines === "string" ? body.settings.atomikEngines : "?")).catch(() => "?"));
    void value.then((v) => { if (live) setKey(v); });
    return () => { live = false; };
  }, [fetcher, scope]);
  return key;
}

function SavedPrice({ row, api }: { row: Extract<SkillRow, { kind: "saved" }>; api: SkillsApi }) {
  const scope = useSession().requestScope ?? "";
  const enginesOff = useEnginesOff(scope);
  const key = `${scope}:${row.skill.id}:${row.skill.version}:${row.skill.updatedAt}:${enginesOff}`;
  const [read, setRead] = useState<{ key: string; value: Read } | null>(null);
  useEffect(() => {
    if (enginesOff === null || READ.has(key)) return;
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
        const value: Read = needsWords(message) ? { reason: "skillPriceWords" } : { quote: { state: "error", message: message && message !== "Failed to fetch" ? message : QUOTE_FAULT } };
        if (needsWords(message)) READ.set(key, value);
        if (live) setRead({ key, value });
      },
    );
    return () => { live = false; };
  }, [api, key, enginesOff, row.skill.id]);
  const value = enginesOff === null ? null : READ.get(key) ?? (read?.key === key ? read.value : null);
  if (!value) return <Price quote={LOADING} />;
  return "reason" in value ? <Price quote={null} reason={value.reason} /> : <Price quote={value.quote} />;
}
