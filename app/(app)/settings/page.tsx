"use client";

/**
 * Settings — from the pipeline handoff.
 *
 * A sticky index on the left, six panel cards on the right: who is on the
 * team and what their role lets them do; which engines have keys and what
 * they charge; where the masters live and how they are named; the Atomik
 * connection (which is not a connection at all — one database); what a
 * new composer opens with and what happens at the cap; and the account.
 *
 * Every figure is the API's. The rate lines are the same estimates the
 * render button shows; the storage line is the ledger's; the roles are
 * the ones the server enforces — admin and member — described in terms of
 * what each can actually do here.
 */
import Link from "next/link";
import { creditsNumber } from "@/lib/price";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MODELS, getModel, estimateCostUsd, estimateTokens, DEFAULT_MODEL_ID } from "@/lib/models";
import { usePrefs, setPrefs } from "@/lib/prefs";
import { useApi } from "@/lib/useApi";
import { usd, compactTokens, timeAgo } from "@/lib/format";
import { appAlert } from "@/components/dialog";
import { Switch } from "@/components/Panel";
import { IconChevron } from "@/components/Icons";
import WorkspaceSettings from "@/components/WorkspaceSettings";
import { usePageTitle } from "@/lib/usePageTitle";
import { useSession, clearPrivateLocal } from "@/lib/session";
import ThemeRow from "@/components/ThemeRow";
import { ParticlMark, Empty } from "@/components/ParticlMark";
import { AtomikMark } from "@/components/AtomikMark";
import { useMoney } from "@/lib/price";

type Me = { name: string; email: string; role: string; owner?: boolean };
type Usage = { spentUsd: number; purchasedUsd: number; remainingUsd: number; promptSpendUsd?: number };
type Credits = { balanceUsd: number; usedUsd: number } | null;
type EngineInfo = {
  id: string; label: string; envKey: string; docs: string; configured: boolean; safety?: string;
  via?: "key" | "gateway" | null;
  models: { id: string; label: string; kind: "video" | "image" }[];
};
type Refiner = { writer: "none" | "byteplus" | "claude"; provider: string; model: string; label: string; via: string; configured: boolean };
type RefinerTest = {
  ok: boolean; ms: number; model?: string; sample?: string; move?: string | null; error?: string;
};
type TeamMember = { id: string; email: string; name: string; role?: string; lastSeen: number | null; disabled: boolean; permanent?: boolean };
type Team = { users: TeamMember[]; canSeeRoles?: boolean };
type Ws = { settings: Record<string, string>; defaults: Record<string, string> };
type IdTerms = { terms: { configured: boolean; trainer: string; trainCostUsd: number } };
type AudioSetup = { configured: boolean; envKey: string; terms: { sfxCredits: number; musicCreditsPerMinute: number }; account: { tier: string } | null };
type Ledger = { storage: { bytes: number; counted: number; unmeasured: number; monthlyUsd: number } | null };
type TopupsView = {
  applies: boolean; provider: "manual" | "stripe" | "razorpay"; canRequest: boolean; openLimit: number;
  credits: { creditUsd: number; granted: number; used: number; balance: number } | null;
  packs: { id: string; label: string; credits: number; usd: number }[];
  requests: { id: string; packId: string; label: string; credits: number; usd: number; status: "requested" | "approved" | "declined" | "cancelled"; note: string; createdAt: number; decidedAt: number | null }[];
  history: { id: string; credits: number; note: string; createdAt: number }[];
};
type Keys = {
  usesPlatformKeys: boolean; mode: "legacy" | "platform" | "own"; canPlatform: boolean; keyring: boolean;
  allowance: { usd: number; spentUsd: number } | null; gatewayMinted: boolean;
  credits: { creditUsd: number; granted: number; used: number; balance: number } | null;
  keys: { name: string; label: string; does: string; set: boolean; masked: string | null }[];
};

