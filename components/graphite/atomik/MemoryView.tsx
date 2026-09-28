"use client";
import { useId, useState, type FormEvent } from "react";
import type { Project } from "@/lib/workbench/studio";
import { useMemory, useMemoryApi, type MemoryApi } from "@/lib/shell/use-memory";
import { useWorkspace } from "@/lib/workspace/state";
import {
  IMPORT_FROM, MEMORY_KIND_LABEL, MEMORY_KINDS, MEMORY_LIMITS, MONEY_REFUSAL, TEXT_KINDS, mentionsMoney,
  type ImportFrom, type MemoryKind, type MemoryView as Entry,
} from "@/lib/atomikMemoryText";
import { LoadBanner } from "../TakeTile";

/**
 * Atomik › Memory (Supercomputer's memory, built in Particl): what Atomik
 * keeps in mind when it plans — brand, audience, references, approved
 * identities and notes, for this project or the whole workspace.
 *
 * Nothing is kept silently: a person adds an entry here, or with Remember on
 * an asset or an Agent message; what Atomik suggests and what a paste from
 * another assistant turns into waits under "Waiting for you" until someone
 * keeps it. Forget archives an entry (a copy stays in the workspace archive);
 * an edit archives the version it replaces. Nothing on this page spends.
 */

const when = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const ORDER = (a: Entry, b: Entry) => MEMORY_KINDS.indexOf(a.kind) - MEMORY_KINDS.indexOf(b.kind) || b.updatedAt - a.updatedAt;
const failed = (error: unknown, fallback: string) => (error instanceof Error && error.message && error.message !== "Failed to fetch" ? error.message : fallback);

/** Who kept it and when, in one line. */
function provenance(e: Entry): string {
  const by = e.byYou ? "you" : e.byName ?? "a teammate";
  const keptBy = e.acceptedByYou ? "you" : e.acceptedByName ?? "a teammate";
  const date = when(e.acceptedAt ?? e.createdAt);
  if (e.source === "person") return `Added by ${by} · ${date}`;
  const from = e.source === "atomik" ? "Suggested by Atomik" : `Imported from ${e.origin ?? "another assistant"}`;
  return e.status === "proposed" ? `${from} · ${when(e.createdAt)}` : `${from}, kept by ${keptBy} · ${date}`;
}

type Where = "project" | "workspace";

export function WherePicker({ where, onChange, hasProject, label }: { where: Where; onChange: (next: Where) => void; hasProject: boolean; label: string }) {
  return (
    <div className="gx-seg am-where" role="group" aria-label={label}>
      <button type="button" className="gx-seg-btn" aria-pressed={where === "project"} disabled={!hasProject} title={hasProject ? undefined : "Open a saved project to keep memory for it."} onClick={() => onChange("project")} data-testid="memory-where-project"><span>This project</span></button>
      <button type="button" className="gx-seg-btn" aria-pressed={where === "workspace"} onClick={() => onChange("workspace")} data-testid="memory-where-workspace"><span>Whole workspace</span></button>
    </div>
  );
}

export function KindPicker({ kinds, kind, onChange, label }: { kinds: MemoryKind[]; kind: MemoryKind; onChange: (next: MemoryKind) => void; label: string }) {
  return (
    <div className="gx-chips am-kinds" role="group" aria-label={label}>
      {kinds.map((k) => (
        <button key={k} type="button" className="gx-chip" aria-pressed={kind === k} onClick={() => onChange(k)} data-testid={`memory-kind-${k}`}>{MEMORY_KIND_LABEL[k]}</button>
      ))}
    </div>
  );
}

