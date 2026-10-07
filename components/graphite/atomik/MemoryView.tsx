"use client";
import { useEffect, useId, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { Project } from "@/lib/workbench/studio";
import { useMemory, useMemoryApi, type KeepReply, type MemoryApi } from "@/lib/shell/use-memory";
import { useWorkspace } from "@/lib/workspace/state";
import { useShell } from "@/lib/shell/state";
import { useIdentities } from "@/lib/workspace/identities";
import { usePaidAction } from "@/lib/usePaidAction";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import {
  IMPORT_FROM, MEMORY_KIND_LABEL, MEMORY_KINDS, MEMORY_LIMITS, REF_SOURCE_LABEL, TEXT_KINDS, amountRefusal, brandKitPicks, castRef, mentionsMoney, refSource, soulRef,
  type BrandKitPick, type ImportFrom, type ImportedEntry, type MemoryKind, type MemoryView as Entry,
} from "@/lib/atomikMemoryText";
import { LoadBanner } from "../TakeTile";
import { Price } from "../Price";
import { exact, upTo } from "@/lib/shell/price-words";

/**
 * Atomik › Memory, built in Particl: what Atomik
 * keeps in mind when it plans — brand, audience, references, approved
 * identities and notes, for this project or the whole workspace.
 *
 * Nothing is kept silently: a person adds an entry here — in words, or an
 * approved identity picked from Cast & Elements — or with Remember on an
 * asset or an Agent message, or picks lines of the Business brand kit; what
 * Atomik suggests and what a paste from another assistant turns into waits
 * under "Waiting for you" until someone keeps it. Forget archives an entry (a
 * copy stays in the workspace archive); an edit archives the version it
 * replaces. Nothing on this page spends except Atomik reading a paste or a
 * document, an explicit choice beside the free import: priced first ("about
 * N cr"), charged what it actually costs, and nothing it proposes is kept
 * until the person ticks it.
 */

const when = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const ORDER = (a: Entry, b: Entry) => MEMORY_KINDS.indexOf(a.kind) - MEMORY_KINDS.indexOf(b.kind) || b.updatedAt - a.updatedAt;
const failed = (error: unknown, fallback: string) => (error instanceof Error && error.message && error.message !== "Failed to fetch" ? error.message : fallback);
/** The same words, as the server compares them (lib/atomikMemory › duplicateOf). */
const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9#@]+/g, " ").trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Who kept it and when, in one line. */
function provenance(e: Entry): string {
  const by = e.byYou ? "you" : e.byName ?? "a teammate";
  const keptBy = e.acceptedByYou ? "you" : e.acceptedByName ?? "a teammate";
  const date = when(e.acceptedAt ?? e.createdAt);
  if (e.source === "person") return e.origin === "brand-kit" ? `From the brand kit, added by ${by} · ${date}` : `Added by ${by} · ${date}`;
  const from = e.source === "atomik" ? "Suggested by Atomik" : e.origin === "atomik-read" ? "Read by Atomik" : `Imported from ${e.origin ?? "another assistant"}`;
  return e.status === "proposed" ? `${from} · ${when(e.createdAt)}` : `${from}, kept by ${keptBy} · ${date}`;
}

/** What a skipped count says after a keep or an import, in a sentence each. */
function skippedSaid(skipped: Partial<KeepReply["skipped"]>): string {
  return [
    skipped.money ? `${plural(skipped.money, "line")} with an amount left out.` : "",
    skipped.duplicates ? `${skipped.duplicates} already kept.` : "",
    skipped.beyondLimit ? `${skipped.beyondLimit} more than memory holds.` : "",
    skipped.invalid ? `${skipped.invalid} could not be kept.` : "",
  ].filter(Boolean).join(" ");
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
      <p className="tc-intro">Atomik keeps these in mind when it plans: the few that fit each request, most relevant first. Adding, keeping and forgetting are free; only Atomik reading a paste for you is paid, and it is priced first.</p>
      {memory.status === "error" ? <LoadBanner banner={{ tone: "error", message: memory.error ?? "Memory could not be loaded." }} onRetry={memory.refresh} testId="memory-error" /> : null}
      <AddMemory api={memory.api} scope={scope} project={project} projectId={projectId} entries={memory.entries} onSaved={memory.refresh} />
      <BrandKitMemory api={memory.api} project={project} projectId={projectId} entries={memory.entries} ready={ready} onSaved={memory.refresh} />
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
      <ImportMemory api={memory.api} scope={scope} projectId={projectId} entries={memory.entries} onImported={memory.refresh} />
    </div>
  );
}

/* ── Add: words, or an approved identity from Cast & Elements ───────────── */

