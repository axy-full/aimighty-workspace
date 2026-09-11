"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent as RMouseEvent } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { useAtomikRail } from "@/lib/atomikRail";
import { MODELS } from "@/lib/models";
import { estimateVideo, estimateImage } from "@/lib/rateTable";
import { estimateTokens, costUsd } from "@/lib/models";
import { NOTIFY_KINDS, NOTIFY_LABELS, type NotifyKind } from "@/lib/notifyPrefs";
import { appAlert, appPrompt } from "@/components/dialog";
import { Mono, Button } from "@/components/ui";
import { usePhone } from "@/lib/usePhone";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { ToastHost, useToast } from "@/components/ui/Toast";
import Ring from "@/components/atomik/Ring";
import { PageLoader } from "@/components/atomik/Loader";

/**
 * Settings (design/particl-v2/README.md §13; board 4a), value for value:
 * the 240px index (`24px 16px`; `Settings` at 600 22; rows `9px 10px`,
 * radius 8, 500 13.5, the current one on .12; the note at the foot) and
 * one scrolling column (`24px 28px 40px`, 14 apart) of `--card` sections
 * (.08, radius 12, `18px 20px`): Workspace beside Credits (`1fr 380px`),
 * Team & roles, Engines & rates, Production defaults beside Atomik, then
 * Rig & locks · Storage & masters · Notifications, and Account. A row is
 * `10px 0` on a .07 rule at 400 13.5 with its value on the right — a
 * chip that opens a menu (`6px 10px`, .12), a 34×20 switch, or mono.
 * Changes save as they are made. Prices are read from engines, never
 * typed here (§1): the rate on each engine card is the workspace's own
 * table at the composer's defaults.
 *
 * Roles are what the app has — Owner, Admin, Member — not the five §13
 * lists; a dropdown the server could not enforce would be a lie. The
 * rows whose behaviour has one setting today say so without a caret
 * (Atomik checkpoints at every paid step; it proposes assets and never
 * creates them).
 *
 * Below 768 (design/particl-v2-mobile, board M10): the index as pills
 * scrolling in a `10px 16px` row; then `12px 16px 40px`, 12 apart, one
 * `--card` at radius 14 (`14px`) per section, each under its mono label —
 * Credits first (the balance at 600 30 with the dollars beside it, `MONTH
 * TO DATE`, `Top up · 500 CR · $50`), Workspace rows (48px, the value in
 * mono with ▾), Team rows (a 30px avatar, the name, the role ▾, `Invite`),
 * Engines, Production defaults, Atomik (`EVERY PAID STEP`, `PROPOSE ONLY`,
 * `NEVER WITHOUT YOU · SPEND · UNLOCK · DELETE · APPROVE`), Rig, Storage,
 * Notifications, Account. The board's auto top-up row has no setting
 * behind it yet and is left out rather than drawn dead.
 */
type Me = { name: string; email: string; role: string; owner?: boolean; workspace?: { name: string } | null };
type Ws = { settings: Record<string, string>; defaults: Record<string, string>; models?: { video: string; image: string } | null };
type Team = { users: { id: string; email: string; name: string; role?: string; standing?: string; permanent?: boolean; disabled: boolean }[]; invites: { code: string; email: string; name: string }[]; canSeeRoles?: boolean };
type Engines = { engines: { id: string; label: string; configured: boolean; models: { id: string; label: string; kind: "video" | "image" }[] }[]; refiner?: { writer: "none" | "byteplus" | "claude"; label: string; via: string; configured: boolean; usdPerCall?: number } };
type Topups = { applies: boolean; canRequest: boolean; credits: { creditUsd: number; granted: number; used: number; balance: number } | null; packs: { id: string; label: string; credits: number; bonus: number; total: number; usd: number }[]; requests: { id: string; status: string }[] };
type Usage = { months?: { month: string; credits: number; usd?: number }[]; spentUsd?: number; storage?: { bytes: number } | null };
type Limits = { limits: { storageBytes: number }; standing: { usedBytes: number } };

