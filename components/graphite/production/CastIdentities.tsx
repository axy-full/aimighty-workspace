"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { trainApproval, trainPrice, type TrainTerms } from "@/lib/identityTraining";
import { usePaidAction } from "@/lib/usePaidAction";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { SoulIdentity } from "@/lib/workbench/soul-identity";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";

const ENDPOINT = "/api/identities";
/** The one request this card pays for: the trainer's own route for an identity made here. */
const TRAIN_URL = /^\/api\/identities\/[A-Za-z0-9_-]{1,100}\/train$/;

/** An identity built in this workspace, as GET /api/identities answers (lib/identities.ts › identityForBrowser). */
export type BuiltIdentity = {
  id: string; name: string; status: "draft" | "training" | "ready" | "failed";
  error: string | null; creditsBilled?: number | null; costUsd?: number | null;
};
type Terms = TrainTerms & { maxPhotos?: number };
const STATUS: Record<BuiltIdentity["status"], string> = { draft: "Not trained", training: "Training", ready: "Ready", failed: "Failed" };

/**
 * The training price as the workspace pays it, from the route's own terms
 * (credits on the platform's keys, its vendor's dollars on its own); null
 * until the terms say one. Never a figure written here.
 */
export function buildPrice(terms: TrainTerms | null | undefined): { text: string; amount: number; inCredits: boolean } | null {
  const inCredits = typeof terms?.trainCredits === "number";
  const amount = trainPrice(terms, inCredits);
  if (amount == null) return null;
  return { amount, inCredits, text: inCredits ? `${amount.toLocaleString("en-US")} cr` : `$${amount.toFixed(2)}` };
}

/**
 * This workspace's identities and the trainer's live terms (GET
 * /api/identities). Read once, again on `refresh`, and every 30 s while one
 * is training — the read is what asks the trainer how a run is going, and a
 * run takes tens of minutes.
 */
