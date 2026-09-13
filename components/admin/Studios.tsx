"use client";

import { useState, type MouseEvent as RMouseEvent } from "react";
import { usePhone } from "@/lib/usePhone";
import { DEFAULT_PLANS, type PlanDef } from "@/lib/plans";
import { Mono } from "@/components/ui";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { appPrompt } from "@/components/dialog";
import { Card, ROW, Nothing } from "./Card";
import { patchWorkspace } from "./api";
import { fmtUsd, fmtPct, multiplierText } from "./adminFormat";
import type { Admin, Studio, Ws } from "./types";

/**
 * Studios (SOW surfaces board 12h, block 3): every workspace on the
 * deployment, month to date, under a mono head row — STUDIO · TIER ·
 * ENGINE $ · BILLED · MARGIN · NOTE · PRICE — on 48px rows. A margin under
 * 10% reads in ink; a note (the flag, or why it is suspended) reads in
 * ink; a studio over a quarter of the platform's spend says so in the
 * note. PRICE is the multiplier the platform bills the studio at — the
 * server's figure, `1.0×` for an internal studio, which is also left out
 * of every margin above. Nothing is red: a bad number is a number.
 *
 * The ⋯ on each row carries every lever the v1 desk had — suspend and
 * resume, flag and clear, limits, plan, credits, the internal flag, the
 * test workspace — as the same PATCH the v1 page sent. Below 768 the ⋯
 * opens as a sheet, so the page hears `onMenu` and outlines its primary
 * while one is open.
 */
const GRID = "grid-cols-[minmax(0,1.2fr)_120px_120px_120px_100px_180px_90px_40px] gap-[14px]";

function studiosOf(data: Admin): Studio[] {
  if (data.studios) return data.studios;
  /* A route a version behind: the 30-day figures the v1 desk had, with no month-to-date margin to speak of. */
  return data.workspaces.map((w): Studio => ({
    id: w.id, name: w.name, slug: w.slug, tier: w.planId ?? "", internal: Boolean(w.internal), suspended: w.suspended, flagged: w.flagged,
    engineCostUsd: w.spend30?.engineCostUsd ?? 0, billedCredits: w.spend30?.billedCredits ?? 0, marginPct: null, share: 0, overShare: false, underMargin: false,
    note: w.flagNote ?? w.suspendedReason ?? null, multiplier: Number.NaN,
  }));
}

