"use client";
import { useMemo, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { getModel } from "@/lib/models";
import { SOUL_FAMILY_NAMES, SOUL_VERSIONS, type SoulVersion } from "@/lib/soulRenderTypes";
import { usePaidAction } from "@/lib/usePaidAction";
import type { SoulIdentity, SoulTrainingVersion } from "@/lib/workbench/soul-identity";
import { useIdentities } from "@/lib/workspace/identities";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { SaveFailedError } from '@/lib/workbench/save-then-continue';

const ENDPOINT = "/api/soul/identities";
const STATUS: Record<SoulIdentity["status"], string> = { submitting: "Sending", training: "Training", ready: "Ready", failed: "Failed", uncertain: "Needs review" };
type Reference = { uploadId: string } | { genId: string };

/** A version's fixed training price, as the workspace pays it; null when it has none (then it is not offered). */
export function trainingPrice(version: SoulTrainingVersion | null | undefined): string | null {
  if (!version) return null;
  if (typeof version.trainingCredits === "number") return `about ${version.trainingCredits.toLocaleString("en-US")} cr`;
  if (typeof version.trainingCostUsd === "number") return `about $${version.trainingCostUsd.toFixed(2)}`;
  return null;
}

/** "A", "A and B", "A, B and C". */
const listOf = (names: string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** What an identity renders with, for the list. */
function familyOf(identity: SoulIdentity): string {
  if (!identity.renderModel) return "Earlier host · read-only";
  try { return getModel(identity.renderModel).label; } catch { return "Identity still"; }
}

/**
 * Studio › Cast › Build identity, on the platform's key: name it, choose what
 * it renders with (Standard, 2 or Cinema — only versions with a
 * training price are offered), pick 1–40 stills of the same person from this
 * project, confirm the rights, and it trains in this workspace at its fixed
 * price, shown on the button before anything is sent. Only this workspace's
 * own identities are listed (never the provider site's characters); earlier ones
 * stay listed, read-only. A lost reply is recovered by its saved request, never
 * sent twice.
 */
export function CastIdentities({ scope, projectId, items, save, consent = null, defaultName = "", onTrained }: {
  scope: string; projectId: string; items: LibraryEntry[]; save: () => Promise<boolean>;
  /** A recorded consent (the board's Cast card, Gaps A): it stands in for the rights box and is cited by the request. */
  consent?: { id: string; line: string } | null;
  defaultName?: string;
  onTrained?: () => void;
}) {
  const { toast } = useWorkspace();
  const { state, refresh } = useIdentities(scope, projectId);
  const data = state.data;
  const paid = usePaidAction(`soul-identity:${projectId}`, true, { signedIn: true, requestScope: scope });
  const [name, setName] = useState(defaultName);
  const [chosen, setChosen] = useState<SoulVersion>("v1");
  const [picked, setPicked] = useState<string[]>([]);
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ error: boolean; text: string } | null>(null);

  const terms = data?.terms;
  /* Only versions with a training price are offered, in the families' order. */
  const offered = SOUL_VERSIONS.map((v) => terms?.versions?.find((t) => t.version === v && trainingPrice(t))).filter((t): t is SoulTrainingVersion => Boolean(t));
  const version = offered.find((t) => t.version === chosen) ?? offered[0] ?? null;
  const price = trainingPrice(version);
  const min = terms?.minPhotos ?? 1, max = terms?.maxPhotos ?? 40;
  /* Stills of this project: images only, uploads and finished renders alike. */
  const stills = useMemo(() => items.filter((e) => e.media === "image" && e.url), [items]);
  const toggle = (id: string) => setPicked((all) => (all.includes(id) ? all.filter((x) => x !== id) : all.length >= max ? all : [...all, id]));
  const recovered = paid.pending ? (() => { try { return JSON.parse(paid.pending!.body) as Record<string, unknown>; } catch { return null; } })() : null;

  const blocked = !data ? (state.status === "error" ? state.error ?? "This workspace’s identities could not be read." : "Reading this workspace’s identities…")
    : !data.configured ? "Identity training is not set up on this platform yet."
    : !version || !price ? "No identity version has a training price yet."
    : !name.trim() ? "Name the identity."
    : picked.length < min || picked.length > max ? `Pick ${min}–${max} stills of the same person (${picked.length} picked).`
    : !consent && !ticked ? "Confirm you have the rights and consent to train this likeness."
    : null;

  const train = async () => {
    if (busy) return;
    setBusy(true); setOutcome(null);
    try {
      let body: Record<string, unknown>;
      if (paid.pending) {
        body = JSON.parse(paid.pending.body);
        if (paid.pending.url !== ENDPOINT || body.projectId !== projectId) throw new Error("Return to the original project to recover this training request.");
      } else {
        if (blocked || !version) throw new Error(blocked ?? "No identity version has a training price yet.");
        if (!(await save())) throw new SaveFailedError();
        const references: Reference[] = picked.flatMap((id) => {
          const e = stills.find((s) => s.take.id === id);
          return !e ? [] : [e.asset.origin === "upload" ? { uploadId: e.take.sourceId } : { genId: e.take.sourceId }];
        });
        body = { projectId, name: name.trim(), description: "", subjectType: "character", references, consent: true, ...(consent ? { consentId: consent.id } : {}), modelVersion: version.version,
          ...(typeof version.trainingCredits === "number" ? { maxCredits: version.trainingCredits } : { maxUsd: version.trainingCostUsd }) };
      }
      const { data: reply } = await paid.run<{ identity: SoulIdentity }>(ENDPOINT, body);
      const identity = reply.identity;
      if (identity.status === "failed" || identity.status === "uncertain") setOutcome({ error: true, text: identity.error || "Training needs review. Its status is listed below." });
      else {
        setOutcome({ error: false, text: `${identity.name} is training for ${familyOf(identity)}. It is listed below; characters can render with it once it is ready.` });
        toast(`${identity.name} is training`);
      }
      setName(""); setPicked([]); setTicked(false);
      onTrained?.();
    } catch (error) {
      /* A dropped connection is not a refusal: the request is saved, and Recover asks about it. */
      setOutcome({ error: true, text: error instanceof TypeError ? "The reply was lost. Recover the saved request; it is never sent twice."
        : error instanceof Error ? error.message : "The training request could not be confirmed. Recover the saved request." });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const identities = data?.identities ?? [];
  return (
    <section className="gx-gen-card gx-workflow" aria-label="Build identity" data-testid="soul-card" data-section="soul">
      <div className="gx-gen-row">
        <span className="gx-eyebrow" data-functional-label="">Identity · on this workspace’s credits</span>
        <h2 className="gx-workflow-title">Build identity</h2>
        <p className="gx-hint">Stills of one person become an identity in this workspace. Choose what it renders with; a character above then renders with it.</p>
      </div>
      {paid.error ? <p className="gx-gen-error" role="alert">{paid.error}</p> : null}
      {paid.pending ? (
        <div className="gx-gen-row pd-recover" data-testid="soul-recover">
          <p className="gx-hint">A training request was sent but its reply was lost: {typeof recovered?.name === "string" ? recovered.name : "an identity"}. Recovering asks about that same request; it is never sent twice.</p>
          <button type="button" className="gx-primary" disabled={busy} onClick={() => void train()} data-testid="soul-recover-run">{busy ? "Checking…" : "Recover the training request"}</button>
        </div>
      ) : (
        <>
          <div className="gx-gen-row">
            <label className="gx-eyebrow" htmlFor="soul-name" data-functional-label="">Name</label>
            <input id="soul-name" className="gx-field" placeholder="Character name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} data-testid="soul-name" />
          </div>
          <div className="gx-gen-row">
            <span className="gx-eyebrow" data-functional-label="">Renders with</span>
            {offered.length ? (
              <div className="gx-seg gx-seg--sm pd-soul-versions" role="radiogroup" aria-label="Renders with">
                {offered.map((t) => (
                  <button key={t.version} type="button" role="radio" className="gx-seg-btn" aria-checked={version?.version === t.version} onClick={() => setChosen(t.version)} data-testid={`soul-version-${t.version}`}>
                    <span>{SOUL_FAMILY_NAMES[t.version]}</span>
                  </button>
                ))}
              </div>
            ) : <p className="gx-hint">{data ? "No identity version has a training price yet." : "Reading…"}</p>}
            {data && offered.length && offered.length < SOUL_VERSIONS.length ? (() => {
              const unpriced = SOUL_VERSIONS.filter((v) => !offered.some((t) => t.version === v)).map((v) => SOUL_FAMILY_NAMES[v]);
              return <p className="gx-hint" data-testid="soul-versions-unpriced">{listOf(unpriced)} {unpriced.length === 1 ? "is" : "are"} not offered until training has a price.</p>;
            })() : null}
          </div>
          <div className="gx-gen-row">
            <span className="gx-eyebrow" data-functional-label="">Stills<span className="bz-note"> · {picked.length} of {min}–{max} · the same person, varied angles and light</span></span>
            {stills.length ? (
              <div className="gx-soul-grid" role="group" aria-label="Stills" data-testid="soul-stills">
                {stills.map((e) => (
                  <button key={e.take.id} type="button" className="gx-soul-still" aria-pressed={picked.includes(e.take.id)} aria-label={`Use ${e.take.name}`} onClick={() => toggle(e.take.id)} data-testid={`soul-still-${e.take.sourceId}`}>
                    <LazyMedia url={e.url!} kind="image" alt="" name={e.take.name} className="gx-lazy" />
                    {picked.includes(e.take.id) ? <span className="gx-badge gx-badge--new">{picked.indexOf(e.take.id) + 1}</span> : null}
                  </button>
                ))}
              </div>
            ) : <p className="gx-empty">No stills in this project yet. Upload or render some first.</p>}
          </div>
          {consent ? (
            <div className="gx-gen-row" data-testid="soul-consent-record">
              <span className="gx-eyebrow" data-functional-label="">Consent on file</span>
              <p className="gx-hint">{consent.line}</p>
            </div>
          ) : (
            <label className="pd-consent">
              <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} data-testid="soul-consent" />
              <span className="pd-check" aria-hidden="true" />
              <span className="gx-hint">I have the rights and consent to train this likeness. The stills show one person or fictional character.</span>
            </label>
          )}
          <p className="gx-hint" data-testid="soul-terms">Charged once the trainer accepts it, even if training then fails.</p>
          <div className="gx-gen-enhance">
            <button type="button" className="gx-primary pd-go" disabled={Boolean(blocked) || busy} aria-describedby={blocked ? "soul-blocked" : undefined} onClick={() => void train()} data-testid="soul-build">
              {busy ? "Sending…" : price && version ? `${consent ? "Train Identity" : "Build identity"} · ${price}` : consent ? "Train Identity" : "Build identity"}
            </button>
            {blocked ? <span className="gx-reason" id="soul-blocked" data-testid="soul-blocked">{blocked}</span> : null}
          </div>
        </>
      )}
      {outcome ? <p className={outcome.error ? "gx-gen-error" : "gx-gen-note"} role="status" data-testid="soul-outcome">{outcome.text}</p> : null}
      <div className="gx-gen-row" data-testid="soul-list">
        <span className="gx-eyebrow" data-functional-label="">In this workspace</span>
        {!data ? <p className="gx-hint">{state.status === "error" ? <>{state.error ?? "This workspace’s identities could not be read."} <button type="button" className="gx-hbtn" onClick={() => void refresh()}>Try again</button></> : "Reading…"}</p>
          : !identities.length ? <p className="gx-hint">No identity in this workspace yet.</p>
          : (
            <ul className="gx-soul-list">
              {identities.map((identity) => (
                <li key={identity.id} className="gx-soul-row" data-testid={`soul-row-${identity.id}`}>
                  <span className="gx-soul-name">{identity.name}</span>
                  <span className="gx-hint">{familyOf(identity)} · {STATUS[identity.status]}{identity.creditsBilled != null ? ` · ${identity.creditsBilled.toLocaleString("en-US")} cr` : ""}</span>
                  {identity.error ? <span className="gx-hint pd-soul-error">{identity.error}</span> : null}
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  );
}