const SECTIONS = [
  ["workspace", "Workspace"], ["team", "Team & roles"], ["credits", "Credits"], ["engines", "Vendors & keys"], ["masters", "Storage & masters"],
  ["atomik", "Atomik connection"], ["defaults", "Defaults & caps"], ["account", "Account"],
] as const;
const CAN: Record<string, string> = {
  owner: "owns the workspace — cannot be demoted, disabled or removed · everything an admin can",
  admin: "seats · keys · model routing · Atomik connection · everything a member can",
  member: "generate · train identities · pick and approve takes · file against shots · order the canvas · download masters",
};
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "—";
function gb(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

export default function SettingsPage() {
  usePageTitle("Settings");
  const { signedIn, workspace, role, owner, superAdmin, workspaces } = useSession();
  const money = useMoney();
  const prefs = usePrefs();
  const model = getModel(prefs.modelId);
  const router = useRouter();
  const { data: me } = useApi<Me>(signedIn ? "/api/me" : null);
  const { data: usage } = useApi<Usage>(signedIn ? "/api/usage/summary" : null, 30000);
  const { data: engineData, refresh: refreshEngines } = useApi<{ engines: EngineInfo[]; refiner?: Refiner; gatewayCredits?: Credits }>("/api/engines");
  const { data: topups, refresh: refreshTopups } = useApi<TopupsView>(signedIn ? "/api/workspaces/topups" : null, 30_000);
  const { data: team } = useApi<Team>(signedIn ? "/api/team" : null, 60000);
  const { data: ws, refresh: refreshWs } = useApi<Ws>(signedIn ? "/api/settings" : null, 0);
  const { data: idTerms } = useApi<IdTerms>(signedIn ? "/api/identities" : null, 0);
  const { data: audio } = useApi<AudioSetup>(signedIn ? "/api/audio" : null, 0);
  const { data: ledger } = useApi<Ledger>(signedIn ? "/api/usage" : null, 120000);
  const { data: keys, refresh: refreshKeys } = useApi<Keys>(signedIn && owner ? "/api/workspaces/keys" : null, 0);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<string>("team");
  const [modeBusy, setModeBusy] = useState(false);
  const isAdmin = me?.role === "admin";
  const setting = (k: string) => ws?.settings[k] ?? ws?.defaults[k] ?? "";

  // The index follows the scroll.
  useEffect(() => {
    const els = SECTIONS.map(([id]) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: "-20% 0px -60% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [signedIn]);

  async function saveSetting(key: string, value: string) {
    const res = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); await appAlert("Not saved", j.error ?? `The server answered ${res.status}.`); return; }
    refreshWs();
  }
  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      clearPrivateLocal();
    } catch { /* the cookie may already be gone; leaving is still the intent */ }
    finally { setBusy(false); }
    router.push("/login");
    router.refresh();
  }

  /* The rate lines: the same estimates the render button shows. */
  const seed = estimateCostUsd(DEFAULT_MODEL_ID, "1080p", "16:9", 5);
  const seedTok = estimateTokens("1080p", "16:9", 5);
  /* /api/engines already lists every vendor, fal and ElevenLabs included;
     the rate line is the same estimate the render button shows. */
  const rateFor = (e: EngineInfo): string => {
    const id = e.id.toLowerCase();
    if (id.includes("byteplus") || id.includes("ark")) return seed ? `${money.price(seed.net, DEFAULT_MODEL_ID)} per 5s at 1080P${seedTok && !money.inCredits ? ` (${compactTokens(seedTok)} tok)` : ""}. 10s doubles.` : "Billed per token of output video.";
    if (id.includes("fal")) return `Kling 3.0 from ${money.rate(0.084, "fal-ai/kling-video/v3/standard")} a second · Topaz Astra from ${money.rate(0.30, "topaz/upscale/video/creative")} a second${idTerms?.terms.trainCostUsd ? ` · ~${money.price(idTerms.terms.trainCostUsd, "identity-training")} per identity trained` : ""}.`;
    if (id.includes("eleven")) return audio?.terms ? `${audio.terms.sfxCredits} credits per sound effect · ${audio.terms.musicCreditsPerMinute} per minute of music${audio.account ? ` · ${audio.account.tier} plan` : ""}.` : "Bought in credits; the ledger counts them.";
    if (id.includes("gateway")) return "The prompt writer and Google stills bill here, on the deployment's own credit.";
    if (e.via === "gateway") return "Billed per still through Vercel AI Gateway, on the same credit as the prompt writer.";
    return e.configured ? "Billed by the vendor per render." : "Not routed — its models stay greyed out in the composer.";
  };
  const engines = (engineData?.engines ?? []).map((e) => ({
    id: e.id, name: e.label, does: e.models.map((m) => m.label).join(" · ") || (e.id.toLowerCase().includes("gateway") ? "Prompt writer · Google stills" : "—"),
    on: e.configured, via: e.via, rate: rateFor(e),
  }));
  const usable = MODELS.filter((m) => !m.hidden && (m.supportsTasks ?? ["generate"]).includes("generate"));

  /* Whose key an engine runs on for this workspace: its own, the platform's
     (within the allowance), or — for the studio's own workspace — the
     deployment's, which is not managed here at all. */
  const KEY_OF: Record<string, string> = { byteplus: "ark", google: "gemini", vercel: "gateway", fal: "fal", elevenlabs: "elevenlabs" };
  const mode = keys?.mode ?? "legacy";
  const ownKeyFor = (engineId: string) => Boolean(keys?.keys.find((k) => k.name === KEY_OF[engineId])?.set);
  const ekeyLine = (e: { id: string; on: boolean; via?: "key" | "gateway" | null }) => {
    if (mode === "platform" && !ownKeyFor(e.id)) return e.on ? "ON THE PLATFORM'S KEY · COUNTS AGAINST THE ALLOWANCE" : "NOT ON THE PLATFORM EITHER";
    if (e.via === "gateway" && mode !== "own" && !ownKeyFor(e.id)) return "SIGNED IN AS THE DEPLOYMENT · NO KEY TO KEEP";
    return e.on ? "KEY HELD SEALED ON THE SERVER" : "NO KEY YET";
  };
  async function setMode(next: "platform" | "own") {
    if (!keys || keys.mode === next) return;
    setModeBusy(true);
    try {
      const res = await fetch("/api/workspaces/keys", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      refreshKeys(); refreshEngines();
    } catch (e) { await appAlert("Not changed", (e as Error).message); }
    finally { setModeBusy(false); }
  }

  return (
    <div className="page">
      <div className="page-inner st-grid">
        <nav className="st-index" aria-label="Settings">
          <span className="st-index-h">Settings</span>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className={`st-index-a ${active === id ? "is-on" : ""}`} onClick={() => setActive(id)}>{label}</a>
          ))}
        </nav>

        <div className="flex min-w-0 flex-col gap-5">
          {/* ── Workspace ── */}
          <section id="workspace" className="scard">
            <div className="scard-h"><span>Workspace</span><span>Every workspace has its own database, its own keys and its own team. Nothing in one can be seen from another.</span></div>
            {!signedIn ? <Empty compact title="Sign in to see your workspace" /> : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 max-[900px]:grid-cols-1">
                <div className="srow"><span>This workspace</span><span className="font-medium">{workspace?.name ?? "—"}</span></div>
                <div className="srow"><span>Your standing here</span><span className="mono-v">{role === "owner" ? "OWNER" : role === "admin" ? "ADMIN" : role === "member" ? "MEMBER" : "—"}</span></div>
                <div className="srow"><span>Address</span><span className="mono-v">{workspace ? `/${workspace.slug}` : "—"}</span></div>
                <div className="srow"><span>Your workspaces</span><span className="text-dim">{workspaces.length} · switch or add one from the logo, top-left</span></div>
              </div>
            )}
          </section>

          {/* ── Team & roles ── */}
          <section id="team" className="scard">
            <div className="flex items-baseline justify-between gap-4">
              <div className="scard-h"><span>Team &amp; roles</span><span>{team ? `${team.users.filter((u) => !u.disabled).length} seat${team.users.length === 1 ? "" : "s"}. ` : ""}One owner, who can&rsquo;t be removed; everyone else is an admin or a member. Everyone on the team renders, picks and approves.</span></div>
              <Link href="/team" className="btn-secondary">Invite</Link>
            </div>
            {!signedIn ? <Empty compact title="The team is for the team" line="Sign in to see who is here." /> : (
              <div className="flex flex-col">
                <div className="steam is-head"><span>PERSON</span><span>ROLE</span><span>CAN</span><span className="text-right">LAST SEEN</span></div>
                {(team?.users ?? []).map((u) => (
                  <div key={u.id} className={`steam ${u.disabled ? "opacity-50" : ""}`}>
                    <span className="flex items-center gap-2.5"><span className="ptable-av !ml-0">{initials(u.name)}</span><span className="flex flex-col gap-0.5"><span className="font-medium">{u.name}</span><span className="text-[11.5px] text-dim">{u.email}</span></span></span>
                    <span className="chip-dd !w-[130px] justify-between !py-1.5" title={team?.canSeeRoles ? "Change on the Team page" : "Roles are the owner's to see"}>{u.permanent ? "Owner" : u.role ? u.role[0].toUpperCase() + u.role.slice(1) : "Team member"} <span className="hdr-caret" aria-hidden="true">▼</span></span>
                    <span className="text-lead">{u.permanent ? CAN.owner : CAN[u.role ?? "member"] ?? CAN.member}</span>
                    <span className="mono-s text-right">{u.lastSeen ? timeAgo(u.lastSeen).toUpperCase() : "—"}</span>
                  </div>
                ))}
                {team && team.users.length === 0 && <span className="rail-help">Nobody yet.</span>}
              </div>
            )}
          </section>

          {/* ── Credits ── */}
          <section id="credits" className="scard">
            <div className="scard-h"><span>Credits</span><span>{
              topups?.applies
                ? "What this workspace renders with. Held takes release themselves the moment a pack arrives."
                : "This workspace pays its vendors directly, so there is nothing to top up here."
            }</span></div>
            {topups?.applies && <CreditsCard view={topups} onChanged={refreshTopups} />}
          </section>

          {/* ── Engines & keys ── */}
          <section id="engines" className="scard">
            <div className="scard-h"><span>Vendors &amp; keys</span><span>{
              mode === "platform"
                ? `This workspace runs on the platform's engines and pays in credits${keys?.credits ? `: ${creditsNumber(keys.credits.balance)} left of ${creditsNumber(keys.credits.granted)} granted, one credit being ${usd(keys.credits.creditUsd, 2)} of vendor cost` : ""}${keys?.allowance ? `, within a ${usd(keys.allowance.usd, 0)} monthly cap (${usd(keys.allowance.spentUsd, 2)} used this month)` : ""}. Add your own key for any vendor and it takes over for that vendor; the rest stay on the platform.`
                : mode === "own"
                  ? "This workspace's own keys, sealed on the server and shown only to its owner, and only masked. Costs on the render button come from these routes."
                  : "Keys are set by an admin and never shown here — not even their names. Costs on the render button come from these routes."
            }</span></div>
            {owner && keys && keys.mode !== "legacy" && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] text-dim">Engines run on</span>
                  <span className="inline-flex rounded-[10px] bg-chip p-[3px]" role="radiogroup" aria-label="Whose keys the engines run on">
                    {([["platform", "The platform's keys"], ["own", "My own keys"]] as const).map(([m, label]) => (
                      <button key={m} type="button" role="radio" aria-checked={keys.mode === m}
                        disabled={modeBusy || (m === "platform" && !keys.canPlatform)} onClick={() => setMode(m)}
                        className={`rounded-[8px] px-3 py-1 text-[13px] font-medium transition-colors disabled:cursor-default ${keys.mode === m ? "bg-panel text-ink shadow-[var(--shadow-card)]" : "text-dim"}`}>{label}</button>
                    ))}
                  </span>
                  {keys.gatewayMinted && <span className="mono-s !text-[10.5px]">OWN GATEWAY KEY · MINTED AT SIGN-UP</span>}
                </div>
                {!keys.keyring && <p className="rail-help text-lift">The deployment can&rsquo;t hold keys yet — KEYRING_SECRET is not set.</p>}
                {keys.keys.map((k) => <KeyRow key={k.name} k={k} platform={keys.mode === "platform"} onChanged={() => { refreshKeys(); refreshEngines(); }} />)}
                <span className="rail-help">Keys are sealed before they are stored and never shown again in full. Only you, the owner, can see this card; the team sees only which engines are connected.</span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2.5 max-[900px]:grid-cols-1">
              {engines.map((e) => (
                <div key={e.id} className="ecard">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex flex-col gap-[3px]"><span className="text-[13.5px] font-semibold">{e.name}</span><span className="text-[12px] text-dim">{e.does}</span></span>
                    <span className={`ak-state !text-[10.5px] ${e.on ? "is-approved" : ""}`}><span className={`dot !h-[7px] !w-[7px] ${e.on ? "dot-approved" : "dot-none"}`} />{e.on ? "CONNECTED" : "NOT ROUTED"}</span>
                  </div>
                  <div className="ekey"><span>{ekeyLine(e)}</span>{owner && <span className="text-ink">{mode === "legacy" ? (e.on ? "Rotate in Vercel" : "Add in Vercel") : "Managed above"}</span>}</div>
                  <span className="text-[11.5px] leading-[1.35] text-dim">{e.rate}</span>
                </div>
              ))}
              {!engineData && <span className="rail-help">{signedIn ? "Checking the keys…" : "Sign in to see which engines are connected."}</span>}
            </div>
            <div className="rows">
              {engineData?.refiner
                ? <WriterRow writer={engineData.refiner} credits={engineData.gatewayCredits ?? null} isAdmin={isAdmin} onChanged={refreshEngines} />
                : <div className="row"><span className="text-[14px] text-mute">{signedIn ? "Reading the workspace's choice…" : "Sign in to see who writes the prompts."}</span></div>}
            </div>
            {usage && !money.inCredits && (
              <span className="rail-help">Credit: spent {usd(usage.spentUsd, 2)} all time · added {usd(usage.purchasedUsd, 2)} · remaining {usd(usage.remainingUsd, 2)}. Each vendor&rsquo;s own count is on <Link href="/usage" className="text-ink">Usage</Link>.</span>
            )}
          </section>

          {/* ── Storage & masters ── */}
          <section id="masters" className="scard">
            <div className="scard-h"><span>Storage &amp; masters</span><span>Masters are stored byte-for-byte and never compressed to suit an API. What the engine returned is what you download.</span></div>
            <div className="grid grid-cols-3 gap-2.5 max-[900px]:grid-cols-1">
              <div className="ecard"><span className="mono !tracking-[.12em] !text-[10px]">BUCKET</span><span className="text-[18px] font-semibold">{ledger?.storage ? gb(ledger.storage.bytes) : "—"}</span><span className="text-[12px] leading-[1.4] text-dim">private Blob · {ledger?.storage ? `${ledger.storage.counted.toLocaleString()} files${ledger.storage.unmeasured ? ` (+${ledger.storage.unmeasured} unmeasured)` : ""}${money.inCredits ? "" : ` · ${usd(ledger.storage.monthlyUsd, 2)} a month`}` : "sign in for the count"} · {setting("retentionDays") === "0" || !setting("retentionDays") ? "every take kept, nothing pruned" : `deleted takes pruned after ${setting("retentionDays")} days`}</span></div>
              <div className="ecard"><span className="mono !tracking-[.12em] !text-[10px]">FILE NAMING</span><span className="mono-v !text-[12.5px] !leading-[1.4]">{setting("namingTemplate") || "{project}_{shot}_{version}_{w}x{h}.{ext}"}</span><span className="text-[12px] leading-[1.4] text-dim">Filing against a shot is what gives a take its number and its name.</span></div>
              <div className="ecard"><span className="mono !tracking-[.12em] !text-[10px]">DELIVERY</span><span className="text-[18px] font-semibold">Per shot</span><span className="text-[12px] leading-[1.4] text-dim">Approved masters download one shot at a time from the Canvas. Everyone on the team can download; a derived copy travels only when an API needs one.</span></div>
            </div>
            {signedIn && <WorkspaceSettings isAdmin={isAdmin} />}
          </section>

          {/* ── Atomik connection ── */}
          <section id="atomik" className="scard">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <AtomikMark size={28} />
                <div className="scard-h"><span>Atomik connection</span><span>Idea to shot list happens in Atomik. The shot list arrives here; state and cost go back.</span></div>
              </div>
              <span className="ak-state !text-[10.5px] is-approved"><span className="dot !h-[7px] !w-[7px] dot-approved" />BUILT IN · ONE DATABASE</span>
            </div>
            <div className="grid grid-cols-2 gap-2.5 max-[900px]:grid-cols-1">
              <div className="ecard"><span className="mono !tracking-[.12em] !text-[10px]">ARRIVES FROM ATOMIK →</span><span className="text-[12.5px] leading-[1.5] text-lead">Production and budget cap · shot list in order with planned durations · @cast tags with descriptions and stills · references pinned per shot · setup defaults (look, lens, lighting, mood).</span></div>
              <div className="ecard"><span className="mono !tracking-[.12em] !text-[10px]">← GOES BACK TO ATOMIK</span><span className="text-[12.5px] leading-[1.5] text-lead">Per shot: state (draft · picked · approved) · take count · cost to date · master link once approved. Nothing else leaves; prompts and takes stay here.</span></div>
            </div>
            <div className="flex items-center justify-between gap-4 text-[12px] text-dim">
              <span>Atomik and Particl share one database, so the shot list is live and there is nothing to sync — &ldquo;Send changes&rdquo; on the shot list only clears the edited-since-last-send tint.</span>
              <Link href="/atomik/ideas" className="btn-primary !h-8 !px-3 !text-[12px]">Open Atomik →</Link>
            </div>
          </section>

          {/* ── Defaults & caps ── */}
          <section id="defaults" className="scard">
            <div className="scard-h"><span>Defaults &amp; caps</span><span>What a new composer opens with, and what happens when a production nears its cap. Composer defaults are per browser; the rules are the workspace&rsquo;s.</span></div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 max-[900px]:grid-cols-1">
              <div className="srow"><span>Default engine</span>
                <label className="chip-dd !py-1.5"><select value={prefs.modelId} aria-label="Default engine" onChange={(e) => {
                  const next = getModel(e.target.value);
                  setPrefs({ modelId: next.id, resolution: next.resolutions.includes(prefs.resolution) ? prefs.resolution : next.resolutions[next.resolutions.length - 1], duration: next.durations.includes(prefs.duration) ? prefs.duration : next.durations[0] ?? prefs.duration });
                }}>{usable.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select><span className="hdr-caret" aria-hidden="true">▼</span></label>
              </div>
              <div className="srow"><span>Cost approval rule</span>
                <label className="chip-dd !py-1.5"><select value={setting("approvalRule") || "anyone"} disabled={!isAdmin} aria-label="Cost approval rule" onChange={(e) => saveSetting("approvalRule", e.target.value)}>
                  <option value="anyone">Anyone generates</option><option value="cap">Cap per shot</option><option value="producer">Producer approves</option>
                </select><span className="hdr-caret" aria-hidden="true">▼</span></label>
              </div>
              <div className="srow"><span>Duration · resolution · ratio</span>
                <span className="flex gap-1.5">
                  {model.durations.length > 0 && <label className="chip-dd !py-1.5"><select value={prefs.duration} aria-label="Duration" onChange={(e) => setPrefs({ duration: Number(e.target.value) })}>{model.durations.map((d) => <option key={d} value={d}>{d}s</option>)}</select></label>}
                  <label className="chip-dd !py-1.5"><select value={prefs.resolution} aria-label="Resolution" onChange={(e) => setPrefs({ resolution: e.target.value })}>{model.resolutions.map((r) => <option key={r} value={r}>{r.toUpperCase()}</option>)}</select></label>
                  <span className="chip-dd is-muted !py-1.5">16:9</span>
                </span>
              </div>
              <div className="srow"><span>Warn the producer at</span>
                <label className="chip-dd !py-1.5"><select value={setting("capWarnPct") || "80"} disabled={!isAdmin} aria-label="Warn at" onChange={(e) => saveSetting("capWarnPct", e.target.value)}>
                  {[50, 70, 80, 90, 100].map((p) => <option key={p} value={String(p)}>{p}% OF CAP</option>)}
                </select><span className="hdr-caret" aria-hidden="true">▼</span></label>
              </div>
              <div className="srow"><span>Seedance audio on new takes</span>
                <button type="button" className={`tgl !h-4 !w-[30px] ${prefs.audio ? "is-on" : ""}`} role="switch" aria-checked={prefs.audio} aria-label="Seedance audio on new renders" onClick={() => setPrefs({ audio: !prefs.audio })} />
              </div>
              <div className="srow"><span>At the cap</span>
                <label className="chip-dd !py-1.5"><select value={setting("atCap") || "producer"} disabled={!isAdmin} aria-label="At the cap" onChange={(e) => saveSetting("atCap", e.target.value)}>
                  <option value="producer">Producer unlocks</option><option value="stop">Rendering stops</option><option value="warn">Warning only</option>
                </select><span className="hdr-caret" aria-hidden="true">▼</span></label>
              </div>
            </div>
            <span className="rail-help">A production&rsquo;s cap is set on its page, in {money.inCredits ? "credits" : "dollars"}. These rules apply at the cost check whenever a production has one; the workspace balance is the hard stop above them.</span>
          </section>

          {/* ── Account ── */}
          <section id="account" className="scard">
            <div className="scard-h"><span>Account</span><span>{me ? `Signed in as ${me.name} · ${me.email}` : signedIn ? "…" : "Signed out — the interface is open to browse."}</span></div>
            <div className="rows">
              <ThemeRow />
              <PushRow />
              <button className="row" onClick={() => router.push("/connect")}>Connect apps &amp; tokens<span className="row-value">Claude · ChatGPT · CLI<IconChevron className="!text-mute" /></span></button>
              <button className="row" onClick={() => router.push("/platform")}>Platform<span className="row-value">Assets · APIs · security · IP<IconChevron className="!text-mute" /></span></button>
              {superAdmin && <button className="row" onClick={() => router.push("/admin")}>Sign-ups &amp; workspaces<span className="row-value">Platform owner<IconChevron className="!text-mute" /></span></button>}
              {me?.owner && <a className="row" href="/api/export" download title="Every prompt, cost and account record, as JSON — the owner's alone">Export data<span className="row-value">JSON · owner</span></a>}
              {signedIn && <button className="row !text-lift" onClick={signOut} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</button>}
            </div>
            <div className="flex items-center gap-2 text-[12px] text-mute"><ParticlMark size={12} className="text-mute/70" /><span>particl studio · Seedance on BytePlus ModelArk · Nano Banana through Vercel AI Gateway</span></div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** One vendor's key: what it does, whether it is set, and a field to set or rotate it. */
function KeyRow({ k, platform = false, onChanged }: { k: Keys["keys"][number]; platform?: boolean; onChanged: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  async function save() {
    if (!value.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/workspaces/keys", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: k.name, value: value.trim() }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      setValue(""); setEditing(false); onChanged();
    } catch (e) { await appAlert("Not saved", (e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try {
      await fetch("/api/workspaces/keys", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: k.name }) });
      onChanged();
    } finally { setBusy(false); }
  }
  return (
    <div className="ecard !gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-[3px]"><span className="text-[13.5px] font-semibold">{k.label}</span><span className="text-[12px] text-dim">{k.does}</span></span>
        <span className={`ak-state !text-[10.5px] ${k.set ? "is-approved" : ""}`}><span className={`dot !h-[7px] !w-[7px] ${k.set ? "dot-approved" : "dot-none"}`} />{k.set ? `SET · ${k.masked}` : platform ? "PLATFORM'S KEY" : "NOT SET"}</span>
      </div>
      {editing ? (
        <div className="flex gap-1.5">
          <input className="ctl !h-9 flex-1 font-mono !text-[12px]" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} placeholder={`Paste the ${k.label} key`} autoFocus />
          <button type="button" className="btn-primary !h-9 !px-3 !text-[12px]" onClick={save} disabled={busy || !value.trim()}>{k.set ? "Rotate" : "Save"}</button>
          <button type="button" className="btn-secondary !h-9 !px-3 !text-[12px]" onClick={() => { setEditing(false); setValue(""); }}>Cancel</button>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <button type="button" className="btn-secondary !h-8 !px-3 !text-[12px]" onClick={() => setEditing(true)}>{k.set ? "Rotate" : platform ? "Use my own" : "Add key"}</button>
          {k.set && <button type="button" className="btn-secondary !h-8 !px-3 !text-[12px] text-lift" onClick={remove} disabled={busy}>Remove</button>}
        </div>
      )}
    </div>
  );
}

/**
 * The workspace's writer, as a three-way choice, and a way to hear it answer.
 * Through Vercel AI Gateway the credentials are the deployment's own, so the
 * one thing that can still be missing is credit on the gateway — which is
 * exactly what a test call reports in plain words.
 */
const WRITERS: { id: Refiner["writer"]; label: string; blurb: string }[] = [
  { id: "none", label: "Pro", blurb: "No rewriting. Your words reach the engine exactly as written." },
  { id: "byteplus", label: "Seedream", blurb: "ByteDance's own text model finishes thin ideas, on the ModelArk key." },
  { id: "claude", label: "Claude Opus 5", blurb: "Anthropic's Opus 5 finishes thin ideas, through Vercel AI Gateway." },
];

function WriterRow({ writer, credits, isAdmin, onChanged }: { writer: Refiner; credits: Credits; isAdmin: boolean; onChanged: () => void }) {
  const money = useMoney();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<RefinerTest | null>(null);
  const current = WRITERS.find((w) => w.id === writer.writer) ?? WRITERS[2];

  async function choose(id: Refiner["writer"]) {
    if (!isAdmin || saving || id === writer.writer) return;
    setSaving(true); setResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptWriter: id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't save that");
      onChanged();
    } catch (e) {
      await appAlert("Couldn't change the writer", (e as Error).message);
    } finally { setSaving(false); }
  }

  async function test() {
    setBusy(true); setResult(null);
    try {
      const res = await fetch("/api/engines/test", { method: "POST" });
      setResult(await res.json());
    } catch (e) {
      setResult({ ok: false, ms: 0, error: (e as Error).message });
    } finally { setBusy(false); }
  }

  return (
    <div className="row !block py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1">
          Prompt writer
          <span className="mt-0.5 block text-[12px] leading-snug text-mute">
            {current.blurb}{writer.writer !== "none" ? ` Currently ${writer.label} · ${writer.via}.` : ""}
            {credits && writer.writer === "claude" && !money.inCredits && (
              <> Gateway credit: <span className="text-dim">{usd(credits.balanceUsd, 2)}</span> left, {usd(credits.usedUsd, 3)} used.</>
            )}
          </span>
        </span>
        <span className="inline-flex rounded-[10px] bg-chip p-[3px]" role="radiogroup" aria-label="Prompt writer">
          {WRITERS.map((w) => {
            const on = writer.writer === w.id;
            return (
              <button key={w.id} type="button" role="radio" aria-checked={on}
                disabled={!isAdmin || saving}
                onClick={() => choose(w.id)}
                className={`rounded-[8px] px-3 py-1 text-[13px] font-medium transition-colors disabled:cursor-default ${
                  on ? "bg-panel text-ink shadow-[var(--shadow-card)]" : "text-dim"
                }`}>
                {w.label}
              </button>
            );
          })}
        </span>
      </div>
      {(isAdmin || result) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          {isAdmin && writer.writer !== "none" && (
            <button type="button" onClick={test} disabled={busy}
              className="chip !py-1.5 !text-[13px] !text-blue disabled:opacity-50">
              {busy ? "Asking…" : "Test the writer"}
            </button>
          )}
          {!writer.configured && writer.writer !== "none" && (
            <span className="text-[12.5px] text-warn">Not reachable from this deployment.</span>
          )}
          {result && (
            <span className={`text-[12.5px] leading-snug ${result.ok ? "text-dim" : "text-lift"}`}>
              {result.ok
                ? <>{result.ms ? `Answered in ${(result.ms / 1000).toFixed(1)}s` : ""}{result.move ? `, chose “${result.move}”` : ""}{result.ms ? ": " : ""}<span className="italic">{result.sample}</span></>
                : result.error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** A row that steps through its options in place — no drill-in for three items. */

/* ── Push notifications ───────────────────────────────────────────────── */

const PUSH_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function urlB64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function PushRow() {
  type PushState = "off" | "on" | "busy" | "denied" | "install" | "unconfigured" | "unsupported";
  // Starts "off" on both server and client — anything read from `navigator`
  // during render would hydrate differently than it rendered.
  const [state, setState] = useState<PushState>("off");

  useEffect(() => {
    let alive = true;
    // A microtask boundary keeps this out of the render pass entirely.
    Promise.resolve().then(async () => {
      if (!("serviceWorker" in navigator && "PushManager" in window)) {
        const ios = /iP(hone|ad|od)/.test(navigator.userAgent) &&
          !matchMedia("(display-mode: standalone)").matches;
        if (alive) setState(ios ? "install" : "unsupported");
        return;
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
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(PUSH_KEY),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "The server rejected it.");
      setState("on");
    } catch (e) {
      appAlert("Couldn't turn on notifications", (e as Error).message);
      setState(PUSH_KEY ? "off" : "unconfigured");
    }
  }

  async function disable() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("off");
    } catch (e) {
      // The old code set "off" in a finally, so a failed unsubscribe showed
      // the toggle off while the device kept receiving pushes.
      setState("on");
      await appAlert("Notifications are still on", (e as Error).message);
    }
  }

  if (state === "unsupported") return null;

  const note =
    state === "denied" ? "Blocked in your browser's settings"
    : state === "install" ? "Add Particl to your Home Screen first"
    : state === "unconfigured" ? "Not set up on this deployment" : null;

  return (
    <div className="row">
      <span className="flex flex-col">
        Chat notifications
        {note && <span className="text-[13px] text-mute">{note}</span>}
      </span>
      <span className="row-value">
        {note ? (
          <button
            className="text-[15px] text-blue"
            onClick={() => appAlert(
              state === "denied" ? "Notifications are blocked"
                : state === "install" ? "Install the app first" : "Push isn't set up",
              state === "denied"
                ? "Allow notifications for this site in your browser's settings, then come back here."
                : state === "install"
                  ? "On iPhone, notifications only reach the installed app. Tap Share, then Add to Home Screen, open Particl from the icon, and turn this on there."
                  : "Push notifications aren't set up on this deployment — contact management."
            )}
          >
            Why?
          </button>
        ) : (
          <Switch
            checked={state === "on"}
            disabled={state === "busy"}
            onChange={(v) => (v ? enable() : disable())}
          />
        )}
      </span>
    </div>
  );
}

/**
 * The top-up screen: the balance, the packs, and the one dollar figure the
 * product ever shows a workspace — the price of a pack. Asking for one
 * queues a request for the platform; the credits arrive when it is answered.
 */
function CreditsCard({ view, onChanged }: { view: TopupsView; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const open = view.requests.filter((r) => r.status === "requested");
  const cr = view.credits;
  async function ask(packId: string) {
    setBusy(packId); setErr(null);
    try {
      const res = await fetch("/api/workspaces/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packId }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not ask for it");
      if (json.checkout?.kind === "redirect" && json.checkout.url) { window.location.assign(json.checkout.url); return; }
      onChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }
  async function cancel(id: string) {
    setBusy(id); setErr(null);
    try {
      const res = await fetch(`/api/workspaces/topups?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not cancel it");
      onChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }
  const when = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return (
    <div className="flex flex-col gap-4">
      {cr && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{creditsNumber(cr.balance)} credits</span>
          <span className="text-[13px] text-dim">left · {creditsNumber(cr.used)} used of {creditsNumber(cr.granted)} added</span>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        {view.packs.map((p) => (
          <div key={p.id} className="ecard !gap-1.5">
            <span className="mono !tracking-[.12em] !text-[10px]">{p.label.toUpperCase()}</span>
            <span className="text-[20px] font-semibold tabular-nums">{p.credits.toLocaleString("en-US")} credits</span>
            <span className="text-[13px] text-dim">${p.usd.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</span>
            {view.canRequest && (
              <button type="button" className="btn-primary mt-1 !h-8 !px-3.5 !text-[12.5px]" disabled={busy != null || open.length >= view.openLimit} onClick={() => ask(p.id)}>
                {busy === p.id ? "Asking…" : view.provider === "manual" ? "Request" : "Buy"}
              </button>
            )}
          </div>
        ))}
      </div>
      {!view.canRequest && <span className="rail-help">The owner or an admin asks for a pack.</span>}
      {view.provider === "manual" && view.canRequest && (
        <span className="rail-help">A request goes to the platform; the credits arrive once it is answered, and anything held releases itself.</span>
      )}
      {err && <span className="text-[13px] text-lift">{err}</span>}
      {open.length > 0 && (
        <div className="flex flex-col">
          {open.map((r) => (
            <div key={r.id} className="steam !grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_90px]">
              <span className="flex flex-col gap-0.5"><span className="font-medium">{r.label} · {r.credits.toLocaleString("en-US")} credits</span><span className="text-[11.5px] text-dim">asked {when(r.createdAt)} · waiting for the platform</span></span>
              <span className="mono-v">${r.usd.toLocaleString("en-US")}</span>
              <button type="button" className="btn-secondary !h-7 !px-2.5 !text-[12px]" disabled={busy != null} onClick={() => cancel(r.id)}>Cancel</button>
            </div>
          ))}
        </div>
      )}
      {view.history.length > 0 && (
        <div className="flex flex-col">
          <div className="steam is-head !grid-cols-[minmax(0,1.5fr)_110px_90px]"><span>ADDED</span><span className="text-right">CREDITS</span><span className="text-right">WHEN</span></div>
          {view.history.map((g) => (
            <div key={g.id} className="steam !grid-cols-[minmax(0,1.5fr)_110px_90px]">
              <span className="truncate">{g.note || "Credits"}</span>
              <span className={`mono-v text-right ${g.credits < 0 ? "text-lift" : ""}`}>{g.credits > 0 ? "+" : ""}{Math.round(g.credits).toLocaleString("en-US")}</span>
              <span className="mono-s text-right">{when(g.createdAt).toUpperCase()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
