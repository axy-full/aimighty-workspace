"use client";
import { useEffect, useMemo, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { assetPreview, previewAttrs } from "@/lib/preview";
import { draftRequest } from "@/lib/workbench/draft-request";
import {
  UNLOCK_REASON_MAX, UNLOCK_REASON_MIN, cleanUnlockReason, lockEventLine, lockProblem, masterCheckLine,
  type LockEvent, type MasterCheck, type MasterRecord,
} from "@/lib/workbench/master-lock";
import { REF_KIND_LABELS, cardLabel, refKindChosen, refKindOf } from "@/lib/workbench/ref-kind";
import { REF_KINDS, type Asset, type CanvasNode, type Project } from "@/lib/workbench/studio";
import { formatCredits } from "@/lib/workspace/cost";
import { cutoutProblem } from "@/lib/workspace/cutout";
import { mediaBands } from "@/lib/workspace/format";
import { cardSource, cardUsers, cardVersions } from "@/lib/workspace/rig";
import { RIG_NO_PROJECT, rigLoadState } from "@/lib/workspace/rig-load-state";
import { useWorkspace } from "@/lib/workspace/state";
import { Kicker } from "../ui";
import { useRig } from "./RigProvider";
import "./rig.css";

/**
 * The Inspector for a Rig card that is not a shot (a reference, a note, a look
 * board): what it is to the production — a reference's kind, which a person
 * sets here for everyone on the canvas — the source it holds, that source's
 * versions and the versions saved on the card, and the cards it feeds.
 */
export function RigCardInspector() {
  const rig = useRig();
  const { state } = useWorkspace();
  const { selectedCard, project } = rig;
  if (!project || !selectedCard) {
    const load = rigLoadState({ status: rig.status, hasProject: !!project, projectId: state.projectId });
    return (
      <div data-inspector-body="node">
        <Kicker>Card</Kicker>
        <p className="pxw-inspector-note">
          {load === "loading" ? "Loading the canvas…" : load === "error" ? rig.error : project ? "Select a card on the canvas to see it here." : RIG_NO_PROJECT}
        </p>
      </div>
    );
  }
  /* Keyed by card so nothing said about one card stays on the next. */
  return <CardInspector key={selectedCard.id} node={selectedCard} project={project} />;
}

function SourceWell({ id, asset }: { id: string; asset: Asset | null }) {
  const [c1, c2] = mediaBands(id);
  /* The 640px preview for a stored picture, as the card on the canvas draws it; the file itself only for anything else. */
  const image = asset?.kind !== "image" ? null
    : asset.generationId ? `/api/workbench/preview/generation/${encodeURIComponent(asset.generationId)}`
    : asset.uploadId ? `/api/workbench/preview/upload/${encodeURIComponent(asset.uploadId)}`
    : asset.url;
  return (
    <div className="pxw-insp-preview" data-testid="card-preview" {...previewAttrs(assetPreview(asset))}>
      {asset?.kind === "video" ? (
        <video src={asset.url} muted playsInline preload="metadata" aria-label={asset.name} />
      ) : image ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={image} alt={asset!.name} />
      ) : (
        <>
          <span style={{ flex: 1, background: c1 }} />
          <span style={{ flex: 1.1, background: c2 }} />
        </>
      )}
    </div>
  );
}

/** The lock history of a master and whether its source is still what the lock froze (GET /api/rig/elements/[id]?view=lock). */
function useLockHistory(elementId: string | null, key: string) {
  const { scope } = useRig();
  const [attempt, setAttempt] = useState(0);
  const want = elementId ? `${elementId}:${key}:${attempt}` : null;
  const [result, setResult] = useState<{ want: string; history: LockEvent[]; check: MasterCheck | null; error: boolean } | null>(null);
  useEffect(() => {
    if (!elementId || !want) return;
    let live = true;
    draftRequest<{ history?: unknown; check?: MasterCheck }>(`/api/rig/elements/${encodeURIComponent(elementId)}?view=lock`, scope)
      .then((data) => { if (live) setResult({ want, history: Array.isArray(data.history) ? (data.history as LockEvent[]) : [], check: data.check ?? null, error: false }); })
      .catch(() => { if (live) setResult({ want, history: [], check: null, error: true }); });
    return () => { live = false; };
  }, [scope, elementId, want]);
  return { data: want && result?.want === want ? result : null, retry: () => setAttempt((n) => n + 1) };
}