function AddMemory({ api, scope, project, projectId, entries, onSaved }: { api: MemoryApi; scope: string; project: Project | null; projectId: string | null; entries: Entry[]; onSaved: () => Promise<void> }) {
  const { toast } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<MemoryKind>("brand");
  const [text, setText] = useState("");
  const [where, setWhere] = useState<Where>(projectId ? "project" : "workspace");
  /* An approved identity is said in words, or picked from Cast & Elements (a Library asset is kept from the Inspector). */
  const [from, setFrom] = useState<"words" | "cast">("words");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useId();
  const element = kind === "identity" && from === "cast";
  const refusal = mentionsMoney(text) ? amountRefusal(text) : null;
  const place: Where = projectId ? where : "workspace";
  const canSave = !busy && !refusal && (element ? Boolean(picked) : text.trim().length >= 2);
  const close = () => { setOpen(false); setText(""); setProblem(null); setPicked(null); setFrom("words"); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true); setProblem(null);
    try {
      await api.add({ kind, text, projectId: place === "project" ? projectId : null, ...(element && picked ? { assetId: picked } : {}) });
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
          <KindPicker kinds={TEXT_KINDS} kind={kind} onChange={(next) => { setKind(next); setProblem(null); }} label="What it is" />
          {kind === "identity" ? (
            <div className="gx-seg am-where" role="group" aria-label="The approved identity">
              <button type="button" className="gx-seg-btn" aria-pressed={from === "words"} onClick={() => { setFrom("words"); setProblem(null); }} data-testid="memory-identity-words"><span>In words</span></button>
              <button type="button" className="gx-seg-btn" aria-pressed={from === "cast"} onClick={() => { setFrom("cast"); setProblem(null); }} data-testid="memory-identity-cast"><span>Cast & Elements</span></button>
            </div>
          ) : null}
          {element ? <ElementPicker scope={scope} project={project} entries={entries} picked={picked} onPick={(ref) => { setPicked(ref); setProblem(null); }} /> : null}
          <label className="am-label" htmlFor={field}>{element ? "What should Atomik know about it? Optional." : "What should Atomik remember?"}</label>
          <textarea id={field} className="gx-textarea am-textarea" rows={3} maxLength={MEMORY_LIMITS.text} value={text} onChange={(e) => { setText(e.target.value); setProblem(null); }}
            placeholder={element ? "The approved face of the spring campaign." : kind === "brand" ? "Warm, dry humour. Teal and sand. A premium price point, never salesy." : kind === "audience" ? "Skaters, 16 to 24, in coastal towns." : kind === "identity" ? "@Maya is the approved lead." : "End every spot on the product."} data-testid="memory-text" />
          <WherePicker where={place} onChange={setWhere} hasProject={Boolean(projectId)} label="Where it applies" />
          {refusal ? <p className="gx-gen-error" role="alert" data-testid="memory-money">{refusal}</p> : null}
          {problem ? <p className="gx-gen-error" role="alert" data-testid="memory-problem">{problem}</p> : null}
          <div className="am-actions">
            <button type="submit" className="gx-primary" disabled={!canSave} data-testid="memory-save">{busy ? "Saving…" : "Remember"}</button>
            <button type="button" className="gx-hbtn" onClick={close} data-testid="memory-add-cancel">Cancel</button>
          </div>
          <p className="tc-note">{kind === "identity" ? "An approved identity can also be a Library asset: open it in the Library and choose Remember." : "To keep a reference, open the asset in the Library and choose Remember."}</p>
        </form>
      ) : <p className="tc-note">Brand, audience, approved identities and notes, for this project or the whole workspace.</p>}
    </section>
  );
}

/**
 * The open project's Cast & Elements — its characters and elements — and the
 * identities trained in this workspace that are ready, to pick one as an
 * approved identity. Memory keeps a reference to the element, not a copy:
 * Atomik reads its name as it is when it plans, and leaves it out once it is
 * gone.
 */