export function MemoryView({ scope, project }: { scope: string; project: Project | null }) {
  /* Memory is kept against the production (shared by the team), not a person's draft of it. */
  const projectId = project?.productionProjectId ?? null;
  const memory = useMemory(scope, projectId);
  const waiting = memory.entries.filter((e) => e.status === "proposed").sort(ORDER);
  const kept = memory.entries.filter((e) => e.status === "active").sort(ORDER);
  const ours = kept.filter((e) => e.scope === "project");
  const everyone = kept.filter((e) => e.scope === "workspace");
  const ready = memory.status === "ready";
  const reading = memory.status === "loading" && !memory.entries.length;
  const projectName = project?.name ?? null;
  return (
    <div className="sk tc am gx-enter" data-testid="memory-view" aria-busy={memory.status === "loading"}>
      <p className="tc-intro">Atomik keeps these in mind when it plans: the few that fit each request, most relevant first. Nothing here is charged.</p>
      {memory.status === "error" ? <LoadBanner banner={{ tone: "error", message: memory.error ?? "Memory could not be loaded." }} onRetry={memory.refresh} testId="memory-error" /> : null}
      <AddMemory api={memory.api} projectId={projectId} onSaved={memory.refresh} />
      {waiting.length ? (
        <section className="tc-card" aria-labelledby="am-waiting" data-testid="memory-waiting">
          <div className="tc-head">
            <h2 className="tc-title" id="am-waiting">Waiting for you</h2>
            <span className="tc-summary">{waiting.length} {waiting.length === 1 ? "suggestion" : "suggestions"} · Atomik reads none of them until you keep it</span>
          </div>
          {waiting.map((e) => <MemoryRow key={`${e.id}:${e.updatedAt}`} entry={e} api={memory.api} projectId={projectId} projectName={projectName} onChanged={memory.refresh} />)}
        </section>
      ) : null}
      <section className="tc-card" aria-labelledby="am-project" data-testid="memory-project">
        <div className="tc-head">
          <h2 className="tc-title" id="am-project">{projectName ? `This project · ${projectName}` : "This project"}</h2>
          {ready && projectId ? <span className="tc-summary">{ours.length} kept</span> : null}
        </div>
        {!projectId ? <p className="tc-pad gx-empty" data-testid="memory-project-none">Open a saved project to keep memory for it.</p>
          : reading ? <p className="tc-pad gx-empty" role="status">Reading memory…</p>
          : ours.length ? ours.map((e) => <MemoryRow key={`${e.id}:${e.updatedAt}`} entry={e} api={memory.api} projectId={projectId} projectName={projectName} onChanged={memory.refresh} />)
          : ready ? <p className="tc-pad gx-empty" data-testid="memory-project-empty">Nothing kept for this project yet.</p> : null}
      </section>
      <section className="tc-card" aria-labelledby="am-workspace" data-testid="memory-workspace">
        <div className="tc-head">
          <h2 className="tc-title" id="am-workspace">Whole workspace</h2>
          {ready ? <span className="tc-summary">{everyone.length} kept · every project reads these</span> : null}
        </div>
        {reading ? <p className="tc-pad gx-empty" role="status">Reading memory…</p>
          : everyone.length ? everyone.map((e) => <MemoryRow key={`${e.id}:${e.updatedAt}`} entry={e} api={memory.api} projectId={projectId} projectName={projectName} onChanged={memory.refresh} />)
          : ready ? <p className="tc-pad gx-empty" data-testid="memory-workspace-empty">Nothing kept for the whole workspace yet.</p> : null}
      </section>
      <ImportMemory api={memory.api} projectId={projectId} onImported={memory.refresh} />
    </div>
  );
}

function AddMemory({ api, projectId, onSaved }: { api: MemoryApi; projectId: string | null; onSaved: () => Promise<void> }) {
  const { toast } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<MemoryKind>("brand");
  const [text, setText] = useState("");
  const [where, setWhere] = useState<Where>(projectId ? "project" : "workspace");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useId();
  const money = mentionsMoney(text);
  const place: Where = projectId ? where : "workspace";
  const close = () => { setOpen(false); setText(""); setProblem(null); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || money || text.trim().length < 2) return;
    setBusy(true); setProblem(null);
    try {
      await api.add({ kind, text, projectId: place === "project" ? projectId : null });
      close();
      toast("Atomik will remember that.");
      await onSaved();
    } catch (error) { setProblem(failed(error, "That could not be saved. Try again.")); }
    finally { setBusy(false); }
  };
  return (
    <section className="tc-card" aria-labelledby="am-add" data-testid="memory-add">
      <div className="tc-head">
        <h2 className="tc-title" id="am-add">Add to memory</h2>
        <span className="gx-spacer" />
        {!open ? <button type="button" className="gx-primary" onClick={() => setOpen(true)} data-testid="memory-add-open">Add</button> : null}
      </div>
      {open ? (
        <form className="am-form" onSubmit={(e) => void save(e)} data-testid="memory-add-form">
          <KindPicker kinds={TEXT_KINDS} kind={kind} onChange={setKind} label="What it is" />
          <label className="am-label" htmlFor={field}>What should Atomik remember?</label>
          <textarea id={field} className="gx-textarea am-textarea" rows={3} maxLength={MEMORY_LIMITS.text} value={text} onChange={(e) => { setText(e.target.value); setProblem(null); }}
            placeholder={kind === "brand" ? "Warm, dry humour. Teal and sand. Never salesy." : kind === "audience" ? "Skaters, 16 to 24, in coastal towns." : kind === "identity" ? "@Maya is the approved lead." : "End every spot on the product."} data-testid="memory-text" />
          <WherePicker where={place} onChange={setWhere} hasProject={Boolean(projectId)} label="Where it applies" />
          {money ? <p className="gx-gen-error" role="alert" data-testid="memory-money">{MONEY_REFUSAL}</p> : null}
          {problem ? <p className="gx-gen-error" role="alert" data-testid="memory-problem">{problem}</p> : null}
          <div className="am-actions">
            <button type="submit" className="gx-primary" disabled={busy || money || text.trim().length < 2} data-testid="memory-save">{busy ? "Saving…" : "Remember"}</button>
            <button type="button" className="gx-hbtn" onClick={close} data-testid="memory-add-cancel">Cancel</button>
          </div>
          <p className="tc-note">To keep a reference, open the asset in the Library and choose Remember.</p>
        </form>
      ) : <p className="tc-note">Brand, audience, approved identities and notes, for this project or the whole workspace.</p>}
    </section>
  );
}

