"use client";

import { useState, type ReactNode } from "react";
import { CATEGORIES } from "@/lib/studio";
import { MODELS } from "@/lib/models";
import { TEXT_JOBS, TEXT_JOB_LABELS, TEXT_MODEL_IDS, textModelFor, RULE_SCOPES, RULE_SCOPE_LABELS } from "@/lib/platformLayer";
import { Button, Chip, Mono, Sheet, Switch } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { FIELD, FIELD_LABEL, TextAction } from "./Card";
import { call } from "./api";
import type { Layer, LayerView } from "./types";

/**
 * The per-key editor behind `Edit the defaults` (SOW surfaces board 12h):
 * the v1 platform-layer card — the default Setup, the starter production,
 * the rules, the default engines, the default caps (now with the cycle's
 * grant budget beside them), the camera bank as it reads — in a Sheet on
 * v2 controls, with the same GET/PATCH contract: one key at a time,
 * `Save` keeps the desk's version, `Default` puts the code's back.
 * Every Save is a secondary; the desk has one primary and it is not here.
 */
type Key = keyof Layer;

export default function DefaultsSheet({ open, onClose, view, refresh }: { open: boolean; onClose: () => void; view: LayerView; refresh: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Layer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showBank, setShowBank] = useState(false);
  const layer = draft ?? view.layer;
  const stored = new Set(view.stored);
  const set = (patch: Partial<Layer>) => setDraft({ ...(draft ?? view.layer), ...patch });

  async function save(key: Key, reset = false) {
    setBusy(`${key}${reset ? ":reset" : ""}`);
    try {
      await call("/api/admin/platform-layer", "PATCH", reset ? { key, reset: true } : { key, value: layer[key] });
      toast(reset ? `${TITLES[key]} back to the default` : `${TITLES[key]} saved`);
      setDraft(null); refresh();
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  }
  const head = (key: Key, title: string) => (
    <span className="flex flex-wrap items-center gap-[10px]">
      <span className="text-[16px] font-semibold leading-none text-ink">{title}</span>
      {stored.has(key) && <Mono cost>overridden</Mono>}
      <span className="ml-auto flex items-center gap-[8px]">
        <Button variant="secondary" placement="desk" muted disabled={busy != null} busy={busy === `${key}:reset`} busyLabel="Restoring" onClick={() => save(key, true)}>Default</Button>
        <Button variant="secondary" placement="desk" disabled={busy != null} busy={busy === key} busyLabel="Saving" onClick={() => save(key)}>Save</Button>
      </span>
    </span>
  );
  const shots = layer.starter.shots;
  const num = (v: string) => (v === "" ? null : Number(v));

  return (
    <Sheet open={open} onClose={onClose} label="Edit the defaults" size="full" top={44} title="Edit the defaults" context="What every new studio starts with" bodyClassName="gap-[24px] pb-[40px]">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-[24px]">
        <Block>
          {head("setup", "Default Setup")}
          <div className="grid grid-cols-4 gap-x-[16px] gap-y-[10px] max-md:grid-cols-1">
            {CATEGORIES.map((c) => (
              <label key={c.key} className={FIELD_LABEL}>{c.label}
                <select className={FIELD} value={layer.setup[c.key] ?? ""} onChange={(e) => { const next = { ...layer.setup }; if (e.target.value) next[c.key] = e.target.value; else delete next[c.key]; set({ setup: next }); }}>
                  <option value="">—</option>
                  {c.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            ))}
          </div>
        </Block>

        <Block>
          {head("starter", "Starter production")}
          <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-[10px] max-md:grid-cols-1">
            <label className={FIELD_LABEL}>Name<input className={FIELD} value={layer.starter.name} onChange={(e) => set({ starter: { ...layer.starter, name: e.target.value } })} /></label>
            <label className={FIELD_LABEL}>Code<input className={FIELD} value={layer.starter.code} onChange={(e) => set({ starter: { ...layer.starter, code: e.target.value } })} /></label>
          </div>
          <label className={FIELD_LABEL}>Description<input className={FIELD} value={layer.starter.description} onChange={(e) => set({ starter: { ...layer.starter, description: e.target.value } })} /></label>
          {shots.map((s, i) => (
            <div key={i} className="grid grid-cols-[100px_minmax(0,1fr)_90px_auto] gap-[10px] rounded-tile border border-border bg-ground p-[10px] max-md:grid-cols-1">
              <label className={FIELD_LABEL}>Shot<input className={FIELD} value={s.code} onChange={(e) => set({ starter: { ...layer.starter, shots: shots.map((x, j) => j === i ? { ...x, code: e.target.value } : x) } })} /></label>
              <label className={FIELD_LABEL}>Title<input className={FIELD} value={s.title} onChange={(e) => set({ starter: { ...layer.starter, shots: shots.map((x, j) => j === i ? { ...x, title: e.target.value } : x) } })} /></label>
              <label className={FIELD_LABEL}>Seconds<input className={FIELD} type="number" min={1} max={60} value={s.planned} onChange={(e) => set({ starter: { ...layer.starter, shots: shots.map((x, j) => j === i ? { ...x, planned: Number(e.target.value) } : x) } })} /></label>
              <span className="flex items-end"><TextAction onClick={() => set({ starter: { ...layer.starter, shots: shots.filter((_, j) => j !== i) } })} className="h-[36px] max-md:h-[44px]">Remove</TextAction></span>
              <label className={`${FIELD_LABEL} col-span-4 max-md:col-span-1`}>What happens<textarea className={`${FIELD} h-[64px] py-[8px] leading-[1.4] max-md:h-[72px]`} value={s.description} onChange={(e) => set({ starter: { ...layer.starter, shots: shots.map((x, j) => j === i ? { ...x, description: e.target.value } : x) } })} /></label>
            </div>
          ))}
          <span className="flex flex-wrap gap-[8px]">
            <Chip variant="dashed" onClick={() => set({ starter: { ...layer.starter, shots: [...shots, { code: `SH0${(shots.length + 1) * 10}`, title: "", description: "", planned: 5, setup: {}, cast: [] }] } })}>+ Shot</Chip>
            <Chip variant="dashed" onClick={() => set({ starter: { ...layer.starter, cast: [...layer.starter.cast, { name: "", kind: "character", description: "" }] } })}>+ Cast</Chip>
          </span>
          {layer.starter.cast.map((c, i) => (
            <div key={i} className="grid grid-cols-[160px_140px_minmax(0,1fr)_auto] gap-[10px] max-md:grid-cols-1">
              <label className={FIELD_LABEL}>Cast<input className={FIELD} value={c.name} onChange={(e) => set({ starter: { ...layer.starter, cast: layer.starter.cast.map((x, j) => j === i ? { ...x, name: e.target.value } : x) } })} /></label>
              <label className={FIELD_LABEL}>Kind
                <select className={FIELD} value={c.kind} onChange={(e) => set({ starter: { ...layer.starter, cast: layer.starter.cast.map((x, j) => j === i ? { ...x, kind: e.target.value as Layer["starter"]["cast"][number]["kind"] } : x) } })}>
                  {["character", "location", "prop", "style"].map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <label className={FIELD_LABEL}>Description<input className={FIELD} value={c.description} onChange={(e) => set({ starter: { ...layer.starter, cast: layer.starter.cast.map((x, j) => j === i ? { ...x, description: e.target.value } : x) } })} /></label>
              <span className="flex items-end"><TextAction onClick={() => set({ starter: { ...layer.starter, cast: layer.starter.cast.filter((_, j) => j !== i) } })} className="h-[36px] max-md:h-[44px]">Remove</TextAction></span>
            </div>
          ))}
        </Block>

        <Block>
          {head("rules", "Rules")}
          <span className="text-[13px] leading-[1.4] text-ink-body">A rule for the writer steers the prompt writer; a rule for the prompt is appended in scope. Every workspace inherits these.</span>
          {layer.rules.map((r, i) => (
            <div key={r.id} className="grid grid-cols-[auto_130px_140px_minmax(0,1fr)_auto] items-end gap-[10px] max-md:grid-cols-[auto_minmax(0,1fr)_auto]">
              <span className="flex h-[36px] items-center max-md:h-[44px]"><Switch on={r.on} label={`Rule ${i + 1} on`} onChange={(v) => set({ rules: layer.rules.map((x, j) => j === i ? { ...x, on: v } : x) })} /></span>
              <label className={`${FIELD_LABEL} max-md:col-span-2`}>Scope
                <select className={FIELD} value={r.scope} onChange={(e) => set({ rules: layer.rules.map((x, j) => j === i ? { ...x, scope: e.target.value } : x) })}>
                  {RULE_SCOPES.map((s) => <option key={s} value={s}>{RULE_SCOPE_LABELS[s]}</option>)}
                </select>
              </label>
              <label className={`${FIELD_LABEL} max-md:col-span-3`}>Applies
                <select className={FIELD} value={r.apply} onChange={(e) => set({ rules: layer.rules.map((x, j) => j === i ? { ...x, apply: e.target.value as Layer["rules"][number]["apply"] } : x) })}>
                  <option value="writer">for the writer</option><option value="prompt">in the prompt</option>
                </select>
              </label>
              <label className={`${FIELD_LABEL} max-md:col-span-2`}>Rule<input className={FIELD} value={r.text} onChange={(e) => set({ rules: layer.rules.map((x, j) => j === i ? { ...x, text: e.target.value } : x) })} /></label>
              <TextAction onClick={() => set({ rules: layer.rules.filter((_, j) => j !== i) })} className="h-[36px] max-md:h-[44px]">Remove</TextAction>
            </div>
          ))}
          <span><Chip variant="dashed" onClick={() => set({ rules: [...layer.rules, { id: `rule-${Date.now().toString(36)}`, text: "", scope: "all", apply: "writer", on: true }] })}>+ Rule</Chip></span>
        </Block>

        <Block>
          {head("models", "Default engines")}
          <div className="grid grid-cols-3 gap-[10px] max-md:grid-cols-1">
            <label className={FIELD_LABEL}>Video
              <select className={FIELD} value={layer.models.video} onChange={(e) => set({ models: { ...layer.models, video: e.target.value } })}>
                {MODELS.filter((m) => m.kind === "video" && !m.hidden).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <label className={FIELD_LABEL}>Stills
              <select className={FIELD} value={layer.models.image} onChange={(e) => set({ models: { ...layer.models, image: e.target.value } })}>
                {MODELS.filter((m) => m.kind === "image" && !m.hidden).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            {TEXT_JOBS.map((job) => (
              <label key={job} className={FIELD_LABEL}>{TEXT_JOB_LABELS[job]}
                <select className={FIELD} value={textModelFor(layer.models, job)} onChange={(e) => set({ models: { ...layer.models, text: { ...(layer.models.text ?? {}), [job]: e.target.value } } })}>
                  {TEXT_MODEL_IDS.map((id) => <option key={id} value={id}>{id.split("/").pop()}</option>)}
                </select>
              </label>
            ))}
          </div>
        </Block>

        <Block>
          {head("caps", "Default caps")}
          <div className="grid grid-cols-3 gap-[10px] max-md:grid-cols-1">
            <label className={FIELD_LABEL}>Welcome credits (blank = the deployment&rsquo;s)<input className={FIELD} type="number" min={0} value={layer.caps.signupCredits ?? ""} onChange={(e) => set({ caps: { ...layer.caps, signupCredits: num(e.target.value) } })} /></label>
            <label className={FIELD_LABEL}>Grant budget a cycle, USD (blank = none)<input className={FIELD} type="number" min={0} value={layer.caps.grantBudgetUsd ?? ""} onChange={(e) => set({ caps: { ...layer.caps, grantBudgetUsd: num(e.target.value) } })} /></label>
            <label className={FIELD_LABEL}>A new production&rsquo;s cap, credits (blank = none)<input className={FIELD} type="number" min={0} value={layer.caps.defaultCapCredits ?? ""} onChange={(e) => set({ caps: { ...layer.caps, defaultCapCredits: num(e.target.value) } })} /></label>
            <label className={FIELD_LABEL}>Warn the producer at, % of cap<input className={FIELD} type="number" min={1} max={100} value={layer.caps.warnPct} onChange={(e) => set({ caps: { ...layer.caps, warnPct: Number(e.target.value) } })} /></label>
            <label className={FIELD_LABEL}>Renders at once<input className={FIELD} type="number" min={1} max={100} value={layer.caps.concurrency} onChange={(e) => set({ caps: { ...layer.caps, concurrency: Number(e.target.value) } })} /></label>
            <label className={FIELD_LABEL}>Renders an hour<input className={FIELD} type="number" min={1} max={10000} value={layer.caps.rendersPerHour} onChange={(e) => set({ caps: { ...layer.caps, rendersPerHour: Number(e.target.value) } })} /></label>
            <label className={FIELD_LABEL}>Storage kept, GB<input className={FIELD} type="number" min={1} max={100000} value={layer.caps.storageGb} onChange={(e) => set({ caps: { ...layer.caps, storageGb: Number(e.target.value) } })} /></label>
          </div>
        </Block>

        <Block>
          <span className="flex items-center gap-[10px]">
            <span className="text-[16px] font-semibold leading-none text-ink">Camera bank</span>
            <Mono cost>{view.cameraBank.length} modules · as the compiler writes them</Mono>
            <TextAction onClick={() => setShowBank((v) => !v)} className="ml-auto">{showBank ? "Hide" : "Show"}</TextAction>
          </span>
          {showBank && (
            <div className="flex flex-col gap-[6px]">
              {view.cameraBank.map((m) => (
                <div key={`${m.kind}/${m.value}`} className="flex flex-col gap-[4px] rounded-tile border border-border bg-ground px-[12px] py-[8px] text-[13px] leading-[1.4]">
                  <span className="flex items-center gap-[8px]"><span className="font-medium text-ink">{m.label}</span><Mono cost>{m.kind}</Mono></span>
                  <span className="text-ink-body">{m.module || "—"}</span>
                </div>
              ))}
            </div>
          )}
        </Block>
      </div>
    </Sheet>
  );
}

const TITLES: Record<Key, string> = { setup: "Default Setup", starter: "Starter production", rules: "Rules", caps: "Default caps", models: "Default engines" };

function Block({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-[12px] rounded-card border border-border bg-card px-[20px] py-[18px] max-md:px-[14px]">{children}</div>;
}