function ElementPicker({ scope, project, entries, picked, onPick }: { scope: string; project: Project | null; entries: Entry[]; picked: string | null; onPick: (ref: string) => void }) {
  const shell = useShell();
  const productionId = project?.productionProjectId ?? null;
  const identities = useIdentities(scope, productionId && project ? project.id : null);
  const group = useId();
  if (!project || !productionId) return <p className="tc-note" data-testid="memory-elements-none">Open a saved project to pick from its Cast & Elements.</p>;
  const kept = new Set(entries.flatMap((e) => (e.assetId ? [e.assetId] : [])));
  const options = [
    ...(project.production?.cast?.entries ?? []).map((e) => ({ ref: castRef(productionId, e.id), name: e.name.trim() || "Unnamed", what: `${e.kind === "character" ? "Character" : "Element"} · Cast & Elements` })),
    ...(identities.state.data?.identities ?? []).filter((i) => i.status === "ready").map((i) => ({ ref: soulRef(i.id), name: i.name.trim() || REF_SOURCE_LABEL.soul, what: `${REF_SOURCE_LABEL.soul} · ${i.subjectType === "character" ? "character" : "element"}` })),
  ];
  const status = identities.state.status;
  return (
    <div className="am-picks" role="radiogroup" aria-label="Cast & Elements" data-testid="memory-elements">
      {options.map((o) => (
        <label key={o.ref} className="am-pick" data-testid="memory-element" data-ref={o.ref}>
          <input type="radio" name={group} checked={picked === o.ref} onChange={() => onPick(o.ref)} />
          <span className="am-pick-body">
            <span className="am-pick-name">{o.name}</span>
            <span className="am-meta">{kept.has(o.ref) ? `${o.what} · kept` : o.what}</span>
          </span>
        </label>
      ))}
      {status === "idle" || status === "loading" ? <p className="tc-note" role="status">Reading the identities…</p> : null}
      {status === "error" ? <LoadBanner banner={{ tone: "error", message: identities.state.error ?? "Identities could not be read." }} onRetry={identities.refresh} testId="memory-elements-error" compact /> : null}
      {!options.length && status === "ready" ? (
        <div className="am-none" data-testid="memory-elements-empty">
          <p className="tc-note">Nothing in Cast & Elements yet: add characters and elements there, or build an identity.</p>
          <button type="button" className="gx-hbtn" onClick={() => shell.goSuite("studio", "cast")} data-testid="memory-elements-go">Open Cast & Elements</button>
        </div>
      ) : null}
    </div>
  );
}

/* ── From the Business brand kit ─────────────────────────────────────────── */

/**
 * Memory offers the project's Business brand kit (Business › Brand, and the
 * products saved with it) as lines to keep: the person ticks the ones Atomik
 * should remember, and each lands as an ordinary entry. A line with an amount
 * loses that sentence, or cannot be kept at all; one already kept says so.
 * The workbench agent goes on reading the kit itself.
 */
export function BrandKitMemory({ api, project, projectId, entries, ready, onSaved }: { api: MemoryApi; project: Project | null; projectId: string | null; entries: Entry[]; ready: boolean; onSaved: () => Promise<void> }) {
  const shell = useShell();
  const { toast } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const [where, setWhere] = useState<Where>(projectId ? "project" : "workspace");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const place: Where = projectId ? where : "workspace";
  const picks = useMemo(() => {
    const assets = [...(project?.assets ?? []), ...(project?.sharedAssets ?? [])];
    return brandKitPicks(project?.moleculr, (id) => {
      const asset = assets.find((a) => a.id === id);
      return asset?.uploadId ? `upload:${asset.uploadId}` : asset?.generationId ? `generation:${asset.generationId}` : null;
    });
  }, [project]);
  const keptKeys = new Set(entries.map((e) => `${e.kind}\u0000${normal(e.text)}\u0000${e.assetId ?? ""}`));
  const isKept = (p: BrandKitPick) => keptKeys.has(`${p.kind}\u0000${normal(p.text)}\u0000${p.assetId ?? ""}`);
  const selectable = picks.filter((p) => !p.refused && !isKept(p));
  const chosen = selectable.filter((p) => ticked.includes(p.key));
  const keep = async () => {
    if (busy || !chosen.length) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const made = await api.keep({ items: chosen.map((p) => ({ kind: p.kind, text: p.text, ...(p.assetId ? { assetId: p.assetId } : {}) })), projectId: place === "project" ? projectId : null, from: "brand-kit" });
      const n = made.entries.length;
      setSaid([n ? `Kept ${plural(n, "line")} from the brand kit.` : "Nothing new to keep.", skippedSaid(made.skipped)].filter(Boolean).join(" "));
      setTicked([]);
      if (n) toast(`Atomik will remember ${n === 1 ? "that" : "them"}.`);
      await onSaved();
    } catch (error) { setProblem(failed(error, "Those lines could not be kept. Try again.")); }
    finally { setBusy(false); }
  };
  const summary = !project ? null : !picks.length ? "Nothing in it yet" : selectable.length ? `${plural(selectable.length, "line")} to pick from` : "Everything in it is kept";
  return (
    <section className="tc-card" aria-labelledby="am-kit" data-testid="memory-brandkit">
      <div className="tc-head">
        <h2 className="tc-title" id="am-kit">From the brand kit</h2>
        {ready && summary ? <span className="tc-summary" data-testid="memory-brandkit-summary">{summary}</span> : null}
        <span className="gx-spacer" />
        {!open && selectable.length ? <button type="button" className="gx-hbtn" onClick={() => { setOpen(true); setSaid(null); }} data-testid="memory-brandkit-open">Choose lines</button> : null}
      </div>
      {!picks.length ? (
        <div className="am-none" data-testid="memory-brandkit-none">
          <p className="tc-note">{project ? "This project has no brand kit yet. Set one up on the Ads board, then pick what Atomik should remember from it." : "Open a project to pick from its brand kit."}</p>
          {project ? <button type="button" className="gx-hbtn" onClick={() => shell.goBoard({ kind: "ads" })} data-testid="memory-brandkit-go">Open the Ads board</button> : null}
        </div>
      ) : open ? (
        <div className="am-form">
          <p className="tc-note">Tick what Atomik should remember. Each line is kept as an ordinary entry; the agent still reads the brand kit itself.</p>
          <div className="am-picks" role="group" aria-label="Brand kit lines">
            {picks.map((p) => {
              const kept = isKept(p);
              const off = Boolean(p.refused) || kept;
              return (
                <label key={p.key} className="am-pick" data-testid="memory-brandkit-pick" data-key={p.key} data-off={off || undefined}>
                  <input type="checkbox" checked={!off && ticked.includes(p.key)} disabled={off || busy}
                    onChange={(e) => setTicked((t) => (e.target.checked ? [...t, p.key] : t.filter((k) => k !== p.key)))} />
                  <span className="am-pick-body">
                    <span className="am-head"><span className="tc-pill">{p.label}</span><span className="am-meta">{MEMORY_KIND_LABEL[p.kind]}</span></span>
                    <span className="am-text">{p.text}</span>
                    {kept ? <span className="am-meta">Already kept.</span>
                      : p.refused ? <span className="am-meta am-gone">Has an amount (“{p.refused}”), so it can’t be kept.</span>
                      : p.leftOut ? <span className="am-meta">{plural(p.leftOut, "sentence")} with an amount left out.</span> : null}
                  </span>
                </label>
              );
            })}
          </div>
          <WherePicker where={place} onChange={setWhere} hasProject={Boolean(projectId)} label="Where they apply" />
          {problem ? <p className="gx-gen-error" role="alert" data-testid="memory-brandkit-problem">{problem}</p> : null}
          <div className="am-actions">
            <button type="button" className="gx-primary" disabled={busy || !chosen.length} onClick={() => void keep()} data-testid="memory-brandkit-keep">{busy ? "Keeping…" : chosen.length ? `Keep ${chosen.length}` : "Keep"}</button>
            <button type="button" className="gx-hbtn" disabled={busy || chosen.length === selectable.length} onClick={() => setTicked(selectable.map((p) => p.key))} data-testid="memory-brandkit-all">Tick all</button>
            <button type="button" className="gx-hbtn" disabled={busy} onClick={() => { setOpen(false); setTicked([]); setProblem(null); }} data-testid="memory-brandkit-cancel">Close</button>
          </div>
          {said ? <p className="tc-note" role="status" data-testid="memory-brandkit-result">{said}</p> : null}
        </div>
      ) : (
        <>
          <p className="tc-note">Pick lines from this project’s Business brand kit — name, voice, palette, audience, products — to keep as entries.</p>
          {said ? <p className="tc-note" role="status" data-testid="memory-brandkit-result">{said}</p> : null}
        </>
      )}
    </section>
  );
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