function MemoryRow({ entry, api, projectId, projectName, onChanged }: { entry: Entry; api: MemoryApi; projectId: string | null; projectName: string | null; onChanged: () => Promise<void> }) {
  const { toast } = useWorkspace();
  const [mode, setMode] = useState<"view" | "edit" | "forget">("view");
  const [text, setText] = useState(entry.text);
  const [kind, setKind] = useState<MemoryKind>(entry.kind);
  const [where, setWhere] = useState<Where>(entry.scope);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useId();
  const waiting = entry.status === "proposed";
  /* A project entry can move to the workspace from anywhere; to a project only from that project. */
  const canProject = Boolean(projectId) && (entry.scope === "workspace" || entry.projectId === projectId);
  const money = mode === "edit" && mentionsMoney(text);
  const act = async (work: () => Promise<unknown>, said: string, fallback: string) => {
    setBusy(true); setProblem(null);
    try { await work(); setMode("view"); toast(said); await onChanged(); }
    catch (error) { setProblem(failed(error, fallback)); }
    finally { setBusy(false); }
  };
  const save = () => act(() => api.update(entry.id, { text, kind, projectId: where === "project" ? projectId : null, updatedAt: entry.updatedAt, ...(waiting ? { accept: true } : {}) }),
    waiting ? "Kept. Atomik will remember it." : "Saved. The earlier version is in the workspace archive.", "That could not be saved. Try again.");
  const accept = () => act(() => api.update(entry.id, { accept: true, updatedAt: entry.updatedAt }), "Kept. Atomik will remember it.", "That could not be kept. Try again.");
  const forget = () => act(() => api.forget([entry.id], waiting ? "dismissed" : "forgotten"), waiting ? "Dismissed." : "Forgotten. A copy stays in the workspace archive.", "That could not be forgotten. Try again.");
  const scopeLabel = entry.scope === "project" ? (projectName ? `This project · ${projectName}` : "This project") : "Whole workspace";
  return (
    <div className="am-row" data-testid="memory-row" data-id={entry.id} data-kind={entry.kind} data-status={entry.status} data-scope={entry.scope}>
      <div className="am-body">
        <div className="am-head">
          <span className="tc-pill" data-testid="memory-kind">{MEMORY_KIND_LABEL[entry.kind]}</span>
          {entry.assetLabel ? <span className="am-asset" data-testid="memory-asset">{entry.assetLabel}</span> : null}
          {waiting ? <span className="am-meta">{scopeLabel}</span> : null}
        </div>
        {mode === "edit" ? (
          <div className="am-form am-form--inline">
            <KindPicker kinds={entry.assetId ? ["reference", "identity"] : TEXT_KINDS} kind={kind} onChange={setKind} label="What it is" />
            <label className="am-label" htmlFor={field}>What Atomik should remember</label>
            <textarea id={field} className="gx-textarea am-textarea" rows={3} maxLength={MEMORY_LIMITS.text} value={text} onChange={(e) => { setText(e.target.value); setProblem(null); }} data-testid="memory-edit-text" />
            {canProject ? <WherePicker where={where} onChange={setWhere} hasProject label="Where it applies" /> : null}
            {money ? <p className="gx-gen-error" role="alert">{MONEY_REFUSAL}</p> : null}
          </div>
        ) : entry.text ? <p className="am-text" data-testid="memory-words">{entry.text}</p> : null}
        <span className="am-meta" data-testid="memory-meta">{provenance(entry)}</span>
        {!entry.available ? <span className="am-meta am-gone" data-testid="memory-gone">No longer in the Library, so Atomik leaves it out.</span> : null}
        {problem ? <p className="gx-gen-error" role="alert" data-testid="memory-row-problem">{problem}</p> : null}
      </div>
      <div className="am-actions">
        {mode === "forget" ? (<>
          <span className="am-confirm" role="status">{waiting ? "Dismiss this suggestion?" : "Forget this? A copy stays in the workspace archive."}</span>
          <button type="button" className="gx-hbtn tc-danger" disabled={busy} onClick={() => void forget()} data-testid="memory-forget-confirm">{busy ? "Working…" : waiting ? "Dismiss" : "Forget"}</button>
          <button type="button" className="gx-hbtn" disabled={busy} onClick={() => setMode("view")} data-testid="memory-forget-keep">Keep it</button>
        </>) : mode === "edit" ? (<>
          <button type="button" className="gx-primary" disabled={busy || money || (!entry.assetId && text.trim().length < 2)} onClick={() => void save()} data-testid="memory-edit-save">{busy ? "Saving…" : waiting ? "Keep" : "Save"}</button>
          <button type="button" className="gx-hbtn" disabled={busy} onClick={() => { setMode("view"); setText(entry.text); setKind(entry.kind); setWhere(entry.scope); setProblem(null); }} data-testid="memory-edit-cancel">Cancel</button>
        </>) : (<>
          {waiting ? <button type="button" className="gx-primary" disabled={busy} onClick={() => void accept()} data-testid="memory-accept">{busy ? "Keeping…" : "Keep"}</button> : null}
          <button type="button" className="gx-hbtn" disabled={busy} onClick={() => setMode("edit")} aria-label={`Edit: ${entry.text || entry.assetLabel || MEMORY_KIND_LABEL[entry.kind]}`} data-testid="memory-edit">Edit</button>
          <button type="button" className="gx-hbtn" disabled={busy} onClick={() => setMode("forget")} aria-label={`${waiting ? "Dismiss" : "Forget"}: ${entry.text || entry.assetLabel || MEMORY_KIND_LABEL[entry.kind]}`} data-testid="memory-forget">{waiting ? "Dismiss" : "Forget"}</button>
        </>)}
      </div>
    </div>
  );
}