export function useBuiltIdentities(scope: string) {
  const scoped = useScopedFetch(scope);
  const [state, setState] = useState<{ identities: BuiltIdentity[] | null; terms: Terms | null; error: string | null }>({ identities: null, terms: null, error: null });
  const [read, setRead] = useState(0);
  const refresh = useCallback(() => setRead((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    void scoped(ENDPOINT, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { identities?: BuiltIdentity[]; terms?: Terms; error?: string } | null;
        if (!response.ok || !Array.isArray(body?.identities) || !body.terms) throw new Error(body?.error || "Identities could not be loaded.");
        if (live) setState({ identities: body.identities, terms: body.terms, error: null });
      })
      .catch((error: unknown) => { if (live) setState((was) => ({ ...was, error: error instanceof Error ? error.message : "Identities could not be loaded." })); });
    return () => { live = false; };
  }, [scoped, read]);
  const training = Boolean(state.identities?.some((i) => i.status === "training"));
  useEffect(() => {
    if (!training) return;
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [training, refresh]);
  return { ...state, refresh };
}
export type BuiltIdentities = ReturnType<typeof useBuiltIdentities>;

/**
 * Studio › Cast › Build identity: name it, pick 5–40 uploaded photos of the
 * same person from this project, confirm the rights, and it trains in this
 * workspace at the trainer's price, shown on the button before anything is
 * sent (POST /api/identities, then its /train with that price as the
 * approval). A lost reply is recovered by its saved request, never sent
 * twice. Identities made on the earlier stills engines stay listed,
 * read-only.
 */
export function CastIdentities({ scope, projectId, items, save, built, earlier, seed }: {
  scope: string; projectId: string; items: LibraryEntry[]; save: () => Promise<boolean>;
  built: BuiltIdentities;
  /** Identities trained earlier on the stills engines no longer offered: listed, never rendered or retrained here. */
  earlier: readonly SoulIdentity[];
  /** A character's "Build identity" pressed above: its name lands in the field. */
  seed?: { name: string; n: number } | null;
}) {
  const { toast } = useWorkspace();
  const scoped = useScopedFetch(scope);
  const paid = usePaidAction(`identity-build:${projectId}`, true, { signedIn: true, requestScope: scope });
  const [name, setName] = useState("");
  const [seeded, setSeeded] = useState(0);
  if (seed && seed.n !== seeded) { setSeeded(seed.n); setName(seed.name.slice(0, 100)); }
  const [picked, setPicked] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ error: boolean; text: string } | null>(null);

  const { terms, identities } = built;
  const price = buildPrice(terms);
  const min = terms?.minPhotos ?? 5, max = terms?.maxPhotos ?? 40;
  /* The trainer reads uploads: the originals, byte for byte. A generated still is not one. */
  const photos = useMemo(() => items.filter((e) => e.media === "image" && e.url && e.asset.origin === "upload"), [items]);
  const toggle = (id: string) => setPicked((all) => (all.includes(id) ? all.filter((x) => x !== id) : all.length >= max ? all : [...all, id]));
  const recovered = paid.pending?.context && typeof paid.pending.context.name === "string" ? paid.pending.context.name : null;

  const blocked = !terms ? built.error ?? "Reading this workspace’s identities…"
    : !terms.configured ? "Identity training is not set up on this platform yet."
    : !price ? "Identity training has no price yet."
    : !name.trim() ? "Name the identity."
    : picked.length < min || picked.length > max ? `Pick ${min}–${max} uploaded photos of the same person (${picked.length} picked).`
    : !consent ? "Confirm you have the rights and consent to train this likeness."
    : null;

  const train = async () => {
    if (busy) return;
    setBusy(true); setOutcome(null);
    try {
      let url: string, body: Record<string, unknown>, called = name.trim();
      if (paid.pending) {
        url = paid.pending.url; body = JSON.parse(paid.pending.body);
        if (!TRAIN_URL.test(url)) throw new Error("Return to where this request was started to recover it.");
        called = recovered ?? "The identity";
      } else {
        if (blocked || !price) throw new Error(blocked ?? "Identity training has no price yet.");
        if (!(await save())) throw new Error("Save the project before building an identity.");
        const uploads = picked.flatMap((id) => { const e = photos.find((p) => p.take.id === id); return e ? [e.take.sourceId] : []; });
        /* The identity first (free), then its training (paid). A training refused earlier left its draft: the same name takes it up again. */
        const made = await scoped(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: called, description: "", photos: uploads, projectId: null, reuseDraft: true }) });
        const reply = await made.json().catch(() => null) as { identity?: { id?: string }; error?: string } | null;
        if (!made.ok || typeof reply?.identity?.id !== "string") throw new Error(reply?.error ?? "The identity could not be made. Nothing was charged.");
        url = `${ENDPOINT}/${encodeURIComponent(reply.identity.id)}/train`;
        /* The price on the button is the price approved: the route refuses a run that now costs more. */
        body = { consent: true, ...trainApproval(price.amount, price.inCredits) };
      }
      await paid.run<{ identity: BuiltIdentity }>(url, body, { context: { name: called } });
      setOutcome({ error: false, text: `${called} is training. It is listed below.` });
      toast(`${called} is training`);
      setName(""); setPicked([]); setConsent(false);
    } catch (error) {
      /* A dropped connection is not a refusal: the request is saved, and Recover asks about it. */
      setOutcome({ error: true, text: error instanceof TypeError ? "The reply was lost. Recover the saved request; it is never sent twice."
        : error instanceof Error ? error.message : "The training request could not be confirmed. Recover the saved request." });
    } finally {
      setBusy(false);
      built.refresh();
    }
  };

  return (
    <section className="gx-gen-card gx-workflow" aria-label="Build identity" data-testid="soul-card" data-section="soul">
      <div className="gx-gen-row">
        <span className="gx-eyebrow" data-functional-label="">Identity · on this workspace’s credits</span>
        <h2 className="gx-workflow-title">Build identity</h2>
      </div>
      {paid.error ? <p className="gx-gen-error" role="alert">{paid.error}</p> : null}
      {paid.pending ? (
        <div className="gx-gen-row pd-recover" data-testid="soul-recover">
          <p className="gx-hint">A training request was sent but its reply was lost: {recovered ?? "an identity"}. Recovering asks about that same request; it is never sent twice.</p>
          <button type="button" className="gx-primary" disabled={busy} onClick={() => void train()} data-testid="soul-recover-run">{busy ? "Checking…" : "Recover the training request"}</button>
        </div>
      ) : (
        <>
          <div className="gx-gen-row">
            <label className="gx-eyebrow" htmlFor="soul-name" data-functional-label="">Name</label>
            <input id="soul-name" className="gx-field" placeholder="Character name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} data-testid="soul-name" />
          </div>
          <div className="gx-gen-row">
            <span className="gx-eyebrow" data-functional-label="">Photos<span className="bz-note"> · {picked.length} of {min}–{max} · uploads of the same person, varied angles and light</span></span>
            {photos.length ? (
              <div className="gx-soul-grid" role="group" aria-label="Photos" data-testid="soul-stills">
                {photos.map((e) => (
                  <button key={e.take.id} type="button" className="gx-soul-still" aria-pressed={picked.includes(e.take.id)} aria-label={`Use ${e.take.name}`} onClick={() => toggle(e.take.id)} data-testid={`soul-still-${e.take.sourceId}`}>
                    <LazyMedia url={e.url!} kind="image" alt="" name={e.take.name} className="gx-lazy" />
                    {picked.includes(e.take.id) ? <span className="gx-badge gx-badge--new">{picked.indexOf(e.take.id) + 1}</span> : null}
                  </button>
                ))}
              </div>
            ) : <p className="gx-empty">No uploaded photos in this project yet. Upload {min} or more of the same person.</p>}
          </div>
          <label className="pd-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="soul-consent" />
            <span className="pd-check" aria-hidden="true" />
            <span className="gx-hint">I have the rights and consent to train this likeness. The photos show one person or fictional character.</span>
          </label>
          <div className="gx-gen-enhance">
            <button type="button" className="gx-primary pd-go" disabled={Boolean(blocked) || busy} aria-describedby={blocked ? "soul-blocked" : undefined} onClick={() => void train()} data-testid="soul-build">
              {busy ? "Sending…" : price ? `Build identity · ${price.text}` : "Build identity"}
            </button>
            {blocked ? <span className="gx-reason" id="soul-blocked" data-testid="soul-blocked">{blocked}</span> : null}
          </div>
        </>
      )}
      {outcome ? <p className={outcome.error ? "gx-gen-error" : "gx-gen-note"} role="status" data-testid="soul-outcome">{outcome.text}</p> : null}
      <div className="gx-gen-row" data-testid="soul-list">
        <span className="gx-eyebrow" data-functional-label="">In this workspace</span>
        {!identities ? <p className="gx-hint">{built.error ? <>{built.error} <button type="button" className="gx-hbtn" onClick={built.refresh}>Try again</button></> : "Reading…"}</p>
          : !identities.length && !earlier.length ? <p className="gx-hint">No identity in this workspace yet.</p>
          : (
            <ul className="gx-soul-list">
              {identities.map((identity) => (
                <li key={identity.id} className="gx-soul-row" data-testid={`soul-row-${identity.id}`}>
                  <span className="gx-soul-name">{identity.name}</span>
                  <span className="gx-hint">{STATUS[identity.status]}{identity.creditsBilled != null ? ` · ${identity.creditsBilled.toLocaleString("en-US")} cr` : ""}</span>
                  {identity.error ? <span className="gx-hint pd-soul-error">{identity.error}</span> : null}
                </li>
              ))}
              {earlier.map((identity) => (
                <li key={identity.id} className="gx-soul-row" data-testid={`soul-row-${identity.id}`} data-readonly="">
                  <span className="gx-soul-name">{identity.name}</span>
                  <span className="gx-hint">Earlier identity · read-only{identity.creditsBilled != null ? ` · ${identity.creditsBilled.toLocaleString("en-US")} cr` : ""}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  );
}