const SECTIONS = [
  ["workspace", "Workspace & credits"], ["team", "Team & roles"], ["engines", "Engines & rates"], ["defaults", "Production defaults"],
  ["atomik", "Atomik"], ["rig", "Rig & locks"], ["storage", "Storage & masters"], ["notifications", "Notifications"], ["account", "Account"],
] as const;
const CAN: Record<string, string> = {
  owner: "Owns the workspace · everything an admin can",
  admin: "Seats · keys · routing · Atomik · everything a member can",
  member: "Generate · pick and approve · file · download masters",
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "—";
const gb = (bytes: number) => bytes >= 1e12 ? `${(bytes / 1e12).toFixed(2)} TB` : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(0)} MB` : `${(bytes / 1e3).toFixed(0)} KB`;
const PUSH_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
function urlB64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export default function SettingsPage() {
  return <ToastHost><Settings /></ToastHost>;
}

/* ── the pieces of a section ─────────────────────────────────────────── */
function Section({ id, title, label, line, children, className = "", head }: { id: string; title?: string; label?: string; line?: string; children: ReactNode; className?: string; head?: ReactNode }) {
  return (
    <section id={id} className={`flex flex-col rounded-card border border-border bg-card px-[20px] py-[18px] ${className}`} aria-label={label ?? title}>
      {title && (
        <span className="flex items-center justify-between gap-[12px] pb-[8px]">
          <span className="flex flex-col gap-[4px]"><span className="text-[16px] font-semibold leading-none text-ink">{title}</span>{line && <span className="text-[13px] leading-[1.4] text-ink-body">{line}</span>}</span>
          {head}
        </span>
      )}
      {children}
    </section>
  );
}
function Row({ label, children, gap = false }: { label: ReactNode; children: ReactNode; gap?: boolean }) {
  const phone = usePhone();
  if (phone) return <span className="flex min-h-[48px] items-center justify-between gap-[12px] border-t border-[rgba(245,246,248,.07)] text-[13.5px] font-medium leading-[1.3] text-ink"><span>{label}</span>{children}</span>;
  return <span className={`flex items-center justify-between border-t border-[rgba(245,246,248,.07)] py-[10px] text-[13.5px] leading-none text-ink ${gap ? "gap-[10px]" : ""}`}><span>{label}</span>{children}</span>;
}
/** M10's card: `--card`, .08, radius 14, `14px`, its mono label first, an optional head at the right. */
function Card({ id, label, head, children, className = "gap-[2px]" }: { id: string; label: ReactNode; head?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`flex flex-col rounded-mobile border border-border bg-card p-[14px] ${className}`} aria-label={typeof label === "string" ? label : undefined}>
      <span className={`flex items-center justify-between gap-[10px] ${className === "gap-[2px]" ? "pb-[8px]" : ""}`}><Mono>{label}</Mono>{head}</span>
      {children}
    </section>
  );
}
function Switch({ on, onChange, label, disabled = false }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`tap44 relative inline-block h-[20px] w-[34px] flex-none rounded-[10px] disabled:opacity-40 ${on ? "bg-ink" : "bg-[rgba(245,246,248,.2)]"}`}>
      <span className={`absolute top-[2px] h-[16px] w-[16px] rounded-full ${on ? "left-[16px] bg-ground" : "left-[2px] bg-ink"}`} />
    </button>
  );
}
function ChipMenu({ value, items, label, fixed = false }: { value: ReactNode; items: MenuItem[]; label: string; fixed?: boolean }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const phone = usePhone();
  const cls = "tap44 flex items-center gap-[6px] rounded-pill border border-[rgba(245,246,248,.12)] px-[10px] py-[6px] text-[12.5px] font-medium leading-none text-ink";
  /* M10: the value in mono with its caret, no pill; a fixed value keeps the caret the board draws but nothing opens. */
  if (phone) return (
    <>
      <button type="button" aria-label={label} disabled={fixed} onClick={(e: RMouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setAt({ x: r.left, y: r.bottom + 6 }); }}
        className="tap44 flex items-center gap-[4px] whitespace-nowrap ui-mono ui-mono-cost text-ink-body">{value} ▾</button>
      {at && !fixed && <Menu x={at.x} y={at.y} title={label} items={items} onClose={() => setAt(null)} />}
    </>
  );
  if (fixed) return <span className={cls} title="The one behaviour the app has today">{value}</span>;
  return (
    <>
      <button type="button" aria-label={label} className={cls} onClick={(e: RMouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setAt({ x: r.left, y: r.bottom + 6 }); }}>{value} <span className="text-[9px] text-ink-muted max-md:text-[12px]">▼</span></button>
      {at && <Menu x={at.x} y={at.y} title={label} items={items} onClose={() => setAt(null)} />}
    </>
  );
}

function Settings() {
  const router = useRouter();
  const { signedIn, rates, credits: sessionCredits, name: myName } = useSession();
  const money = useMoney();
  const toast = useToast();
  const rail = useAtomikRail();
  usePageTitle("Settings");
  const { data: me } = useApi<Me>(signedIn ? "/api/me" : null, 0);
  const { data: ws, refresh: refreshWs } = useApi<Ws>(signedIn ? "/api/settings" : null, 0);
  const { data: team, refresh: refreshTeam } = useApi<Team>(signedIn ? "/api/team" : null, 60_000);
  const { data: eng, refresh: refreshEngines } = useApi<Engines>(signedIn ? "/api/engines" : null, 0);
  const { data: topups, refresh: refreshTopups } = useApi<Topups>(signedIn ? "/api/workspaces/topups" : null, 30_000);
  const { data: usage } = useApi<Usage>(signedIn ? "/api/usage" : null, 120_000);
  const { data: limits } = useApi<Limits>(signedIn ? "/api/limits" : null, 60_000);
  const { data: notify, refresh: refreshNotify } = useApi<{ prefs: Record<NotifyKind, boolean>; role: string }>(signedIn ? "/api/me/notify" : null, 0);
  const [current, setCurrent] = useState<string>(SECTIONS[0][0]);
  const column = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  const isAdmin = me?.role === "admin";
  const owner = Boolean(me?.owner);
  const settings = ws?.settings ?? {};
  const s = (k: string) => settings[k] ?? ws?.defaults[k] ?? "";

  /* The index follows the scroll: the section nearest the top is the current one. */
  useEffect(() => {
    const el = column.current; if (!el) return;
    const onScroll = () => {
      const top = el.getBoundingClientRect().top + 40;
      let best: string = SECTIONS[0][0]; let bestD = Infinity;
      for (const [id] of SECTIONS) { const n = document.getElementById(id); if (!n) continue; const d = Math.abs(n.getBoundingClientRect().top - top); if (d < bestD) { bestD = d; best = id; } }
      setCurrent(best);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ws]);
  const jump = (id: string) => { document.getElementById(id)?.scrollIntoView({ block: "start" }); setCurrent(id); };

  const save = async (key: string, value: string, said?: string) => {
    const r = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error ?? "That didn't save."); return false; }
    refreshWs(); if (key === "atomikEngines" || key === "promptWriter") refreshEngines();
    toast(said ?? "Saved"); return true;
  };

  /* ── the figures ──────────────────────────────────────────────────── */
  const videoModels = useMemo(() => MODELS.filter((m) => m.kind === "video" && !m.hidden && m.durations.length), []);
  const defaultVideo = ws?.models?.video ?? s("defaultVideoModel") ?? videoModels[0]?.id;
  const defaultModel = MODELS.find((m) => m.id === defaultVideo) ?? videoModels[0];
  const rateOf = (id: string): string => {
    const m = MODELS.find((x) => x.id === id); if (!m) return "—";
    if (m.kind === "image") { const p = estimateImage(rates, id, m.resolutions.includes("1K") ? "1K" : m.resolutions[0], 0); return p == null ? "—" : `${money.price(p)} / still`; }
    const res = m.resolutions.includes("1080p") ? "1080p" : m.resolutions[0]; const secs = m.durations.includes(5) ? 5 : (m.durations[0] ?? 5);
    const p = estimateVideo(rates, id, res, secs, estimateTokens(res, "16:9", secs), costUsd, { audio: false });
    return p == null ? "—" : `${money.price(p)} / ${secs}s`;
  };
  const off = useMemo<string[]>(() => { try { const v = JSON.parse(s("atomikEngines") || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const configuredFor = (modelId: string) => Boolean(eng?.engines.find((e) => e.models.some((m) => m.id === modelId))?.configured);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthRow = usage?.months?.find((m) => m.month === thisMonth);
  const monthSpent = money.inCredits ? `${(monthRow?.credits ?? 0).toLocaleString()} cr` : money.price(monthRow?.usd ?? 0);
  const creditUsd = rates.creditUsd || topups?.credits?.creditUsd || 0.1;
  const balance = topups?.credits?.balance ?? sessionCredits?.balance ?? 0;
  const pack = topups?.packs[0] ?? null;
  const openRequests = (topups?.requests ?? []).filter((r) => r.status === "requested").length;
  const used = limits?.standing.usedBytes ?? usage?.storage?.bytes ?? 0;

  const invite = async () => {
    const name = await appPrompt("Invite someone", "", "Name", "Their name, then their email on the next line."); if (!name?.trim()) return;
    const email = await appPrompt(`Invite ${name.trim()}`, "", "name@studio.com"); if (!email?.trim()) return;
    const r = await fetch("/api/team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), email: email.trim(), role: "member" }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error ?? "Not invited."); return; }
    toast(`${name.trim()} invited`); refreshTeam();
  };
  const setRole = async (id: string, role: "admin" | "member") => {
    const r = await fetch(`/api/team/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error ?? "That didn't change."); return; }
    toast(`Now ${role}`); refreshTeam();
  };
  const topUp = async () => {
    if (!pack) return;
    const r = await fetch("/api/workspaces/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packId: pack.id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error ?? "No request made."); return; }
    if (j.checkout?.url) { window.location.assign(j.checkout.url); return; }
    toast(`${pack.total.toLocaleString()} cr requested · the platform confirms it`); refreshTopups();
  };
  const setNotify = async (kind: NotifyKind, on: boolean) => {
    const r = await fetch("/api/me/notify", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, on }) });
    if (!r.ok) { toast("That didn't save."); return; }
    refreshNotify();
  };
  const signOut = async () => { await fetch("/api/auth/logout", { method: "POST" }); router.push("/login"); router.refresh(); };
  const deleteWorkspace = async () => {
    const wsName = me?.workspace?.name ?? "";
    const typed = await appPrompt(`Delete "${wsName}"?`, "", wsName, "Every take, upload, identity and its database will be purged; the platform keeps only its billing record. Type the workspace's name to confirm.");
    if (typed === null) return;
    const r = await fetch("/api/workspaces", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: typed }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { await appAlert("Not deleted", j.error ?? "Could not delete it"); return; }
    router.push("/make/video"); router.refresh();
  };

  if (!signedIn) return <div className="p-[24px] text-[13px] text-ink-body">Sign in to see your workspace&rsquo;s settings.</div>;
  if (!ws || !me) return <PageLoader what="Opening · Settings" />;

  const monthName = MONTHS[new Date().getMonth()];
  if (phone) {
    const SHORT: Record<string, string> = { workspace: "Workspace", team: "Team", engines: "Engines", defaults: "Defaults", atomik: "Atomik", rig: "Rig", storage: "Storage", notifications: "Notifications", account: "Account" };
    const pill = "tap44 flex flex-none items-center rounded-pill border border-[rgba(245,246,248,.14)] px-[11px] py-[8px] text-[12.5px] font-medium leading-none text-ink";
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
        <div className="flex flex-none gap-[6px] overflow-x-auto border-b border-border px-[16px] py-[10px]" role="navigation" aria-label="Sections" data-index="">
          {SECTIONS.map(([id]) => (
            <button key={id} type="button" onClick={() => jump(id)} aria-current={current === id ? "true" : undefined}
              className={`tap44 flex-none rounded-pill border border-[rgba(245,246,248,.12)] px-[11px] py-[8px] text-[12.5px] font-medium leading-none ${current === id ? "bg-[rgba(245,246,248,.1)] text-ink" : "text-ink-body"}`}>{SHORT[id]}</button>
          ))}
        </div>
        <div ref={column} className="flex min-h-0 min-w-0 flex-col gap-[12px] overflow-y-auto px-[16px] pb-[40px] pt-[12px]">
          <Card id="credits" label={`Credits · ${me.workspace?.name ?? "workspace"}`} className="gap-[12px]">
            <span className="flex items-baseline gap-[8px]">
              <span className="text-[30px] font-semibold leading-none tracking-[-0.02em] text-ink">{money.inCredits ? balance.toLocaleString() : money.price(usage?.spentUsd ?? 0)}</span>
              <span className="text-[14px] leading-none text-ink-body">{money.inCredits ? `cr · $${(balance * creditUsd).toFixed(2)}` : "spent with your own vendors"}</span>
            </span>
            <span className="flex justify-between"><Mono>Month to date</Mono><Mono cost tone="ink">{monthSpent}</Mono></span>
            {openRequests > 0 && <span className="flex justify-between"><Mono>Open top-up requests</Mono><Mono cost tone="ink">{openRequests}</Mono></span>}
            {topups?.applies && pack ? (
              <button type="button" disabled={!topups.canRequest} onClick={topUp} className={`flex h-[48px] items-center justify-between rounded-card px-[14px] text-[14px] font-semibold leading-none disabled:opacity-60 ${rail.open ? "border border-[rgba(245,246,248,.2)] text-ink-body" : "bg-ink text-ground"}`}>
                Top up<span className={`ui-mono ui-mono-cost !text-[12px] ${rail.open ? "text-ink-muted" : "text-on-primary-cost"}`}>{pack.total.toLocaleString()} cr · ${pack.usd}</span>
              </button>
            ) : <span className="text-[13px] leading-[1.4] text-ink-body" style={{ textWrap: "pretty" }}>This workspace pays its vendors directly; there is nothing to top up.</span>}
          </Card>
          <Card id="workspace" label="Workspace">
            <Row label="Workspace name"><Mono cost tone="body">{me.workspace?.name ?? "—"}</Mono></Row>
            <Row label="Default model"><ChipMenu label="Default model" value={defaultModel?.label ?? "—"} items={videoModels.map((m): MenuItem => ({ kind: "item", label: m.label, keys: rateOf(m.id), onSelect: () => { if (isAdmin) save("defaultVideoModel", m.id, `${m.label} is the default`); else toast("An admin sets the default engine."); } }))} /></Row>
            <Row label="Aspect · duration · resolution"><Mono cost tone="body">16:9 · 5s · 1080p</Mono></Row>
            <Row label="Take states"><Mono cost tone="body">draft → picked → approved</Mono></Row>
          </Card>
          <Card id="team" label={`Team · ${team?.users.length ?? 0} ${team?.users.length === 1 ? "seat" : "seats"}`} className="gap-[10px]"
            head={<button type="button" onClick={invite} className={pill}>Invite</button>}>
            {(team?.users ?? []).map((m) => {
              const role = m.permanent ? "owner" : (m.role ?? "member");
              return (
                <span key={m.id} className="flex min-h-[48px] items-center gap-[10px] border-t border-[rgba(245,246,248,.07)]">
                  <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border border-border-mid bg-ground ui-mono tracking-normal text-ink">{initials(m.name)}</span>
                  <span className="truncate text-[13.5px] font-medium leading-none text-ink">{m.name}{m.disabled ? " · disabled" : ""}</span>
                  <span className="ml-auto flex-none"><ChipMenu label={`${m.name}'s role`} fixed={m.permanent || !owner} value={role} items={[{ kind: "item", label: "Admin", onSelect: () => setRole(m.id, "admin") }, { kind: "item", label: "Member", onSelect: () => setRole(m.id, "member") }]} /></span>
                </span>
              );
            })}
            {(team?.invites ?? []).map((i) => (
              <span key={i.code} className="flex min-h-[48px] items-center gap-[10px] border-t border-[rgba(245,246,248,.07)]">
                <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border border-dashed border-border-mid ui-mono tracking-normal text-ink-muted">{initials(i.name)}</span>
                <span className="truncate text-[13.5px] font-medium leading-none text-ink">{i.name}</span>
                <Mono cost className="ml-auto flex-none">Invited</Mono>
              </span>
            ))}
          </Card>
          <Card id="engines" label="Engines & rates">
            {MODELS.filter((m) => !m.hidden).map((m) => {
              const on = !off.includes(m.id); const ok = configuredFor(m.id);
              return (
                <Row key={m.id} label={<span className="flex items-center gap-[8px]"><span className={`box-border block h-[7px] w-[7px] flex-none rounded-full ${ok ? "bg-ink" : "border border-dashed border-ink-muted"}`} />{m.label}</span>}>
                  <span className="flex items-center gap-[10px]"><Mono cost tone="body" className="whitespace-nowrap">{rateOf(m.id)}</Mono><Switch on={on} label={`Atomik may propose ${m.label}`} disabled={!isAdmin} onChange={(v) => { const next = v ? off.filter((x) => x !== m.id) : [...off, m.id]; save("atomikEngines", JSON.stringify(next), v ? `Atomik may propose ${m.label}` : `Atomik won't propose ${m.label}`); }} /></span>
                </Row>
              );
            })}
          </Card>
          <Card id="defaults" label="Production defaults">
            <Row label="Shot cap"><button type="button" className="tap44" onClick={async () => { const v = await appPrompt("Credits a shot may take before a member needs an admin", s("shotCapCredits"), "50"); if (v != null && /^\d+$/.test(v.trim())) save("shotCapCredits", v.trim(), `Shot cap · ${v.trim()} cr`); }}><Mono cost tone="body">{s("shotCapCredits")} cr ▾</Mono></button></Row>
            <Row label="Warn the producer at"><ChipMenu label="Warn at" value={`${s("capWarnPct")}% of cap`} items={[50, 70, 80, 90].map((p): MenuItem => ({ kind: "item", label: `${p}%`, onSelect: () => save("capWarnPct", String(p), `Warn at ${p}%`) }))} /></Row>
            <Row label="At the cap"><ChipMenu label="At the cap" value={s("atCap") === "stop" ? "Stop" : s("atCap") === "warn" ? "Warn only" : "Producer unlocks"} items={[["producer", "Producer unlocks"], ["stop", "Stop"], ["warn", "Warn only"]].map(([v, l]): MenuItem => ({ kind: "item", label: l, onSelect: () => save("atCap", v, `At the cap · ${l.toLowerCase()}`) }))} /></Row>
            <Row label="Who approves takes"><ChipMenu label="Who approves" value={s("approvalRule") === "producer" ? "Producer" : s("approvalRule") === "cap" ? "Anyone under the cap" : "Anyone"} items={[["anyone", "Anyone"], ["cap", "Anyone under the cap"], ["producer", "Producer"]].map(([v, l]): MenuItem => ({ kind: "item", label: l, onSelect: () => save("approvalRule", v, `${l} approves`) }))} /></Row>
            <Row label="Who renders"><ChipMenu label="Who renders" fixed value="Anyone" items={[]} /></Row>
          </Card>
          <Card id="atomik" label={<span className="flex items-center gap-[8px]"><Ring mode="idle" size={18} className="flex-none" />Atomik</span>} className="gap-[10px]">
            <Row label="Checkpoint rule"><ChipMenu label="Checkpoint" fixed value="Every paid step" items={[]} /></Row>
            <Row label="May create assets"><ChipMenu label="May create assets" fixed value="Propose only" items={[]} /></Row>
            <Row label="Planning model">
              <span className="flex items-center gap-[8px]">
                <ChipMenu label="Planning model" value={eng?.refiner?.writer === "none" ? "None" : eng?.refiner?.label ?? "—"} items={[["claude", "Claude"], ["byteplus", "BytePlus"], ["none", "None"]].map(([v, l]): MenuItem => ({ kind: "item", label: l, onSelect: () => { if (isAdmin) save("promptWriter", v, `Planning by ${l}`); else toast("An admin chooses the planning model."); } }))} />
                {eng?.refiner && eng.refiner.writer !== "none" && <Mono cost tone="ink" className="whitespace-nowrap">{money.price(eng.refiner.usdPerCall ?? 0)} / plan</Mono>}
              </span>
            </Row>
            <Mono className="border-t border-[rgba(245,246,248,.07)] pt-[10px] !leading-[1.5]">Never without you · spend · unlock · delete · approve</Mono>
          </Card>
          <Card id="rig" label="Rig & locks">
            <Row label="Lock new identities, voices, looks"><Switch on={s("lockNewAssets") === "1"} label="Lock new assets" disabled={!isAdmin} onChange={(v) => save("lockNewAssets", v ? "1" : "0", v ? "New assets start locked" : "New assets start open")} /></Row>
            <Row label="Who may unlock"><ChipMenu label="Who may unlock" fixed value="Admin" items={[]} /></Row>
            <Row label="Train on create"><ChipMenu label="Train on create" value={s("trainOnCreate") === "always" ? "Always" : s("trainOnCreate") === "never" ? "Never" : "Ask each time"} items={[["ask", "Ask each time"], ["always", "Always"], ["never", "Never"]].map(([v, l]): MenuItem => ({ kind: "item", label: l, onSelect: () => save("trainOnCreate", v, `Train on create · ${l.toLowerCase()}`) }))} /></Row>
          </Card>
          <Card id="storage" label="Storage & masters">
            <Row label="Bucket"><Mono cost tone="body">{gb(used)}{limits ? ` of ${gb(limits.limits.storageBytes)}` : ""}</Mono></Row>
            <Row label="File naming"><button type="button" className="tap44 min-w-0 text-right" onClick={async () => { const v = await appPrompt("File naming", s("namingTemplate"), "{project}_{scene}_{shot}_{model}_v{version}_{user}"); if (v?.trim()) save("namingTemplate", v.trim(), "Naming saved"); }}><Mono tone="body" className="!whitespace-normal break-all !tracking-[.04em] normal-case">{s("namingTemplate")}</Mono></button></Row>
            <Row label="Keep every take"><Switch on={s("retentionDays") === "0"} label="Keep every take" disabled={!isAdmin} onChange={(v) => save("retentionDays", v ? "0" : "30", v ? "Every take is kept" : "Takes are kept for 30 days")} /></Row>
          </Card>
          <Card id="notifications" label="Notifications">
            {NOTIFY_KINDS.filter((k) => !NOTIFY_LABELS[k].adminOnly || isAdmin).map((k) => (
              <Row key={k} label={NOTIFY_LABELS[k].title}><Switch on={notify?.prefs[k] ?? true} label={NOTIFY_LABELS[k].title} onChange={(v) => setNotify(k, v)} /></Row>
            ))}
            <PushRow />
          </Card>
          <Card id="account" label="Account" className="gap-[10px]">
            <span className="text-[13px] leading-[1.4] text-ink-body">{me.email} · {me.owner ? "owner" : me.role}{me.workspace ? ` · ${me.workspace.name}` : ""}</span>
            <span className="flex flex-wrap gap-[8px]">
              {owner && <a href="/api/export?format=csv" download className={`${pill} h-[44px]`}>Export · CSV</a>}
              {owner && <a href="/api/export" download className={`${pill} h-[44px]`}>Export · JSON</a>}
              <button type="button" onClick={signOut} className={`${pill} h-[44px]`}>Sign out</button>
              {owner && <button type="button" onClick={deleteWorkspace} className={`${pill} h-[44px] text-ink-body`}>Delete workspace</button>}
            </span>
          </Card>
        </div>
      </div>
    );
  }
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] bg-ground text-ink">
      <aside className="flex flex-col gap-[2px] border-r border-border px-[16px] py-[24px]" aria-label="Sections">
        <span className="px-[10px] pb-[16px] text-[22px] font-semibold leading-[1.1] tracking-[-0.02em] text-ink">Settings</span>
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => jump(id)} aria-current={current === id ? "true" : undefined}
            className={`rounded-ctl px-[10px] py-[9px] text-left text-[13.5px] font-medium leading-none ${current === id ? "bg-selected text-ink" : "text-ink-body"}`}>{label}</button>
        ))}
        <span className="mt-auto px-[10px] text-[12.5px] leading-[1.45] text-ink-muted" style={{ textWrap: "pretty" }}>Changes save as you make them. Prices are read from engines, never typed here.</span>
      </aside>
      <div ref={column} className="flex min-h-0 min-w-0 flex-col gap-[14px] overflow-y-auto px-[28px] pb-[40px] pt-[24px]">
        <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-[14px]">
          <Section id="workspace" title="Workspace" line="What every new composer opens with." className="gap-[14px]">
            <div className="grid grid-cols-2 gap-x-[20px] gap-y-[8px] max-md:grid-cols-1">
              <Row label="Workspace name"><span className="text-[13px] font-medium leading-none text-ink">{me.workspace?.name ?? "—"}</span></Row>
              <Row label="Default model">
                <ChipMenu label="Default model" value={defaultModel?.label ?? "—"} items={videoModels.map((m): MenuItem => ({ kind: "item", label: m.label, keys: rateOf(m.id), onSelect: () => { if (isAdmin) save("defaultVideoModel", m.id, `${m.label} is the default`); else toast("An admin sets the default engine."); } }))} />
              </Row>
              <Row label="Aspect · duration · resolution"><Mono cost tone="ink">16:9 · 5s · 1080p</Mono></Row>
              <Row label="Take states"><Mono cost tone="ink">draft → picked → approved</Mono></Row>
            </div>
          </Section>
          <Section id="credits" label="Credits" className="gap-[12px]">
            <Mono>Credits · 1 cr = {Math.round(creditUsd * 100)}¢</Mono>
            <span className="flex items-baseline gap-[8px]">
              <span className="text-[34px] font-semibold leading-none tracking-[-0.02em] text-ink">{money.inCredits ? balance.toLocaleString() : money.price(usage?.spentUsd ?? 0)}</span>
              <span className="text-[14px] leading-none text-ink-body">{money.inCredits ? `cr · $${(balance * creditUsd).toFixed(2)}` : "spent with your own vendors"}</span>
            </span>
            <span className="flex justify-between text-[13px] leading-[1.4] text-ink-body"><span>Open top-up requests</span><Mono cost tone="ink">{openRequests}</Mono></span>
            <span className="flex justify-between text-[13px] leading-[1.4] text-ink-body"><span>{monthName} so far</span><Mono cost tone="ink">{monthSpent}</Mono></span>
            {topups?.applies && pack ? (
              <Button variant="primary" placement="card" outlined={rail.open} disabled={!topups.canRequest} onClick={topUp} cost={pack.total} costSuffix={` · $${pack.usd}`}>Top up</Button>
            ) : (
              <span className="text-[13px] leading-[1.4] text-ink-body" style={{ textWrap: "pretty" }}>This workspace pays its vendors directly; there is nothing to top up.</span>
            )}
          </Section>
        </div>

        <Section id="team" title="Team & roles" line={`${team?.users.length ?? 0} ${team?.users.length === 1 ? "seat" : "seats"}. Roles decide who approves, who sets caps, who downloads masters.`} className="gap-[12px]"
          head={<button type="button" onClick={invite} className="tap44 flex h-[36px] flex-none items-center rounded-pill border border-border-mid px-[12px] text-[13px] font-medium leading-none text-ink">Invite</button>}>
          <div className="grid grid-cols-3 gap-[8px] max-md:grid-cols-1">
            {(team?.users ?? []).map((m) => {
              const role = m.permanent ? "owner" : (m.role ?? "member");
              return (
                <div key={m.id} className="flex items-center gap-[10px] rounded-tile border border-border bg-ground px-[12px] py-[10px]">
                  <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border border-border-mid bg-card ui-mono tracking-normal text-ink">{initials(m.name)}</span>
                  <span className="flex min-w-0 flex-col gap-[3px]"><span className="text-[13.5px] font-medium leading-[1.2] text-ink">{m.name}{m.disabled ? " · disabled" : ""}</span><span className="truncate text-[12px] leading-[1.3] text-ink-body">{CAN[role] ?? CAN.member}</span></span>
                  <span className="ml-auto flex-none">
                    <ChipMenu label={`${m.name}'s role`} fixed={m.permanent || !owner} value={<span className="text-[12px]">{role[0].toUpperCase() + role.slice(1)}</span>}
                      items={[{ kind: "item", label: "Admin", onSelect: () => setRole(m.id, "admin") }, { kind: "item", label: "Member", onSelect: () => setRole(m.id, "member") }]} />
                  </span>
                </div>
              );
            })}
            {(team?.invites ?? []).map((i) => (
              <div key={i.code} className="flex items-center gap-[10px] rounded-tile border border-dashed border-[rgba(245,246,248,.22)] px-[12px] py-[10px]">
                <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border border-dashed border-border-mid ui-mono tracking-normal text-ink-muted">{initials(i.name)}</span>
                <span className="flex min-w-0 flex-col gap-[3px]"><span className="text-[13.5px] font-medium leading-[1.2] text-ink">{i.name}</span><span className="truncate text-[12px] leading-[1.3] text-ink-body">Invited · {i.email}</span></span>
              </div>
            ))}
          </div>
        </Section>

        <Section id="engines" title="Engines & rates" line="Keys are set by an admin and never shown again in full. The rate is what every button quotes. The switch is whether Atomik may propose the engine." className="gap-[12px]">
          <div className="grid grid-cols-3 gap-[8px] max-md:grid-cols-1">
            {MODELS.filter((m) => !m.hidden).map((m) => {
              const on = !off.includes(m.id); const ok = configuredFor(m.id);
              return (
                <div key={m.id} className="flex flex-col gap-[9px] rounded-tile border border-border bg-ground p-[12px]">
                  <span className="flex items-center gap-[8px]"><span className="text-[13.5px] font-semibold leading-[1.2] text-ink">{m.label}</span><span className="ml-auto flex items-center gap-[5px] ui-mono"><span className={`box-border block h-[7px] w-[7px] rounded-full ${ok ? "bg-ink" : "border border-dashed border-ink-muted"}`} />{ok ? "connected" : "no key"}</span></span>
                  <span className="text-[12.5px] leading-[1.3] text-ink-body">{m.use}</span>
                  <span className="flex items-center justify-between border-t border-[rgba(245,246,248,.07)] pt-[9px]">
                    <Mono cost tone="ink">{rateOf(m.id)}</Mono>
                    <span className="flex items-center gap-[8px] ui-mono">Atomik may propose<Switch on={on} label={`Atomik may propose ${m.label}`} disabled={!isAdmin} onChange={(v) => { const next = v ? off.filter((x) => x !== m.id) : [...off, m.id]; save("atomikEngines", JSON.stringify(next), v ? `Atomik may propose ${m.label}` : `Atomik won't propose ${m.label}`); }} /></span>
                  </span>
                </div>
              );
            })}
          </div>
        </Section>

        <div className="grid grid-cols-2 gap-[14px] max-md:grid-cols-1">
          <Section id="defaults" title="Production defaults" line="Every new production starts here; each can override." className="gap-[2px]">
            <Row label="Shot cap"><button type="button" className="tap44" onClick={async () => { const v = await appPrompt("Credits a shot may take before a member needs an admin", s("shotCapCredits"), "50"); if (v != null && /^\d+$/.test(v.trim())) save("shotCapCredits", v.trim(), `Shot cap · ${v.trim()} cr`); }}><Mono cost tone="ink">{s("shotCapCredits")} cr</Mono></button></Row>
            <Row label="Warn the producer at"><ChipMenu label="Warn at" value={`${s("capWarnPct")}% of cap`} items={[50, 70, 80, 90].map((p): MenuItem => ({ kind: "item", label: `${p}%`, onSelect: () => save("capWarnPct", String(p), `Warn at ${p}%`) }))} /></Row>
            <Row label="At the cap"><ChipMenu label="At the cap" value={s("atCap") === "stop" ? "Stop" : s("atCap") === "warn" ? "Warn only" : "Producer unlocks"} items={[["producer", "Producer unlocks"], ["stop", "Stop"], ["warn", "Warn only"]].map(([v, l]): MenuItem => ({ kind: "item", label: l, onSelect: () => save("atCap", v, `At the cap · ${l.toLowerCase()}`) }))} /></Row>
            <Row label="Who approves takes"><ChipMenu label="Who approves" value={s("approvalRule") === "producer" ? "Producer" : s("approvalRule") === "cap" ? "Anyone under the cap" : "Anyone"} items={[["anyone", "Anyone"], ["cap", "Anyone under the cap"], ["producer", "Producer"]].map(([v, l]): MenuItem => ({ kind: "item", label: l, onSelect: () => save("approvalRule", v, `${l} approves`) }))} /></Row>
            <Row label="Who renders"><ChipMenu label="Who renders" fixed value="Anyone" items={[]} /></Row>
          </Section>
          <Section id="atomik" title="Atomik" line="What it may do on its own, and where it must stop." className="gap-[2px]" head={<Ring mode="idle" size={18} className="order-first mr-[10px] flex-none self-start" />}>
            <Row label="Checkpoint"><ChipMenu label="Checkpoint" fixed value="Every paid step" items={[]} /></Row>
            <Row label="May create assets"><ChipMenu label="May create assets" fixed value="Propose only" items={[]} /></Row>
            <Row label="Planning model">
              <span className="flex items-center gap-[8px]">
                <ChipMenu label="Planning model" value={eng?.refiner?.writer === "none" ? "None" : eng?.refiner?.label ?? "—"} items={[["claude", "Claude"], ["byteplus", "BytePlus"], ["none", "None"]].map(([v, l]): MenuItem => ({ kind: "item", label: l, onSelect: () => { if (isAdmin) save("promptWriter", v, `Planning by ${l}`); else toast("An admin chooses the planning model."); } }))} />
                {eng?.refiner && eng.refiner.writer !== "none" && <Mono cost tone="ink" className="whitespace-nowrap">{money.price(eng.refiner.usdPerCall ?? 0)} / plan</Mono>}
              </span>
            </Row>
            <Row label="Never without you"><Mono cost>Spend · unlock · delete · approve</Mono></Row>
          </Section>
        </div>

        <div className="grid grid-cols-3 gap-[14px] max-md:grid-cols-1">
          <Section id="rig" title="Rig & locks" line="What stays fixed once a face, voice or look exists." className="gap-[2px]">
            <Row label="Lock new identities, voices, looks"><Switch on={s("lockNewAssets") === "1"} label="Lock new assets" disabled={!isAdmin} onChange={(v) => save("lockNewAssets", v ? "1" : "0", v ? "New assets start locked" : "New assets start open")} /></Row>
            <Row label="Who may unlock"><ChipMenu label="Who may unlock" fixed value="Admin" items={[]} /></Row>
            <Row label="Train on create"><ChipMenu label="Train on create" value={s("trainOnCreate") === "always" ? "Always" : s("trainOnCreate") === "never" ? "Never" : "Ask each time"} items={[["ask", "Ask each time"], ["always", "Always"], ["never", "Never"]].map(([v, l]): MenuItem => ({ kind: "item", label: l, onSelect: () => save("trainOnCreate", v, `Train on create · ${l.toLowerCase()}`) }))} /></Row>
          </Section>
          <Section id="storage" title="Storage & masters" line="Byte-for-byte, never re-encoded for an API." className="gap-[2px]">
            <Row label="Bucket"><Mono cost tone="ink">{gb(used)}{limits ? ` of ${gb(limits.limits.storageBytes)}` : ""}</Mono></Row>
            <Row label="File naming" gap><button type="button" className="tap44 text-right" onClick={async () => { const v = await appPrompt("File naming", s("namingTemplate"), "{project}_{scene}_{shot}_{model}_v{version}_{user}"); if (v?.trim()) save("namingTemplate", v.trim(), "Naming saved"); }}><Mono tone="ink" className="!whitespace-normal break-all !tracking-[.04em] normal-case">{s("namingTemplate")}</Mono></button></Row>
            <Row label="Keep every take"><Switch on={s("retentionDays") === "0"} label="Keep every take" disabled={!isAdmin} onChange={(v) => save("retentionDays", v ? "0" : "30", v ? "Every take is kept" : "Takes are kept for 30 days")} /></Row>
          </Section>
          <Section id="notifications" title="Notifications" line="Per person. In-app always; email is the switch." className="gap-[2px]">
            {NOTIFY_KINDS.filter((k) => !NOTIFY_LABELS[k].adminOnly || isAdmin).map((k) => (
              <Row key={k} label={NOTIFY_LABELS[k].title} gap><Switch on={notify?.prefs[k] ?? true} label={NOTIFY_LABELS[k].title} onChange={(v) => setNotify(k, v)} /></Row>
            ))}
            <PushRow />
          </Section>
        </div>

        <Section id="account" title="Account" line={`${me.email} · ${me.owner ? "owner" : me.role}${me.workspace ? ` · ${me.workspace.name}` : ""}`} className="!flex-row items-center justify-between gap-[20px] max-md:!flex-col max-md:items-start"
          head={<span className="flex flex-wrap gap-[8px]">
            {owner && <a href="/api/export?format=csv" download className="tap44 flex h-[36px] items-center rounded-pill border border-border-mid px-[12px] text-[13px] font-medium leading-none text-ink">Export · CSV</a>}
            {owner && <a href="/api/export" download className="tap44 flex h-[36px] items-center rounded-pill border border-border-mid px-[12px] text-[13px] font-medium leading-none text-ink">Export · JSON</a>}
            <button type="button" onClick={signOut} className="tap44 flex h-[36px] items-center rounded-pill border border-border-mid px-[12px] text-[13px] font-medium leading-none text-ink">Sign out{myName ? "" : ""}</button>
            {owner && <button type="button" onClick={deleteWorkspace} className="tap44 flex h-[36px] items-center rounded-pill border border-border-mid px-[12px] text-[13px] font-medium leading-none text-ink-body">Delete workspace</button>}
          </span>}>
          <span />
        </Section>
      </div>
    </div>
  );
}