function ImportMemory({ api, projectId, onImported }: { api: MemoryApi; projectId: string | null; onImported: () => Promise<void> }) {
  const [from, setFrom] = useState<ImportFrom>("chatgpt");
  const [text, setText] = useState("");
  const [where, setWhere] = useState<Where>("workspace");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useId();
  const place: Where = projectId ? where : "workspace";
  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const made = await api.importText({ text, projectId: place === "project" ? projectId : null, from });
      const n = made.entries.length, money = made.skipped.money, already = made.skipped.duplicates, over = made.skipped.beyondLimit;
      setSaid([
        n ? `${n} ${n === 1 ? "entry is" : "entries are"} waiting for you above.` : "Nothing new to keep.",
        money ? `${money} ${money === 1 ? "line" : "lines"} about money left out.` : "",
        already ? `${already} already kept.` : "",
        over ? `${over} more than memory holds.` : "",
      ].filter(Boolean).join(" "));
      if (n) setText("");
      await onImported();
    } catch (error) { setProblem(failed(error, "The paste could not be read. Try again.")); }
    finally { setBusy(false); }
  };
  return (
    <section className="tc-card" aria-labelledby="am-import" data-testid="memory-import">
      <div className="tc-head"><h2 className="tc-title" id="am-import">Import from another assistant</h2></div>
      <form className="am-form" onSubmit={(e) => void run(e)}>
        <p className="tc-note">Ask it “List everything you remember about me and my brand”, then paste the answer. Each line becomes an entry for you to review; nothing is kept until you do.</p>
        <div className="gx-chips am-kinds" role="group" aria-label="From">
          {(Object.keys(IMPORT_FROM) as ImportFrom[]).map((id) => (
            <button key={id} type="button" className="gx-chip" aria-pressed={from === id} onClick={() => setFrom(id)} data-testid={`memory-from-${id}`}>{IMPORT_FROM[id]}</button>
          ))}
        </div>
        <label className="am-label" htmlFor={field}>Paste from {IMPORT_FROM[from]}</label>
        <textarea id={field} className="gx-textarea am-textarea" rows={5} maxLength={MEMORY_LIMITS.importChars} value={text} onChange={(e) => { setText(e.target.value); setProblem(null); }} data-testid="memory-import-text" />
        <WherePicker where={place} onChange={setWhere} hasProject={Boolean(projectId)} label="Where it applies" />
        <div className="am-actions">
          <button type="submit" className="gx-primary" disabled={busy || !text.trim()} data-testid="memory-import-go">{busy ? "Reading…" : "Turn into entries"}</button>
        </div>
        {said ? <p className="tc-note" role="status" data-testid="memory-import-result">{said}</p> : null}
        {problem ? <p className="gx-gen-error" role="alert" data-testid="memory-import-problem">{problem}</p> : null}
      </form>
    </section>
  );
}

