"use client";
import { useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { useMemory, type MemoryApi } from "@/lib/shell/use-memory";
import { MEMORY_KINDS, MEMORY_LIMITS, TEXT_KINDS, type MemoryKind, type MemoryView } from "@/lib/atomikMemoryText";
import { AtomikRead, BrandKitMemory } from "../atomik/MemoryView";
import { LoadBanner } from "../TakeTile";
import { when } from "./words";

/**
 * Control room › Memory (Atomik frame j; README § 3.4): what Atomik keeps in
 * mind, for this project and for the whole workspace, on Atomik's memory
 * (lib/atomikMemory.ts through lib/shell/use-memory.ts). Keeping, adding and
 * forgetting are free; forgetting archives an entry (lib/archive.ts) and never
 * erases it. Reading a document with Atomik is the one paid step: the existing
 * read, quoted first and capped at the quote, with its words in credits.
 */

/** The design's words for the code's kinds, where they mean the same (lead decision 15); a note stays a note. */
export const KIND_WORD: Record<MemoryKind, string> = { brand: "Brand", audience: "Audience", reference: "Reference", identity: "Cast", note: "Note" };

const ORDER = (a: MemoryView, b: MemoryView) => MEMORY_KINDS.indexOf(a.kind) - MEMORY_KINDS.indexOf(b.kind) || b.updatedAt - a.updatedAt;
const failed = (error: unknown, fallback: string) => (error instanceof Error && error.message && error.message !== "Failed to fetch" ? error.message : fallback);

/** Where an entry came from, in the product's words. */
export function provenance(e: MemoryView): string {
  const by = e.byYou ? "you" : e.byName ?? "a teammate";
  const asset = e.assetLabel ? `${e.assetLabel} · ` : "";
  if (e.source === "person") return `${asset}${e.origin === "brand-kit" ? "From the brand kit, added by" : "Added by"} ${by} · ${when(e.createdAt)}`;
  /* The words today's Memory page uses (components/graphite/atomik/MemoryView.tsx). */
  const from = e.source === "atomik" ? "Suggested by Atomik" : e.origin === "atomik-read" ? "Read by Atomik" : `Imported from ${e.origin ?? "another assistant"}`;
  if (e.status === "proposed") return `${asset}${from} · ${when(e.createdAt)}`;
  const kept = e.acceptedByYou ? "you" : e.acceptedByName ?? "a teammate";
  return `${asset}${from}, kept by ${kept} · ${when(e.acceptedAt ?? e.createdAt)}`;
}

export function MemoryRoom({ scope, project }: { scope: string; project: Project | null }) {
  const projectId = project?.productionProjectId ?? null;
  const memory = useMemory(scope, projectId);
  const waiting = memory.entries.filter((e) => e.status === "proposed").sort(ORDER);
  const kept = memory.entries.filter((e) => e.status === "active").sort(ORDER);
  const ours = kept.filter((e) => e.scope === "project");
  const everyone = kept.filter((e) => e.scope === "workspace");
  const ready = memory.status === "ready";
  const count = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

  return (
    <div className="cr-body" data-testid="memory">
      <section className="cr-col" aria-label="What Atomik keeps in mind">
        {memory.error ? <LoadBanner banner={{ tone: memory.entries.length ? "stale" : "error", message: memory.error }} onRetry={memory.refresh} testId="memory-error" /> : null}
        {waiting.length ? (
          <div className="cr-block" data-testid="memory-waiting">
            <div className="cr-block-head"><span className="cr-eyebrow">Waiting for you</span><span className="cr-count">Keep what is right</span></div>
            <ul className="cr-list">{waiting.map((e) => <MemoryLine key={`${e.id}:${e.updatedAt}`} entry={e} api={memory.api} onChanged={memory.refresh} />)}</ul>
          </div>
        ) : null}
        <div className="cr-block" data-testid="memory-project">
          <div className="cr-block-head">
            <span className="cr-eyebrow">This project{project?.name ? ` · ${project.name}` : ""}</span>
            {ready && projectId ? <span className="cr-count">{count(ours.length)}</span> : null}
          </div>
          {!projectId ? <p className="cr-empty">Open a saved project to keep memory for it.</p>
            : memory.status === "loading" && !memory.entries.length ? <p className="cr-empty" role="status" aria-busy="true">Reading memory…</p>
            : ours.length ? <ul className="cr-list">{ours.map((e) => <MemoryLine key={`${e.id}:${e.updatedAt}`} entry={e} api={memory.api} onChanged={memory.refresh} />)}</ul>
            : ready ? <p className="cr-empty" data-testid="memory-project-empty">Nothing kept for this project yet. Add a line, or let Atomik read a document.</p> : null}
        </div>
        <div className="cr-block" data-testid="memory-workspace">
          <div className="cr-block-head"><span className="cr-eyebrow">Whole workspace</span>{ready ? <span className="cr-count">{count(everyone.length)}</span> : null}</div>
          {everyone.length ? <ul className="cr-list">{everyone.map((e) => <MemoryLine key={`${e.id}:${e.updatedAt}`} entry={e} api={memory.api} onChanged={memory.refresh} />)}</ul> : null}
          <p className="cr-text">Workspace memory travels into every project. Project memory stays with its project.</p>
        </div>
      </section>
      <section className="cr-col" aria-label="Add to memory">
        <AddLine api={memory.api} projectId={projectId} onAdded={memory.refresh} />
        <ReadWithAtomik scope={scope} api={memory.api} projectId={projectId} entries={memory.entries} onKept={memory.refresh} />
        <div className="cr-block" data-testid="memory-brand-kit">
          <span className="cr-eyebrow">From the brand kit</span>
          <BrandKitMemory api={memory.api} project={project} projectId={projectId} entries={memory.entries} ready={ready} onSaved={memory.refresh} />
        </div>
      </section>
    </div>
  );
}

/** One entry: its kind, its words, where it came from; Keep or Skip while it waits, Forget once kept (asked once, in place). */
function MemoryLine({ entry, api, onChanged }: { entry: MemoryView; api: MemoryApi; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = entry.status === "proposed";
  const act = async (work: () => Promise<unknown>, fallback: string) => {
    setBusy(true); setProblem(null);
    try { await work(); await onChanged(); } catch (error) { setProblem(failed(error, fallback)); } finally { setBusy(false); setAsking(false); }
  };
  return (
    <li className="cr-memory" data-testid="memory-line" data-kind={entry.kind}>
      <span className="cr-kind">{KIND_WORD[entry.kind]}</span>
      <span className="cr-min">
        <span className="cr-memory-text">{entry.text}</span>
        <span className="cr-decided-line">{provenance(entry)}{entry.available ? "" : " · its Library item is gone, so Atomik leaves it out"}</span>
        {problem ? <span className="cr-row-error" role="alert">{problem}</span> : null}
      </span>
      <span className="cr-row-actions">
        {waiting ? (<>
          <button type="button" className="cr-btn" disabled={busy} onClick={() => void act(() => api.forget([entry.id], "dismissed"), "That could not be skipped. Try again.")} data-testid="memory-skip">Skip</button>
          <button type="button" className="cr-btn cr-btn--approve" disabled={busy} onClick={() => void act(() => api.update(entry.id, { accept: true, updatedAt: entry.updatedAt }), "That could not be kept. Try again.")} data-testid="memory-keep">Keep</button>
        </>) : asking ? (<>
          <button type="button" className="cr-btn" disabled={busy} onClick={() => void act(() => api.forget([entry.id], "forgotten"), "That could not be forgotten. Try again.")} data-testid="memory-forget-confirm">{busy ? "Forgetting…" : "Forget"}</button>
          <button type="button" className="cr-btn" disabled={busy} onClick={() => setAsking(false)} data-testid="memory-forget-keep">Keep</button>
        </>) : (
          <button type="button" className="cr-btn cr-btn--quiet" aria-label={`Forget: ${entry.text.slice(0, 40)}`} title="Forget" onClick={() => setAsking(true)} data-testid="memory-forget">×</button>
        )}
      </span>
    </li>
  );
}

/** "Add to memory": a line of the person's own, of a kind they can write without a Library item, here or for the whole workspace. */
function AddLine({ api, projectId, onAdded }: { api: MemoryApi; projectId: string | null; onAdded: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MemoryKind>("note");
  const [where, setWhere] = useState<"project" | "workspace">(projectId ? "project" : "workspace");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const place = projectId ? where : "workspace";
  const add = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      await api.add({ kind, text: text.trim(), projectId: place === "project" ? projectId : null });
      setText(""); setSaid(place === "project" ? "Added to this project's memory." : "Added to the workspace's memory.");
      await onAdded();
    } catch (error) { setProblem(failed(error, "That could not be added. Try again.")); }
    finally { setBusy(false); }
  };
  return (
    <div className="cr-block" data-testid="memory-add">
      <span className="cr-eyebrow">Add to memory</span>
      <textarea className="cr-input cr-textarea" rows={3} maxLength={MEMORY_LIMITS.text} value={text} onChange={(e) => { setText(e.target.value); setSaid(null); }} placeholder="Something Atomik should keep in mind." aria-label="Something Atomik should keep in mind" data-testid="memory-add-text" />
      <div className="cr-params">
        <label className="cr-label">Kind
          <select className="cr-input" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} data-testid="memory-add-kind">
            {TEXT_KINDS.map((k) => <option key={k} value={k}>{KIND_WORD[k]}</option>)}
          </select>
        </label>
        <label className="cr-label">Scope
          <select className="cr-input" value={place} onChange={(e) => setWhere(e.target.value as "project" | "workspace")} data-testid="memory-add-scope">
            <option value="project" disabled={!projectId}>This project</option>
            <option value="workspace">Whole workspace</option>
          </select>
        </label>
      </div>
      {problem ? <p className="cr-row-error" role="alert">{problem}</p> : said ? <p className="cr-text" role="status">{said}</p> : null}
      <button type="button" className="cr-btn cr-align-end" disabled={busy || !text.trim()} onClick={() => void add()} data-testid="memory-add-go">{busy ? "Adding…" : "Add"}</button>
    </div>
  );
}

