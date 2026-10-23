"use client";
import { useState } from "react";
import type { LayerKey } from "@/lib/platformLayer";
import { DEFAULT_CAPS, type PlatformCaps } from "@/lib/platformCaps";
import { useToast } from "../ui";
import { adminSend, useAdminRead } from "./api";
import { Head } from "./parts";

type Layer = { layer: { caps: PlatformCaps }; stored: LayerKey[] };
type Draft = Record<keyof PlatformCaps, string>;
const toDraft = (c: PlatformCaps): Draft => ({
  signupCredits: c.signupCredits == null ? "" : String(c.signupCredits), defaultCapCredits: c.defaultCapCredits == null ? "" : String(c.defaultCapCredits),
  warnPct: String(c.warnPct), concurrency: String(c.concurrency), rendersPerHour: String(c.rendersPerHour), storageGb: String(c.storageGb),
});
const FIELDS: { key: keyof PlatformCaps; name: string; unit: string; hint: string; blank?: string }[] = [
  { key: "signupCredits", name: "Welcome credits", unit: "cr", hint: "Given once when a workspace is created. Blank follows the deployment.", blank: "default" },
  { key: "defaultCapCredits", name: "New board cap", unit: "cr", hint: "The spend ceiling a new board starts with. Blank is none.", blank: "none" },
  { key: "warnPct", name: "Warn at", unit: "% of cap", hint: "A warning when a board reaches this share of its cap." },
  { key: "concurrency", name: "Renders at once", unit: "per workspace", hint: "Jobs that may run at the same time." },
  { key: "rendersPerHour", name: "Renders an hour", unit: "per workspace", hint: "Above this, jobs wait." },
  { key: "storageGb", name: "Storage kept", unit: "GB", hint: "Per workspace." },
];

/**
 * Limits: what every new workspace starts with, and the caps that keep spend and load in check (lib/platformLayer.ts ›
 * PlatformCaps). Save keeps the numbers (the platform layer's own route, key `caps`, which checks each again); Reset puts
 * the defaults back.
 */
export function Limits() {
  const toast = useToast();
  const { data, refresh } = useAdminRead<Layer>("/api/admin/platform-layer", 0);
  const [edited, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  /* What is on screen: the person's edits once they start, until then what the server holds. */
  const draft = edited ?? (data ? toDraft(data.layer.caps) : null);

  async function save() {
    if (!draft) return;
    setBusy(true);
    const sent = await adminSend<{ layer: { caps: PlatformCaps } }>("/api/admin/platform-layer", "PATCH", { key: "caps", value: draft });
    setBusy(false);
    if (sent.ok) { setDraft(toDraft(sent.json.layer.caps)); toast({ text: "Saved" }); } else toast({ text: sent.error });
    refresh();
  }
  async function reset() {
    setBusy(true);
    const sent = await adminSend("/api/admin/platform-layer", "PATCH", { key: "caps", reset: true });
    setBusy(false);
    if (sent.ok) { setDraft(toDraft(DEFAULT_CAPS)); toast({ text: "Limits back to the defaults" }); } else toast({ text: sent.error });
    refresh();
  }

  return (
    <>
      <Head title="Limits" line="Caps that keep spend and load in check." />
      <form className="v12-pc-rows" data-testid="pc-limits" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {draft ? FIELDS.map((f) => (
          <div key={f.key} className="v12-pc-field v12-pc-limit">
            <label className="v12-pc-fname" htmlFor={`pc-limit-${f.key}`}>{f.name}</label>
            <span className="v12-pc-unit">
              <input id={`pc-limit-${f.key}`} className="v12-pc-input v12-pc-num" inputMode="decimal" value={draft[f.key]} placeholder={f.blank} data-testid={`pc-limit-${f.key}`} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
              <span>{f.unit}</span>
            </span>
            <span className="v12-pc-rowline">{f.hint}</span>
          </div>
        )) : null}
        <div className="v12-pc-actions">
          <button type="submit" className="v12-pc-primary" disabled={busy || !draft} data-testid="pc-limits-save">Save</button>
          <button type="button" className="v12-pc-btn" disabled={busy || !draft} onClick={() => void reset()} data-testid="pc-limits-reset">Reset to defaults</button>
        </div>
      </form>
    </>
  );
}
