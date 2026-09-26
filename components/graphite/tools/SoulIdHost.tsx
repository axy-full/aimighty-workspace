"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { CONNECTED_GENERATION_ENDPOINT } from "@/lib/higgsfield-consumer/generation-client";
import type { ConnectedCharacter, ConnectedPlan, SoulBuildOutcome, SoulBuildType } from "@/lib/higgsfield-consumer/soul-build";
import { SOUL_BUILD_STILLS, SOUL_BUILD_TYPES, soulBuildBlock } from "@/lib/higgsfield-consumer/soul-build";
import { sendGenPreset } from "@/lib/shell/gen-preset";
import { useShell } from "@/lib/shell/state";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";

const TYPE_LABEL: Record<SoulBuildType, string> = { soul_2: "Soul 2", soul_cinematic: "Soul Cinematic" };
/* The connected catalogue lists Soul 2 as `soul_2` (the CLI's text2image_soul_v2 is not a catalogue id). */
const SOUL_MODEL: Record<SoulBuildType, string> = { soul_2: "soul_2", soul_cinematic: "soul_cinematic" };
const STATUS: Record<NonNullable<ConnectedCharacter["status"]>, string> = { ready: "Ready", training: "Training", failed: "Failed" };

/**
 * Studio › Cast › Build identity on the connected account (FINAL_SPEC §3 ›
 * Soul ID): name it, choose Soul 2 or Soul Cinematic, pick 5–20 stills of the
 * same person from this project, pass the plan gate, and the account trains
 * one Soul ID that Gen's Soul models then carry as `soul_id`. Only Soul IDs
 * Particl built are listed — the account is the engine, not a library. Training is
 * billed by the account at its plan's rate — it offers no cost tool for it —
 * so the card says so before the button, and the button never spends twice.
 */
