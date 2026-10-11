"use client";
import { useState } from "react";
import { SpendButton } from "../SpendButton";
import { priceLabel, type SpendPrice } from "@/lib/spend";
import { useRecreate } from "@/lib/shell/use-asset-actions";
import { PhoneSheet } from "./PhoneSheet";
import { NEEDS_CONNECTION } from "./HomeScreen";
import { fixLine, quotePrice, useFixQuote, useFixSend, fixBody } from "./use-fix";
import type { LibraryEntry } from "@/lib/workspace/library";
import type { Project } from "@/lib/workbench/studio";

/**
 * Change with words (design/particl-graphite, Phone frames D): a sheet over the review with a short box, the engine in one
 * line ("the original stays") and "Make the fix" at the server's price for these very words. The button waits, disabled,
 * until there are words and a price for them. The send is the existing Seedance Edit route through its one-claim paid
 * action; a saved request that was never confirmed is recovered, never sent twice. The original is never touched: the fix
 * is a new take. The engine takes a 480p or 720p clip to edit; for one it will not edit the server's own reason is said
 * under the button, with "Remake it in Make" (the existing Recreate: the recipe, priced on Make's own button).
 */
export function FixSheet({ scope, project, entry, title, versions, online, onClose, onMade }: {
  scope: string;
  project: Project;
  entry: LibraryEntry;
  title: string;
  /** How many versions the shot has now (the next fix is that number). */
  versions: number;
  online: boolean;
  onClose: () => void;
  onMade: (line: string) => void;
}) {
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const send = useFixSend(project.id);
  const recreate = useRecreate();
  /* The quote is for the person's words; while the box is empty it stands in with one, so the price is on the button already. */
  const quote = useFixQuote(scope, online ? fixBody(entry, project.productionProjectId, send.saved ? String(send.saved.rawPrompt ?? "") : words) : null);
  const ready = quote.state === "ready" ? quote : null;
  const saved = send.saved;
  const price: SpendPrice = saved ? (typeof saved.maxCredits === "number" ? { upTo: saved.maxCredits } : null) : quotePrice(ready?.quote);
  const hasWords = words.trim().length > 0;
  const recover = Boolean(saved);
  const waits = busy || !online || (!recover && (!hasWords || !ready));
  const why = !online ? NEEDS_CONNECTION
    : recover ? null
    : quote.state === "error" ? quote.reason
    : !hasWords ? "Say what to change."
    : !ready ? "Reading the price…" : null;
  const spec = "Seedance 2.5 · 720p · the original stays";
  const press = async () => {
    if (waits) return;
    setBusy(true); setProblem(null);
    try {
      await send.send(ready, { sourceName: title, price: priceLabel(price) ?? undefined });
      onMade(`${title} · fix · ${priceLabel(price) ?? "queued"} · rendering`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "The fix was not sent.");
    } finally { setBusy(false); }
  };
  return (
    <PhoneSheet title="Change with words" onClose={onClose} testId="phone-fix" focusField
      footer={<>
        <SpendButton className="ph-btn ph-btn--primary" label={recover ? "Recover the fix" : "Make the fix"} price={price} busy={busy} busyLabel="Sending…" disabled={waits}
          onClick={() => void press()} data-testid="phone-fix-go" />
        {why ? <p className="ph-row-line ph-plan-why" role="status" data-testid="phone-fix-why">{why}</p> : null}
        {quote.state === "error" && !recover ? <button type="button" className="ph-btn" onClick={() => { onClose(); recreate(entry); }} data-testid="phone-fix-remake">Remake it in Make</button> : null}
        {problem || send.error ? <p className="ph-row-line ph-row-line--warn ph-plan-why" role="alert" data-testid="phone-fix-problem">{problem ?? send.error}</p> : null}
      </>}>
      <div className="ph-fix">
        <p className="ph-row-line ph-fix-count" data-testid="phone-fix-count">{fixLine(versions)}</p>
        {recover ? (
          <p className="ph-row-line" role="status" data-testid="phone-fix-recover">A fix you sent was not confirmed. Recover it: the same request is checked, and it is never sent twice.</p>
        ) : (
          <textarea className="ph-make-text ph-fix-text" aria-label="What to change" rows={3} placeholder="Plant her feet; fix the reflection." value={words}
            onChange={(e) => setWords(e.target.value)} maxLength={9500} data-testid="phone-fix-words" />
        )}
        <p className="ph-row-line" data-testid="phone-fix-engine">{spec}</p>
      </div>
    </PhoneSheet>
  );
}
