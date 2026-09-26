"use client";
import { GEN_PRESET_KEY, type GenPreset } from "@/lib/shell/assets";
import { OWNER_RUNS, OWNER_RUN_EYEBROW, ownerRunTitle, type OwnerRunSurface } from "@/lib/shell/connected-capability";
import { useConnectedCapability } from "@/lib/shell/use-connected-capability";
import { useShell } from "@/lib/shell/state";
import { Glyph } from "./icons";

/** Gen, opened on an output (and optionally a prompt): its composer is on this workspace's credits by default. */
export function openGenOn(shell: ReturnType<typeof useShell>, preset: GenPreset) {
  try { sessionStorage.setItem(GEN_PRESET_KEY, JSON.stringify(preset)); } catch { /* Gen opens on its own default output */ }
  shell.goGen();
}

/**
 * What a member sees where the owner's Higgsfield account would run (idea
 * 19): who runs it, by name, and the way to make the same kind of thing on
 * this workspace's credits — Gen, on Studio engines, opened on the right
 * output. One card, no connect prompt, nothing read from the account. `page`
 * stands in for a whole page (Business, Viral); without it the card sits
 * inside a page that still works for a member (Cast).
 */
export function OwnerRunCard({ surface, page = false }: { surface: OwnerRunSurface; page?: boolean }) {
  const shell = useShell();
  const { ownerName } = useConnectedCapability(undefined, { read: false });
  const copy = OWNER_RUNS[surface];
  const card = (
    <section className="gx-gen-card gx-owner-run" aria-label={ownerRunTitle(surface, ownerName)} data-testid={`owner-run-${surface}`} data-section={surface === "cast" ? "soul" : undefined}>
      <span className="gx-eyebrow gx-owner-run-eyebrow" data-functional-label=""><Glyph name="key" size={13} className="gx-glyph" />{OWNER_RUN_EYEBROW}</span>
      <h2 className="gx-workflow-title" data-testid={`owner-run-${surface}-title`}>{ownerRunTitle(surface, ownerName)}</h2>
      <p className="gx-hint">{copy.line}</p>
      <div className="gx-owner-run-actions">
        <button type="button" className="gx-primary" onClick={() => openGenOn(shell, { prompt: "", type: copy.type })} data-testid={`owner-run-${surface}-gen`}>{copy.action}</button>
        {page && !shell.wide ? <button type="button" className="gx-hbtn" onClick={() => shell.openLibrary("assets")}>Open Library</button> : null}
      </div>
    </section>
  );
  return page ? <div className="gx-owner-run-page gx-enter" data-testid={`${surface}-owner-run`}>{card}</div> : card;
}