const when = (at: number) => new Date(at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/** Lock the card as the master (free), unlock it with a reason (an admin), and the lock's history. */
function MasterSection({ node, project, master }: { node: CanvasNode; project: Project; master: boolean }) {
  const rig = useRig();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const record = node.master as Partial<MasterRecord> | undefined;
  const { data: history, retry } = useLockHistory(node.elementId ?? null, `${master}:${record?.lockedAt ?? ""}`);
  const problem = master ? null : lockProblem(node, project, false);
  const ready = cleanUnlockReason(reason).length >= UNLOCK_REASON_MIN;
  const lock = async () => {
    setBusy(true); setError(null);
    setError(await rig.lockMaster(node.id));
    setBusy(false);
  };
  const unlock = async () => {
    setBusy(true); setError(null);
    const why = await rig.unlockMaster(node.id, reason);
    setBusy(false);
    setError(why);
    if (!why) { setAsking(false); setReason(""); }
  };
  const check = master ? masterCheckLine(history?.check ?? null) : null;
  return (
    <div data-section="master" data-testid="card-master" data-master={master ? "locked" : "open"}>
      <Kicker className="pxw-insp-section">Master</Kicker>
      {master ? (
        <>
          <p className="pxw-master-state" data-testid="card-master-state">
            <span className="pxw-master-badge" data-functional-label="">Locked master</span>
            {record?.lockedBy ? <span className="pxw-master-by">{record.lockedBy}{record.lockedAt ? ` · ${when(Date.parse(record.lockedAt))}` : ""}</span> : null}
          </p>
          <p className="pxw-inspector-note">Its source, kind and card stay as they are for everyone, Atomik included. Locking it was free.</p>
          {check ? <p className="pxw-inspector-note" data-testid="card-master-check" data-state={history?.check?.state}>{check}</p> : null}
          {rig.canUnlock ? (
            asking ? (
              <div className="pxw-master-unlock">
                <label className="pxw-master-label" htmlFor={`unlock-${node.id}`} data-functional-label="">Why unlock it?</label>
                <textarea id={`unlock-${node.id}`} data-testid="card-unlock-reason" rows={2} maxLength={UNLOCK_REASON_MAX} value={reason}
                  placeholder="The reason is kept in its history." onChange={(e) => setReason(e.target.value)} />
                <div className="pxw-master-actions">
                  <button type="button" className="pxw-btn pxw-btn--control" disabled={busy} onClick={() => { setAsking(false); setError(null); }}>Cancel</button>
                  <button type="button" className="pxw-btn pxw-btn--amber" data-testid="card-unlock-confirm" disabled={busy || !ready} onClick={() => void unlock()}>
                    {busy ? "Unlocking…" : "Unlock with this reason"}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="pxw-btn pxw-btn--control pxw-master-button" data-testid="card-unlock" onClick={() => setAsking(true)}>Unlock…</button>
            )
          ) : (
            <p className="pxw-inspector-note" data-testid="card-unlock-note">Only an admin can unlock a master.</p>
          )}
        </>
      ) : (
        <>
          <p className="pxw-inspector-note">Lock this card as the master: its source becomes the one source of truth for this production, and nobody, Atomik included, can change it by accident.</p>
          <button type="button" className="pxw-btn pxw-btn--primary pxw-master-button" data-testid="card-lock" disabled={busy || !!problem} onClick={() => void lock()}>
            {busy ? "Locking…" : "Lock as master · free"}
          </button>
          {problem ? <p className="pxw-inspector-note" data-testid="card-lock-note">{problem}</p> : null}
        </>
      )}
      {error ? <p className="pxw-insp-error" role="alert">{error}</p> : null}
      {node.elementId ? (
        <div data-testid="card-lock-history">
          <Kicker className="pxw-insp-section">Lock history</Kicker>
          {history?.error ? (
            <p className="pxw-inspector-note">The lock history could not be read. <button type="button" className="pxw-link-button" onClick={retry}>Try again</button></p>
          ) : !history ? (
            <p className="pxw-inspector-note">Reading the lock history…</p>
          ) : history.history.length ? history.history.slice(0, 12).map((event) => (
            <div className="pxw-insp-version pxw-lock-event" key={event.id} data-action={event.action}>
              <span className="pxw-insp-version-label pxw-lock-line">{lockEventLine(event)}</span>
              <span className="pxw-insp-version-meta">{when(event.at)}</span>
            </div>
          )) : <p className="pxw-inspector-note">No lock has been recorded yet.</p>}
        </div>
      ) : null}
    </div>
  );
}

type CutStep = { kind: "idle" } | { kind: "quoting" } | { kind: "quoted"; credits: number; note: string | null } | { kind: "sending"; credits: number } | { kind: "error"; reason: string };

/** Luma's cut-out for a product (an Element card): priced first, approved, then a transparent PNG as the card's next version. */
function CutoutSection({ node, project, master }: { node: CanvasNode; project: Project; master: boolean }) {
  const rig = useRig();
  const [step, setStep] = useState<CutStep>({ kind: "idle" });
  if (refKindOf(node, project) !== "element") return null;
  const problem = cutoutProblem(project, node, master);
  const run = rig.cutouts[node.id];
  const ask = async () => {
    setStep({ kind: "quoting" });
    const quote = await rig.quoteCutout(node);
    setStep("credits" in quote ? { kind: "quoted", credits: quote.credits, note: null } : { kind: "error", reason: quote.reason });
  };
  const approve = async (credits: number) => {
    setStep({ kind: "sending", credits });
    const outcome = await rig.startCutout(node, credits);
    if (outcome.state === "running") setStep({ kind: "idle" });
    /* The price moved between the quote and the press: nothing was sent, and the new price is asked for. */
    else if (outcome.state === "repriced") setStep({ kind: "quoted", credits: outcome.credits, note: `The price is now about ${formatCredits(outcome.credits)}. Nothing was sent.` });
    else setStep({ kind: "error", reason: outcome.reason });
  };
  const price = (credits: number) => `about ${formatCredits(credits)}`;
  return (
    <div data-section="cutout" data-testid="card-cutout">
      <Kicker className="pxw-insp-section">Cut out</Kicker>
      {run?.phase === "running" ? (
        <p className="pxw-insp-notice" role="status" data-testid="card-cutout-state" data-phase="running">
          {run.held ? "Waiting for a render slot" : "Cutting out"} · {price(run.credits)} approved. The new version lands on this card when it is ready.
        </p>
      ) : problem ? (
        <p className="pxw-inspector-note" data-testid="card-cutout-note">{problem}</p>
      ) : (
        <>
          {run?.phase === "done" ? (
            <p className="pxw-inspector-note" data-testid="card-cutout-state" data-phase="done">
              {run.note ?? `Cut out. The transparent version is this card's source now; the original is kept${run.settled !== null ? ` · ${formatCredits(run.settled)} settled` : ""}.`}
            </p>
          ) : run?.phase === "failed" ? (
            <p className="pxw-insp-error" role="alert" data-testid="card-cutout-state" data-phase="failed">
              {run.reason}{run.settled !== null ? ` · ${formatCredits(run.settled)} settled` : ""} Its charge, if any, is in Activity.
            </p>
          ) : null}
          {step.kind === "quoted" || step.kind === "sending" ? (
            <div className="pxw-cutout-quote">
              <p className="pxw-cutout-price" data-testid="card-cutout-price">
                {step.kind === "quoted" && step.note ? `${step.note} ` : ""}The cut-out costs {price(step.credits)}, charged in credits once it is made. The original stays; the cut-out becomes a new version of this card’s source.
              </p>
              <div className="pxw-master-actions">
                <button type="button" className="pxw-btn pxw-btn--control" disabled={step.kind === "sending"} onClick={() => setStep({ kind: "idle" })}>Cancel</button>
                <button type="button" className="pxw-btn pxw-btn--primary pxw-cutout-approve" data-testid="card-cutout-approve" disabled={step.kind === "sending"}
                  onClick={() => void approve(step.credits)}>
                  {step.kind === "sending" ? "Sending…" : `Cut out · ${price(step.credits)}`}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="pxw-inspector-note">Lift the product off its background: a transparent PNG, so a scene can sit behind it. It is priced before anything runs.</p>
              <button type="button" className="pxw-btn pxw-btn--control pxw-master-button" data-testid="card-cutout-start" disabled={step.kind === "quoting"} onClick={() => void ask()}>
                {step.kind === "quoting" ? "Getting the price…" : "Cut out (background removal)"}
              </button>
              {step.kind === "error" ? <p className="pxw-insp-error" role="alert">{step.reason} <button type="button" className="pxw-link-button" onClick={() => void ask()}>Try again</button></p> : null}
            </>
          )}
        </>
      )}
    </div>
  );
}

function CardInspector({ node, project }: { node: CanvasNode; project: Project }) {
  const rig = useRig();
  const kind = refKindOf(node, project);
  const chosen = refKindChosen(node);
  const source = useMemo(() => cardSource(project, node), [project, node]);
  const versions = useMemo(() => cardVersions(project, node), [project, node]);
  const users = useMemo(() => cardUsers(project, node.id), [project, node.id]);
  const [error, setError] = useState<string | null>(null);
  const locked = !!node.locked;
  /* A master is a card whose element is locked: the server's answer, never the card's own lock record alone. */
  const master = !!node.elementId && rig.masters.has(node.elementId);
  const text = (node.text ?? "").trim();
  return (
    <div data-inspector-body="node" data-node-id={node.id} data-ref-kind={kind ?? undefined} data-master={master ? "locked" : undefined}>
      <div className="pxw-insp-output">
        <Kicker>{cardLabel(node, project)}</Kicker>
        <span className="pxw-insp-output-label">{source ? `v${source.asset.version} · ${source.kind}` : "No source yet"}</span>
      </div>
      <SourceWell id={node.id} asset={source?.asset ?? null} />
      <div className="pxw-inspector-subject" data-testid="inspector-title">{node.title}</div>
      {text ? <p className="pxw-card-text">{text}</p> : null}

      {kind ? (
        <div data-section="kind">
          <Kicker className="pxw-insp-section">Kind</Kicker>
          <div className="pxw-kind-picker" role="group" aria-label="Reference kind" data-testid="card-kind">
            {REF_KINDS.map((k) => (
              <button key={k} type="button" aria-pressed={k === kind} disabled={locked || master} data-kind={k}
                onClick={() => setError(rig.setRefKind(node.id, k))}>
                {REF_KIND_LABELS[k]}
              </button>
            ))}
          </div>
          <p className="pxw-inspector-note pxw-kind-note" data-testid="card-kind-note">
            {master ? "A locked master keeps its kind." : locked ? "Unlock this card to change its kind." : chosen ? "Set for everyone on this canvas." : "Read from the card until you choose one."}
          </p>
        </div>
      ) : null}

      {kind ? <MasterSection node={node} project={project} master={master} /> : null}
      <CutoutSection node={node} project={project} master={master} />

      <Kicker className="pxw-insp-section">Source</Kicker>
      {source ? (
        <div className="pxw-insp-row" data-testid="card-source">
          <span className="pxw-insp-row-thumb pxw-insp-row-thumb--media" aria-hidden="true">
            {source.asset.url && (source.asset.kind === "image" || source.asset.kind === "video")
              ? <LazyMedia url={source.asset.url} kind={source.asset.kind} alt="" name={source.asset.name} className="gx-lazy" />
              : <span {...previewAttrs(assetPreview(source.asset))} className="pxw-insp-row-glyph">▤</span>}
          </span>
          <span className="pxw-insp-row-text">
            <span className="pxw-insp-row-name">{source.asset.name}</span>
            <span className="pxw-insp-row-kind">{[source.kind, source.origin, source.asset.category, source.own ? null : "through its input"].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="pxw-insp-row-v" data-functional-label="">v{source.asset.version}</span>
        </div>
      ) : (
        <p className="pxw-inspector-note" style={{ marginTop: 0 }}>Nothing is attached to this card yet.</p>
      )}

      <Kicker className="pxw-insp-section">Versions</Kicker>
      <div data-testid="card-versions">
        {versions.length ? versions.map((row) => (
          <div className="pxw-insp-version" key={`${row.saved ? "saved" : "source"}:${row.id}`} data-current={row.current || undefined} data-saved={row.saved || undefined}>
            <span className="pxw-insp-version-v">{row.v}</span>
            <span className="pxw-insp-version-label">{row.label}</span>
            {row.meta ? <span className="pxw-insp-version-meta">{row.meta}</span> : null}
          </div>
        )) : <p className="pxw-inspector-note" style={{ marginTop: 0 }}>No versions yet.</p>}
      </div>

      {users.length ? (
        <div data-section="feeds">
          <Kicker className="pxw-insp-section">Feeds</Kicker>
          <div className="pxw-card-users">
            {users.map((user) => (
              <button key={user.id} type="button" className="pxw-link-button" onClick={() => rig.select(user.id)}>{user.name}</button>
            ))}
          </div>
        </div>
      ) : null}
      {error ? <p className="pxw-insp-error" role="alert">{error}</p> : null}
    </div>
  );
}