export default function Studios({ data, onChanged, onMenu }: { data: Admin; onChanged: () => void; onMenu?: (open: boolean) => void }) {
  const phone = usePhone();
  const toast = useToast();
  const plans: PlanDef[] = data.plans ?? DEFAULT_PLANS;
  const byId = new Map<string, Ws>(data.workspaces.map((w) => [w.id, w]));
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const studios = studiosOf(data);

  async function patch(s: Studio, body: Record<string, unknown>, said: string) {
    setBusy(s.id);
    try { await patchWorkspace(s.id, body); toast(said); onChanged(); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  }
  function levers(s: Studio): MenuItem[] {
    const w = byId.get(s.id);
    const lim = w?.limits ?? { concurrency: null, rendersPerHour: null, storageGb: null };
    const items: MenuItem[] = [
      s.suspended
        ? { kind: "item", label: "Resume", onSelect: () => patch(s, { suspended: false }, `${s.name} resumed`) }
        : { kind: "item", label: "Suspend", onSelect: async () => {
            const reason = await appPrompt("Suspend this workspace? Say why — they will read it.", w?.suspendedReason ?? "", "Content policy: under review");
            if (reason === null) return;
            patch(s, { suspended: true, reason }, `${s.name} suspended`);
          } },
      s.flagged
        ? { kind: "item", label: "Clear flag", onSelect: () => patch(s, { flagged: false }, "Flag cleared") }
        : { kind: "item", label: "Flag", onSelect: async () => {
            const note = await appPrompt("Flag this workspace for review. A note for the desk; they do not see it.", w?.flagNote ?? "", "Prompts refused twice today");
            if (note === null) return;
            patch(s, { flagged: true, note }, `${s.name} flagged`);
          } },
      { kind: "item", label: "Limits", keys: `${lim.concurrency ?? "—"} / ${lim.rendersPerHour ?? "—"} / ${lim.storageGb ?? "—"}`, onSelect: async () => {
        const cur = `${lim.concurrency ?? ""} / ${lim.rendersPerHour ?? ""} / ${lim.storageGb ?? ""}`;
        const raw = await appPrompt("This workspace's own limits: renders at once / renders an hour / GB kept. Leave a number blank for the platform's default.", cur.trim() === "/ /" ? "" : cur, "4 / 60 / 50");
        if (raw === null) return;
        const parts = raw.split("/").map((x) => x.trim());
        const num = (x: string | undefined) => (x == null || x === "" ? null : Number(x));
        patch(s, { limits: { concurrency: num(parts[0]), rendersPerHour: num(parts[1]), storageGb: num(parts[2]) } }, "Limits set");
      } },
      { kind: "sub", label: "Plan", open: planOpen, onToggle: () => setPlanOpen((v) => !v), items: [
        { label: "No plan", onSelect: () => patch(s, { planId: null }, `${s.name} on no plan`) },
        ...plans.map((p) => ({ label: p.label, note: p.priceUsd ? `$${p.priceUsd}/mo` : "free", onSelect: () => patch(s, { planId: p.id }, `${s.name} on ${p.label}`) })),
      ] },
      { kind: "item", label: "Add credits", disabled: w ? !w.platformKeys : false, onSelect: async () => {
        const raw = await appPrompt("Credits to add to this workspace's balance.", "", "500");
        if (raw === null) return;
        const n = Number(raw);
        if (!Number.isFinite(n) || n === 0) { toast("A number of credits, please."); return; }
        patch(s, { grantCredits: n, note: "Added by management" }, `${n.toLocaleString("en-US")} cr added`);
      } },
      { kind: "divider" },
      { kind: "item", label: s.internal ? "Internal · off" : "Internal · on", keys: s.internal ? "1.0×" : "at cost",
        onSelect: () => patch(s, { internal: !s.internal }, s.internal ? `${s.name} bills at the platform's price` : `${s.name} bills at cost`) },
      { kind: "item", label: w?.internalTest ? "Test workspace · off" : "Test workspace · on",
        onSelect: () => patch(s, { internalTest: !w?.internalTest }, w?.internalTest ? "No longer the test workspace" : `${s.name} is the test workspace`) },
    ];
    return items;
  }
  const open = (s: Studio) => (e: RMouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPlanOpen(false);
    setMenu({ id: s.id, x: Math.max(8, r.right - 228), y: r.bottom + 6 });
    onMenu?.(true);
  };
  const close = () => { setMenu(null); onMenu?.(false); };
  const tierOf = (s: Studio) => plans.find((p) => p.id === s.tier)?.label ?? (s.tier || "—");
  const noteOf = (s: Studio) => {
    const parts: string[] = [];
    if (s.overShare) parts.push(`${Math.round(s.share * 100)}% of spend`);
    if (s.note) parts.push(s.note);
    return parts.join(" · ");
  };
  const dots = (s: Studio) => (
    <button type="button" aria-label={`Levers for ${s.name}`} aria-haspopup="menu" disabled={busy === s.id} onClick={open(s)}
      className="tap44 flex h-[28px] w-[28px] flex-none items-center justify-center justify-self-end rounded-ctl border border-border-mid text-[16px] leading-none text-ink disabled:opacity-40">⋯</button>
  );
  const name = (s: Studio) => (
    <span className="flex min-w-0 items-center gap-[8px]">
      <span className="truncate font-medium">{s.name}</span>
      {s.internal && <Mono cost className="flex-none">internal</Mono>}
      {s.suspended && <Mono cost className="flex-none">suspended</Mono>}
    </span>
  );
  const menuFor = studios.find((s) => s.id === menu?.id) ?? null;
  const legacy = (s: Studio) => Boolean(byId.get(s.id)?.legacy);

  return (
    <Card title="Studios" line="a studio over a quarter of all spend gets a flag · a margin under 10% is marked" label="Studios" span>
      {/* Desktop: the table scrolls inside its card when the window is narrower than its columns (the page never does). */}
      <div className={phone ? "flex flex-col" : "overflow-x-auto"}>
      <div className={phone ? "flex flex-col" : "flex min-w-[880px] flex-col"}>
      {!phone && (
        <span className={`grid ${GRID} pb-[8px]`} data-studios-head="">
          {["Studio", "Tier", "Engine $", "Billed", "Margin", "Note"].map((h) => <Mono key={h}>{h}</Mono>)}
          <Mono className="text-right">Price</Mono>
          <span />
        </span>
      )}
      {studios.length === 0 && <Nothing>No workspace yet.</Nothing>}
      {studios.map((s) => {
        const note = noteOf(s);
        const margin = <span className={s.marginPct == null ? "text-ink-muted" : s.underMargin ? "text-ink" : "text-ink-body"}>{fmtPct(s.marginPct)}</span>;
        const price = <Mono cost tone="ink" className="text-right">{multiplierText(s.multiplier)}</Mono>;
        const action = legacy(s) ? <Mono cost className="justify-self-end whitespace-nowrap">the platform</Mono> : dots(s);
        if (phone) return (
          <span key={s.id} className={`${ROW} grid-cols-[minmax(0,1fr)_40px] gap-[12px] py-[10px]`} data-studio={s.id}>
            <span className="flex min-w-0 flex-col gap-[6px]">
              <span className="flex min-w-0 items-baseline gap-[8px]">{name(s)}<span className="flex-none text-[13px] text-ink-body">{tierOf(s)}</span></span>
              <Mono cost tone="body">{fmtUsd(s.engineCostUsd)} · {Math.round(s.billedCredits).toLocaleString("en-US")} cr</Mono>
              <span className="flex min-w-0 items-center gap-[8px] text-[13px] leading-[1.3]">
                {margin}{note && <span className="truncate text-ink">· {note}</span>}<span className="ml-auto flex-none">{price}</span>
              </span>
            </span>
            {action}
          </span>
        );
        return (
          <span key={s.id} className={`${ROW} ${GRID}`} data-studio={s.id}>
            {name(s)}
            <span className="truncate text-ink-body">{tierOf(s)}</span>
            <span className="truncate">{fmtUsd(s.engineCostUsd)}</span>
            <span className="truncate">{Math.round(s.billedCredits).toLocaleString("en-US")} cr</span>
            {margin}
            <span className={`truncate ${note ? "text-ink" : "text-ink-muted"}`} title={note || undefined}>{note || "—"}</span>
            {price}
            {action}
          </span>
        );
      })}
      </div>
      </div>
      {menu && menuFor && <Menu x={menu.x} y={menu.y} title={menuFor.name} items={levers(menuFor)} onClose={close} />}
    </Card>
  );
}