/** Push on this device — a switch, or the one-line reason it can't be. */
function PushRow() {
  type PushState = "off" | "on" | "busy" | "denied" | "install" | "unconfigured" | "unsupported";
  const [state, setState] = useState<PushState>("off");
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(async () => {
      if (!("serviceWorker" in navigator && "PushManager" in window)) {
        const ios = /iP(hone|ad|od)/.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches;
        if (alive) setState(ios ? "install" : "unsupported"); return;
      }
      if (!PUSH_KEY) { if (alive) setState("unconfigured"); return; }
      if (Notification.permission === "denied") { if (alive) setState("denied"); return; }
      const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
      const on = Boolean(reg && (await reg.pushManager.getSubscription()));
      if (alive && on) setState("on");
    });
    return () => { alive = false; };
  }, []);
  async function enable() {
    setState("busy");
    try {
      if (!PUSH_KEY) throw new Error("The push keys aren't in this build yet.");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState(perm === "denied" ? "denied" : "off"); return; }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(PUSH_KEY) });
      const res = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "The server rejected it.");
      setState("on");
    } catch (e) { appAlert("Couldn't turn on notifications", (e as Error).message); setState(PUSH_KEY ? "off" : "unconfigured"); }
  }
  async function disable() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) { await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
      setState("off");
    } catch (e) { setState("on"); await appAlert("Notifications are still on", (e as Error).message); }
  }
  if (state === "unsupported") return null;
  const note = state === "denied" ? "blocked in the browser" : state === "install" ? "add to the Home Screen first" : state === "unconfigured" ? "not set up here" : null;
  return (
    <Row label={<span className="flex flex-col gap-[3px]">Push on this device{note && <Mono>{note}</Mono>}</span>} gap>
      {note ? <Mono cost>—</Mono> : <Switch on={state === "on"} label="Push on this device" disabled={state === "busy"} onChange={(v) => (v ? enable() : disable())} />}
    </Row>
  );
}