/** "Read with Atomik": pasted text read into proposals through the existing paid read, priced before anything is sent. */
function ReadWithAtomik({ scope, api, projectId, entries, onKept }: { scope: string; api: MemoryApi; projectId: string | null; entries: MemoryView[]; onKept: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <div className="cr-block" data-testid="memory-read-with-atomik">
      <span className="cr-eyebrow">Read with Atomik</span>
      <p className="cr-text">Paste a document&rsquo;s text. Atomik reads it and proposes what to remember; nothing is kept until you say so. Reading is priced before it starts.</p>
      <textarea className="cr-input cr-textarea" rows={4} maxLength={MEMORY_LIMITS.importChars} value={text} disabled={open} onChange={(e) => { setText(e.target.value); setSaid(null); }} placeholder="Paste the text" aria-label="Text for Atomik to read" data-testid="memory-read-text" />
      {said ? <p className="cr-text" role="status">{said}</p> : null}
      {!open ? <button type="button" className="cr-primary cr-align-end" disabled={!text.trim()} onClick={() => setOpen(true)} data-testid="memory-read-open">Read with Atomik…</button> : null}
      <AtomikRead scope={scope} api={api} text={text} projectId={projectId} place={projectId ? "project" : "workspace"} entries={entries} open={open} newWords
        onClose={() => setOpen(false)} onKept={async (message) => { setOpen(false); setText(""); setSaid(message); await onKept(); }} />
    </div>
  );
}