export function SoulIdHost({ scope, items, projectId }: { scope: string; items: LibraryEntry[]; projectId: string | null }) {
  const shell = useShell();
  const ws = useWorkspace();
  const scoped = useScopedFetch(scope);
  const [name, setName] = useState("");
  const [type, setType] = useState<SoulBuildType>("soul_2");
  const [picked, setPicked] = useState<string[]>([]);
  const [plan, setPlan] = useState<ConnectedPlan | null>(null);
  const [characters, setCharacters] = useState<{ connected: boolean; available: boolean; characters: ConnectedCharacter[] } | null>(null);
  const [phase, setPhase] = useState<"idle" | "confirm" | "building">("idle");
  const [outcome, setOutcome] = useState<SoulBuildOutcome | { state: "error"; reason: string } | null>(null);

  const call = useCallback(async <T,>(body: Record<string, unknown>): Promise<T> => {
    const response = await scoped(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok || !json) throw new Error(json?.error ?? "The account could not be read.");
    return json;
  }, [scoped]);
  const refresh = useCallback(() => {
    void call<{ plan: ConnectedPlan }>({ action: "characters-plan" }).then((r) => setPlan(r.plan)).catch(() => setPlan({ connected: false, available: false, plan: null, paid: null }));
    void call<{ connected: boolean; available: boolean; characters: ConnectedCharacter[] }>({ action: "characters" }).then(setCharacters).catch(() => setCharacters({ connected: false, available: false, characters: [] }));
  }, [call]);
  useEffect(() => { refresh(); }, [refresh]);
  /* Training takes minutes and the account has no wait tool: read the list again while any identity trains. */
  const training = Boolean(characters?.characters.some((c) => c.status === "training"));
  useEffect(() => {
    if (!training) return;
    const timer = setInterval(() => void call<{ connected: boolean; available: boolean; characters: ConnectedCharacter[] }>({ action: "characters" }).then(setCharacters).catch(() => undefined), 30_000);
    return () => clearInterval(timer);
  }, [training, call]);

  /* Stills of this project: images only, uploads and finished renders alike. */
  const stills = useMemo(() => items.filter((e) => e.media === "image" && e.url), [items]);
  const connected = plan?.connected ?? characters?.connected ?? false;
  const blocked = soulBuildBlock({ name, stills: picked.length, plan, connected });
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= SOUL_BUILD_STILLS.max ? p : [...p, id]));

  const build = async () => {
    setPhase("building"); setOutcome(null);
    try {
      const sources = picked.map((id) => { const e = stills.find((s) => s.take.id === id)!; return e.asset.origin === "upload" ? { uploadId: e.take.sourceId } : { genId: e.take.sourceId }; });
      const { build } = await call<{ build: SoulBuildOutcome }>({ action: "characters-create", name: name.trim(), type, sources, ...(projectId ? { projectId } : {}) });
      setOutcome(build);
      if (build.state !== "refused") { ws.toast(build.state === "training" ? `${build.character.name} is training on the account` : "The account accepted the training request"); refresh(); }
    } catch (error) {
      setOutcome({ state: "error", reason: error instanceof Error ? error.message : "The training request could not be sent." });
    } finally { setPhase("idle"); }
  };
  const openInGen = (character: ConnectedCharacter) => {
    /* The Soul models are on the account's catalogue: Gen switches to it, then to the model, with this identity chosen. */
    sendGenPreset({ prompt: "", type: "image", billing: "connected", model: SOUL_MODEL[character.type === "soul_cinematic" ? "soul_cinematic" : "soul_2"], soulId: character.soulId, note: `Soul ID · ${character.name}` });
    shell.goGen();
  };

  return (
    <section className="gx-gen-card gx-workflow" aria-label="Build identity" data-testid="soul-card">
      <div className="gx-gen-row">
        <span className="gx-eyebrow" data-functional-label="">Connected account · Soul ID</span>
        <h2 className="gx-workflow-title">Build identity</h2>
        <p className="gx-hint">Five to twenty stills of the same person become a Soul ID on the connected account; Gen’s Soul 2 and Soul Cinematic models then render with it.</p>
      </div>
      <div className="gx-gen-row">
        <label className="gx-eyebrow" htmlFor="soul-name" data-functional-label="">Name</label>
        <input id="soul-name" className="gx-field" placeholder="Mira" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="soul-name" />
      </div>
      <div className="gx-gen-row">
        <span className="gx-eyebrow" data-functional-label="">Type</span>
        <div className="gx-seg gx-seg--sm" role="tablist" aria-label="Soul type">
          {SOUL_BUILD_TYPES.map((t) => <button key={t} type="button" role="tab" className="gx-seg-btn" aria-selected={type === t} onClick={() => setType(t)} data-testid={`soul-type-${t}`}><span>{TYPE_LABEL[t]}</span></button>)}
        </div>
      </div>
      <div className="gx-gen-row">
        <span className="gx-eyebrow" data-functional-label="">Stills<span className="bz-note"> · {picked.length} of {SOUL_BUILD_STILLS.min}–{SOUL_BUILD_STILLS.max} · the same person, varied angles and light</span></span>
        {stills.length ? (
          <div className="gx-soul-grid" role="group" aria-label="Stills" data-testid="soul-stills">
            {stills.map((e) => (
              <button key={e.take.id} type="button" className="gx-soul-still" aria-pressed={picked.includes(e.take.id)} title={e.take.name} onClick={() => toggle(e.take.id)} data-testid={`soul-still-${e.take.sourceId}`}>
                <LazyMedia url={e.url!} kind="image" alt="" name={e.take.name} className="gx-lazy" />
                {picked.includes(e.take.id) ? <span className="gx-badge gx-badge--new">{picked.indexOf(e.take.id) + 1}</span> : null}
              </button>
            ))}
          </div>
        ) : <p className="gx-empty">No stills in this project yet. Upload or render some first.</p>}
      </div>
      <div className="gx-gen-row" data-testid="soul-plan">
        <span className="gx-eyebrow" data-functional-label="">Plan gate</span>
        <p className="gx-hint">
          {plan == null ? "Reading the account’s plan…" : !plan.connected ? "Connect the account in Workspace › Engines." : !plan.available ? "The account does not report its plan through its tools; it decides at training time." : `The account reads as ${plan.plan ?? "an unnamed plan"}${plan.paid === false ? " — training needs a paid plan" : plan.paid ? " — a paid plan" : ""}.`}
          {" "}Training is billed by the connected account at its plan’s rate; the account offers no quote for it.
        </p>
      </div>
      <div className="gx-gen-enhance">
        {phase === "confirm" ? (
          <>
            <button type="button" className="gx-primary" onClick={() => void build()} data-testid="soul-build-confirm">Train {name.trim()} · {TYPE_LABEL[type]} · {picked.length} stills</button>
            <button type="button" className="gx-hbtn" onClick={() => setPhase("idle")}>Not now</button>
          </>
        ) : (
          <button type="button" className="gx-primary" disabled={Boolean(blocked) || phase === "building"} aria-describedby={blocked ? "soul-blocked" : undefined} onClick={() => setPhase("confirm")} data-testid="soul-build">{phase === "building" ? "Sending to the account…" : "Build identity · billed by the account"}</button>
        )}
        {blocked ? <span className="gx-reason" id="soul-blocked" data-testid="soul-blocked">{blocked}</span> : null}
      </div>
      {outcome ? (
        <p className={outcome.state === "refused" || outcome.state === "error" ? "gx-gen-error" : "gx-gen-note"} role="status" data-testid="soul-outcome">
          {outcome.state === "training" ? `${outcome.character.name} · ${outcome.character.type ? TYPE_LABEL[outcome.character.type === "soul_cinematic" ? "soul_cinematic" : "soul_2"] : type} · ${outcome.character.status ? STATUS[outcome.character.status] : "accepted"} · soul_id ${outcome.character.soulId}`
            : outcome.state === "accepted" ? "The account accepted the request without naming the new Soul ID yet; it appears below once it lists it."
            : outcome.state === "refused" ? `The account refused: ${outcome.reason}` : outcome.reason}
        </p>
      ) : null}
      <div className="gx-gen-row" data-testid="soul-list">
        <span className="gx-eyebrow" data-functional-label="">Built in Particl</span>
        {characters == null ? <p className="gx-hint">Reading…</p>
          : !characters.connected ? <p className="gx-hint">Connect the account in Workspace › Engines.</p>
          : !characters.available ? <p className="gx-hint">The account does not list its characters through its tools.</p>
          : !characters.characters.length ? <p className="gx-hint">No Soul ID built in Particl yet. Identities trained on higgsfield.ai stay there; Particl lists only the ones it built.</p>
          : (
            <ul className="gx-soul-list">
              {characters.characters.map((c) => (
                <li key={c.soulId} className="gx-soul-row" data-testid={`soul-row-${c.soulId}`}>
                  <span className="gx-soul-name">{c.name}</span>
                  <span className="gx-hint">{c.type ? TYPE_LABEL[c.type === "soul_cinematic" ? "soul_cinematic" : "soul_2"] : "Soul"} · {c.status ? STATUS[c.status] : "unknown"}</span>
                  <span className="gx-spacer" />
                  <button type="button" className="gx-hbtn" disabled={c.status !== "ready"} title={c.status !== "ready" ? "Ready identities only." : undefined} onClick={() => openInGen(c)}>Use in Gen</button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  );
}