/**
 * "Remember this" on an asset (the Inspector): the asset is kept as a
 * reference or an approved identity, by its Library id, with a line on why
 * it matters, for this project or the whole workspace. A person presses it;
 * nothing spends.
 */
export function RememberAsset({ scope, projectId, assetId, name, onDone }: { scope: string; projectId: string | null; assetId: string; name: string; onDone: () => void }) {
  const api = useMemoryApi(scope);
  const { toast } = useWorkspace();
  const [kind, setKind] = useState<MemoryKind>("reference");
  const [note, setNote] = useState("");
  const [where, setWhere] = useState<Where>(projectId ? "project" : "workspace");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useId();
  const money = mentionsMoney(note);
  const place: Where = projectId ? where : "workspace";
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || money) return;
    setBusy(true); setProblem(null);
    try {
      await api.add({ kind, text: note, assetId, projectId: place === "project" ? projectId : null });
      toast(`Atomik will remember ${name}.`);
      onDone();
    } catch (error) { setProblem(failed(error, "That could not be saved. Try again.")); }
    finally { setBusy(false); }
  };
  return (
    <form className="am-form tc gx-insp-remember" onSubmit={(e) => void save(e)} aria-label={`Remember ${name}`} data-testid="remember-asset">
      <span className="am-label">Remember as</span>
      <KindPicker kinds={["reference", "identity"]} kind={kind} onChange={setKind} label="Remember as" />
      <label className="am-label" htmlFor={field}>What should Atomik know about it? Optional.</label>
      <textarea id={field} className="gx-textarea am-textarea" rows={2} maxLength={MEMORY_LIMITS.text} value={note} onChange={(e) => { setNote(e.target.value); setProblem(null); }}
        placeholder={kind === "identity" ? "The approved face for the lead." : "Our hero angle: low, wide, warm."} data-testid="remember-note" />
      <WherePicker where={place} onChange={setWhere} hasProject={Boolean(projectId)} label="Where it applies" />
      {money ? <p className="gx-gen-error" role="alert">{MONEY_REFUSAL}</p> : null}
      {problem ? <p className="gx-gen-error" role="alert" data-testid="remember-problem">{problem}</p> : null}
      <div className="am-actions">
        <button type="submit" className="gx-primary" disabled={busy || money} data-testid="remember-save">{busy ? "Saving…" : "Remember"}</button>
        <button type="button" className="gx-hbtn" disabled={busy} onClick={onDone} data-testid="remember-cancel">Cancel</button>
      </div>
    </form>
  );
}

/** The Inspector's page body here: what memory is, and that nothing on it spends. */
export function MemoryInspector() {
  return (
    <div className="tc-insp" data-inspector-body="memory">
      <span className="tc-insp-title">Memory</span>
      <span className="tc-insp-sub">Atomik Supercomputer</span>
      <p className="tc-insp-note">Nothing here spends. Atomik reads the kept entries that fit each request, a few at a time, and never one about money. Suggestions wait until someone keeps them. Forget archives an entry; nothing is erased.</p>
    </div>
  );
}