/** Where an entry's element lives, and the line said when it is gone. */
function sourceLine(entry: Entry): { what: string | null; gone: string } {
  const source = refSource(entry.assetId);
  const what = source === "library" ? null
    : source === "cast" ? `${REF_SOURCE_LABEL.cast}${entry.assetKind ? ` · ${entry.assetKind === "character" ? "Character" : "Element"}` : ""}`
    : source === "soul" ? REF_SOURCE_LABEL.soul : null;
  const gone = source === "cast" ? "No longer in Cast & Elements, so Atomik leaves it out."
    : source === "soul" ? "This identity is no longer in the workspace, so Atomik leaves it out."
    : "No longer in the Library, so Atomik leaves it out.";
  return { what, gone };
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
  const source = sourceLine(entry);
  /* A project entry can move to the workspace from anywhere; to a project only from that project. */
  const canProject = Boolean(projectId) && (entry.scope === "workspace" || entry.projectId === projectId);
  const refusal = mode === "edit" && mentionsMoney(text) ? amountRefusal(text) : null;
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
  /* A Library asset is a reference or an approved identity; a trained identity or an entry of Cast & Elements is an approved identity only. */
  const kinds: MemoryKind[] = !entry.assetId ? TEXT_KINDS : refSource(entry.assetId) === "library" ? ["reference", "identity"] : ["identity"];
  return (
    <div className="am-row" data-testid="memory-row" data-id={entry.id} data-kind={entry.kind} data-status={entry.status} data-scope={entry.scope}>
      <div className="am-body">
        <div className="am-head">
          <span className="tc-pill" data-testid="memory-kind">{MEMORY_KIND_LABEL[entry.kind]}</span>
          {entry.assetLabel ? <span className="am-asset" data-testid="memory-asset">{entry.assetLabel}</span> : null}
          {source.what ? <span className="am-meta" data-testid="memory-source">{source.what}</span> : null}
          {waiting ? <span className="am-meta">{scopeLabel}</span> : null}
        </div>
        {mode === "edit" ? (
          <div className="am-form am-form--inline">
            <KindPicker kinds={kinds} kind={kind} onChange={setKind} label="What it is" />
            <label className="am-label" htmlFor={field}>What Atomik should remember</label>
            <textarea id={field} className="gx-textarea am-textarea" rows={3} maxLength={MEMORY_LIMITS.text} value={text} onChange={(e) => { setText(e.target.value); setProblem(null); }} data-testid="memory-edit-text" />
            {canProject ? <WherePicker where={where} onChange={setWhere} hasProject label="Where it applies" /> : null}
            {refusal ? <p className="gx-gen-error" role="alert">{refusal}</p> : null}
          </div>
        ) : entry.text ? <p className="am-text" data-testid="memory-words">{entry.text}</p> : null}
        <span className="am-meta" data-testid="memory-meta">{provenance(entry)}</span>
        {!entry.available ? <span className="am-meta am-gone" data-testid="memory-gone">{source.gone}</span> : null}
        {problem ? <p className="gx-gen-error" role="alert" data-testid="memory-row-problem">{problem}</p> : null}
      </div>
      <div className="am-actions">
        {mode === "forget" ? (<>
          <span className="am-confirm" role="status">{waiting ? "Dismiss this suggestion?" : "Forget this? A copy stays in the workspace archive."}</span>
          <button type="button" className="gx-hbtn tc-danger" disabled={busy} onClick={() => void forget()} data-testid="memory-forget-confirm">{busy ? "Working…" : waiting ? "Dismiss" : "Forget"}</button>
          <button type="button" className="gx-hbtn" disabled={busy} onClick={() => setMode("view")} data-testid="memory-forget-keep">Keep it</button>
        </>) : mode === "edit" ? (<>
          <button type="button" className="gx-primary" disabled={busy || Boolean(refusal) || (!entry.assetId && text.trim().length < 2)} onClick={() => void save()} data-testid="memory-edit-save">{busy ? "Saving…" : waiting ? "Keep" : "Save"}</button>
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

/* ── Import: free on the page, or read by Atomik (paid, priced first) ──── */

const DOCUMENT_TYPES = ".txt,.md,.markdown,.csv,.json,.pdf,text/plain,text/markdown,text/csv,application/json,application/pdf";
/** A document's words, read in this browser: text as it is, a PDF's text by page. Nothing is uploaded. */
async function documentText(file: File): Promise<string> {
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
    const { extractScreenplayPdf } = await import("@/lib/workbench/screenplay-pdf");
    const read = await extractScreenplayPdf(file, new AbortController().signal, () => {});
    return read.text.replace(/\f/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  if (file.size > 2_000_000) throw new Error("Use a text document up to 2 MB, or paste the part Atomik should read.");
  return (await file.text()).replace(/\r\n?/g, "\n").trim();
}

function ImportMemory({ api, scope, projectId, entries, onImported }: { api: MemoryApi; scope: string; projectId: string | null; entries: Entry[]; onImported: () => Promise<void> }) {
  const [from, setFrom] = useState<ImportFrom>("chatgpt");
  const [text, setText] = useState("");
  const [where, setWhere] = useState<Where>("workspace");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const field = useId();
  const place: Where = projectId ? where : "workspace";
  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const made = await api.importText({ text, projectId: place === "project" ? projectId : null, from });
      const n = made.entries.length;
      setSaid([n ? `${n} ${n === 1 ? "entry is" : "entries are"} waiting for you above.` : "Nothing new to keep.", skippedSaid({ ...made.skipped, invalid: 0 })].filter(Boolean).join(" "));
      if (n) { setText(""); setLoaded(null); }
      await onImported();
    } catch (error) { setProblem(failed(error, "The paste could not be read. Try again.")); }
    finally { setBusy(false); }
  };
  const load = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setLoading(file.name); setProblem(null); setSaid(null); setLoaded(null);
    try {
      const words = await documentText(file);
      if (!words) throw new Error(`${file.name} has no text to read. Paste its words instead.`);
      const cut = words.length > MEMORY_LIMITS.importChars;
      setText(cut ? words.slice(0, MEMORY_LIMITS.importChars) : words);
      setLoaded(cut ? `${file.name} has ${words.length.toLocaleString("en-US")} characters; the first ${MEMORY_LIMITS.importChars.toLocaleString("en-US")} are in the box.` : `${file.name} is in the box. Edit it before you turn it into entries.`);
    } catch (error) { setProblem(error instanceof Error && error.message ? (/screenplay|PDF operation|Import cancelled/i.test(error.message) ? `${file.name} could not be read. Paste its words instead.` : error.message) : `${file.name} could not be read. Paste its words instead.`); }
    finally { setLoading(null); }
  };
  return (
    <section className="tc-card" aria-labelledby="am-import" data-testid="memory-import">
      <div className="tc-head"><h2 className="tc-title" id="am-import">Import from another assistant or a document</h2></div>
      <form className="am-form" onSubmit={(e) => void run(e)}>
        <p className="tc-note">Ask the other assistant “List everything you remember about me and my brand”, then paste the answer, or load a document. Each line becomes an entry for you to review; nothing is kept until you do.</p>
        <div className="gx-chips am-kinds" role="group" aria-label="From">
          {(Object.keys(IMPORT_FROM) as ImportFrom[]).map((id) => (
            <button key={id} type="button" className="gx-chip" aria-pressed={from === id} onClick={() => setFrom(id)} data-testid={`memory-from-${id}`}>{IMPORT_FROM[id]}</button>
          ))}
        </div>
        <label className="am-label" htmlFor={field}>Paste from {IMPORT_FROM[from]}, or load a document</label>
        <textarea id={field} className="gx-textarea am-textarea" rows={5} maxLength={MEMORY_LIMITS.importChars} value={text} disabled={reading} onChange={(e) => { setText(e.target.value); setProblem(null); }} data-testid="memory-import-text" />
        <div className="am-file">
          <label className="gx-hbtn am-file-btn" data-busy={loading ? true : undefined}>
            {loading ? "Reading…" : "Load a document"}
            <input type="file" accept={DOCUMENT_TYPES} disabled={Boolean(loading) || reading} onChange={(e) => void load(e)} data-testid="memory-import-file" />
          </label>
          <span className="am-meta">Text, Markdown, CSV, JSON or PDF. Read in this browser; nothing is uploaded.</span>
        </div>
        {loading ? <p className="tc-note" role="status">Reading {loading}…</p> : loaded ? <p className="tc-note" role="status" data-testid="memory-import-loaded">{loaded}</p> : null}
        <WherePicker where={place} onChange={setWhere} hasProject={Boolean(projectId)} label="Where it applies" />
        <div className="am-actions">
          <button type="submit" className="gx-primary" disabled={busy || reading || !text.trim()} data-testid="memory-import-go">{busy ? "Reading…" : "Turn into entries"}</button>
          <button type="button" className="gx-hbtn" disabled={busy || reading || !text.trim()} onClick={() => { setReading(true); setSaid(null); setProblem(null); }} data-testid="memory-read-open">Read with Atomik…</button>
        </div>
        <p className="tc-note">Turning lines into entries is free and happens here. Reading with Atomik is paid: it sorts long or untidy text into entries for you, and is priced before anything is sent.</p>
        {said ? <p className="tc-note" role="status" data-testid="memory-import-result">{said}</p> : null}
        {problem ? <p className="gx-gen-error" role="alert" data-testid="memory-import-problem">{problem}</p> : null}
      </form>
      <AtomikRead scope={scope} api={api} text={text} projectId={projectId} place={place} entries={entries} open={reading}
        onClose={() => setReading(false)} onKept={async (message) => { setReading(false); setText(""); setLoaded(null); setSaid(message); await onImported(); }} />
    </section>
  );
}

type ReadQuote = { model: string; estimateCredits: number; estimateUsd?: number };
type ReadReply = { id: string; model: string; entries: ImportedEntry[]; skipped: KeepReply["skipped"]; credits?: number | null; costUsd?: number };
const READ_URL = "/api/atomik/memory/read";

/** A price as the workspace pays it: credits, or the vendor's dollars for a workspace on its own keys. */
const priced = (credits: number, usd?: number) => (usd === undefined ? `about ${credits} cr` : `about $${usd.toFixed(3)}`);

/**
 * Atomik reads the text and proposes entries: priced first with an
 * approximate quote, run only when the person approves that price (the
 * request is saved before it is sent, so a lost reply is recovered without a
 * second charge), then a list to tick. Nothing it proposes is kept until the
 * person ticks it and presses Keep; the proposals pass the same amounts-only
 * check again on the way in.
 */
export function AtomikRead({ scope, api, text, projectId, place, entries, open, onClose, onKept, newWords = false }: {
  scope: string; api: MemoryApi; text: string; projectId: string | null; place: Where; entries: Entry[]; open: boolean;
  onClose: () => void; onKept: (message: string) => Promise<void>;
  /** The new interface's price words (lib/shell/price-words.ts): "up to N cr", credits only. Display alone: the quote, its cap and the read are the same. */
  newWords?: boolean;
}) {
  /* The read is sent with the quote as its ceiling (`maxCredits`), so "up to" holds; a workspace not billed in credits shows no figure. */
  const quoted = (credits: number, usd?: number): ReactNode => (!newWords ? priced(credits, usd) : usd === undefined ? <Price value={upTo(credits)} /> : "not billed in credits");
  const { toast } = useWorkspace();
  const paid = usePaidAction(`atomik-memory-read:${projectId ?? "workspace"}`, true, { signedIn: true, requestScope: scope });
  const scoped = useScopedFetch(scope);
  const [round, setRound] = useState(0);
  const [quote, setQuote] = useState<{ key: string; value?: ReadQuote; error?: string } | null>(null);
  const [reply, setReply] = useState<{ key: string; value: ReadReply } | null>(null);
  const [ticked, setTicked] = useState<number[]>([]);
  const [phase, setPhase] = useState<"idle" | "reading" | "keeping">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const body = useMemo(() => ({ text: text.trim(), projectId }), [text, projectId]);
  const quoteKey = JSON.stringify([body, round]);
  const shownQuote = quote?.key === quoteKey ? quote : null;
  const pending = paid.pending;
  /* The price, asked for when the panel opens (and again on Try again): a read-only quote, nothing reserved or sent. */
  useEffect(() => {
    if (!open || pending || reply || !body.text) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await scoped(READ_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, quoteOnly: true }), signal: controller.signal, cache: "no-store" });
        const value = (await response.json().catch(() => null)) as (ReadQuote & { error?: string }) | null;
        if (!response.ok || !value || typeof value.model !== "string" || !Number.isInteger(value.estimateCredits)) throw new Error(value?.error || "The price could not be read.");
        if (!controller.signal.aborted) setQuote({ key: quoteKey, value });
      } catch (error) {
        if (!controller.signal.aborted) setQuote({ key: quoteKey, error: failed(error, "The price could not be read.") });
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, pending, reply, body, quoteKey, scoped]);
  const runRead = async (input: Record<string, unknown>) => {
    setPhase("reading"); setProblem(null);
    try {
      const { data, request } = await paid.run<ReadReply>(READ_URL, input, { keepPending: true });
      setReply({ key: request.key, value: data });
      setTicked([]);
    } catch (error) { setProblem(failed(error, "Atomik could not read this. Nothing was kept.")); }
    finally { setPhase("idle"); }
  };
  const start = () => {
    const value = shownQuote?.value;
    if (!value || phase !== "idle") return;
    void runRead({ ...body, model: value.model, maxCredits: value.estimateCredits });
  };
  const recover = () => { if (pending && phase === "idle") void runRead(JSON.parse(pending.body) as Record<string, unknown>); };
  const finish = async () => {
    const key = reply?.key ?? pending?.key;
    if (key) await paid.complete(key);
    setReply(null); setTicked([]); setProblem(null);
  };
  const proposals = reply?.value.entries ?? [];
  const keptKeys = new Set(entries.map((e) => `${e.kind}\u0000${normal(e.text)}`));
  const isKept = (p: ImportedEntry) => keptKeys.has(`${p.kind}\u0000${normal(p.text)}`);
  const selectable = proposals.map((p, i) => ({ p, i })).filter(({ p }) => !isKept(p));
  const chosen = selectable.filter(({ i }) => ticked.includes(i));
  const keep = async () => {
    if (phase !== "idle" || !chosen.length) return;
    setPhase("keeping"); setProblem(null);
    try {
      const made = await api.keep({ items: chosen.map(({ p }) => ({ kind: p.kind, text: p.text })), projectId: place === "project" ? projectId : null, from: "atomik-read" });
      await finish();
      const n = made.entries.length;
      if (n) toast(`Atomik will remember ${n === 1 ? "that" : "them"}.`);
      await onKept([n ? `Kept ${plural(n, "entry", "entries")} Atomik read.` : "Nothing new to keep.", skippedSaid(made.skipped)].filter(Boolean).join(" "));
    } catch (error) { setProblem(failed(error, "Those entries could not be kept. Try again.")); }
    finally { setPhase("idle"); }
  };
  if (!open && !pending && !reply) return null;
  const value = reply?.value;
  const billed: ReactNode = value ? (value.credits != null ? (newWords ? <Price value={exact(value.credits)} /> : `${value.credits} cr`) : value.costUsd != null && !newWords ? `$${value.costUsd.toFixed(3)}` : null) : null;
  return (
    <div className="am-read" data-testid="memory-read">
      {value ? (
        <>
          <h3 className="am-read-title">What Atomik read</h3>
          <p className="tc-note" role="status" data-testid="memory-proposals-summary">{[
            `Atomik proposed ${plural(proposals.length, "entry", "entries")}.`,
            value.skipped.money ? `${plural(value.skipped.money, "line")} with an amount left out.` : "",
            !newWords && billed ? `Read for ${billed}.` : "",
            "Tick what to keep; nothing is kept until you do.",
          ].filter(Boolean).join(" ")}{newWords && billed ? <> Read for {billed}.</> : null}</p>
          <div className="am-picks" role="group" aria-label="What Atomik proposed" data-testid="memory-proposals">
            {proposals.map((p, i) => {
              const kept = isKept(p);
              return (
                <label key={i} className="am-pick" data-testid="memory-proposal" data-kind={p.kind} data-off={kept || undefined}>
                  <input type="checkbox" checked={!kept && ticked.includes(i)} disabled={kept || phase !== "idle"}
                    onChange={(e) => setTicked((t) => (e.target.checked ? [...t, i] : t.filter((x) => x !== i)))} />
                  <span className="am-pick-body">
                    <span className="am-head"><span className="tc-pill">{MEMORY_KIND_LABEL[p.kind]}</span>{kept ? <span className="am-meta">Already kept</span> : null}</span>
                    <span className="am-text">{p.text}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {problem ? <p className="gx-gen-error" role="alert" data-testid="memory-read-problem">{problem}</p> : null}
          <div className="am-actions">
            <button type="button" className="gx-primary" disabled={phase !== "idle" || !chosen.length} onClick={() => void keep()} data-testid="memory-proposals-keep">{phase === "keeping" ? "Keeping…" : chosen.length ? `Keep ${chosen.length}` : "Keep"}</button>
            <button type="button" className="gx-hbtn" disabled={phase !== "idle" || chosen.length === selectable.length} onClick={() => setTicked(selectable.map(({ i }) => i))} data-testid="memory-proposals-all">Tick all</button>
            <button type="button" className="gx-hbtn" disabled={phase !== "idle"} onClick={() => void finish().then(onClose)} data-testid="memory-proposals-discard">Discard</button>
          </div>
        </>
      ) : pending ? (
        <>
          <h3 className="am-read-title">A read is waiting</h3>
          <p className="tc-note">Atomik was reading text for you when this page closed. Recover it to see what it proposed; it is not read, or charged, again.</p>
          {problem ? <p className="gx-gen-error" role="alert" data-testid="memory-read-problem">{problem}</p> : null}
          <div className="am-actions">
            <button type="button" className="gx-primary" disabled={phase !== "idle"} onClick={recover} data-testid="memory-read-recover">{phase === "reading" ? "Recovering…" : "Recover the read"}</button>
          </div>
        </>
      ) : (
        <>
          <h3 className="am-read-title">Read with Atomik</h3>
          <p className="tc-note">Atomik reads the text above{shownQuote?.value ? ` with ${thinkingModelName(shownQuote.value.model)}` : ""} and proposes entries for you to tick. Nothing is kept until you tick it.</p>
          {shownQuote?.value ? (
            <p className="tc-note" data-testid="memory-read-estimate">{newWords
              ? <>{quoted(shownQuote.value.estimateCredits, shownQuote.value.estimateUsd)} · charged what the read actually costs, never more.</>
              : <>{priced(shownQuote.value.estimateCredits, shownQuote.value.estimateUsd)} · charged what the read actually costs, with up to {shownQuote.value.estimateUsd === undefined ? `${shownQuote.value.estimateCredits} cr` : "that"} reserved until it finishes.</>}</p>
          ) : shownQuote?.error ? (
            <LoadBanner banner={{ tone: "error", message: shownQuote.error }} onRetry={() => setRound((r) => r + 1)} testId="memory-read-quote-error" compact />
          ) : <p className="tc-note" role="status">Pricing…</p>}
          {problem ? <p className="gx-gen-error" role="alert" data-testid="memory-read-problem">{problem}</p> : null}
          <div className="am-actions">
            <button type="button" className="gx-primary" disabled={phase !== "idle" || !shownQuote?.value || !body.text} onClick={start} data-testid="memory-read-go">
              {phase === "reading" ? "Reading…" : shownQuote?.value ? <>Read · {quoted(shownQuote.value.estimateCredits, shownQuote.value.estimateUsd)}</> : shownQuote?.error ? "Price unavailable" : "Pricing…"}
            </button>
            <button type="button" className="gx-hbtn" disabled={phase !== "idle"} onClick={() => { setProblem(null); onClose(); }} data-testid="memory-read-cancel">Cancel</button>
          </div>
        </>
      )}
    </div>
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
  const refusal = mentionsMoney(note) ? amountRefusal(note) : null;
  const place: Where = projectId ? where : "workspace";
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || refusal) return;
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
      {refusal ? <p className="gx-gen-error" role="alert">{refusal}</p> : null}
      {problem ? <p className="gx-gen-error" role="alert" data-testid="remember-problem">{problem}</p> : null}
      <div className="am-actions">
        <button type="submit" className="gx-primary" disabled={busy || Boolean(refusal)} data-testid="remember-save">{busy ? "Saving…" : "Remember"}</button>
        <button type="button" className="gx-hbtn" disabled={busy} onClick={onDone} data-testid="remember-cancel">Cancel</button>
      </div>
    </form>
  );
}

/** The Inspector's page body here: what memory is, and what on it spends. */
export function MemoryInspector() {
  return (
    <div className="tc-insp" data-inspector-body="memory">
      <span className="tc-insp-title">Memory</span>
      <span className="tc-insp-sub">Atomik Agent</span>
      <p className="tc-insp-note">Atomik reads the kept entries that fit each request, a few at a time, and never an amount of money. Suggestions wait until someone keeps them. Forget archives an entry; nothing is erased. Adding and keeping are free; Atomik reading a paste for you is paid and priced first.</p>
    </div>
  );
}
