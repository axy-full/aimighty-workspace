"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { usePhone } from "@/lib/usePhone";
import { timeAgo } from "@/lib/format";
import { REASON_LABELS } from "@/lib/reports";
import { getModel } from "@/lib/models";
import { PREVIEW_MODELS, PREVIEW_RESOLUTIONS, PREVIEW_DURATIONS } from "@/lib/previews";
import { Button, Mono } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { appConfirm } from "@/components/dialog";
import Loader from "@/components/atomik/Loader";
import { Card, ROW, Nothing, FIELD, FIELD_LABEL } from "./Card";
import { call } from "./api";

/**
 * The v1 desk's remaining levers, rehomed as `--card` blocks under the
 * board's four (SOW surfaces board 12h): top-ups to approve or decline,
 * what was reported, and the camera previews batch. Same routes, same
 * bodies; every button a secondary — the desk's one primary is `Send N
 * codes`. Nothing here calls a vendor except the previews batch, which
 * stays gated on the test workspace and confirms its cost first. While a
 * block's route is in flight it shows the 36px ring — the only loader.
 */

/* ── Top-ups ─────────────────────────────────────────────────────────── */
type Queue = { provider: "manual" | "stripe" | "razorpay"; open: QueueRow[]; decided: QueueRow[] };
type QueueRow = {
  id: string; workspaceId: string; workspaceName: string; workspaceSlug: string; packId: string; label: string;
  credits: number; bonus: number; usd: number; status: "requested" | "approved" | "declined" | "cancelled"; note: string;
  requesterEmail: string | null; requesterName: string | null; createdAt: number; decidedAt: number | null;
};

export function TopupsCard({ onChanged }: { onChanged: () => void }) {
  const { data, refresh } = useApi<Queue>("/api/admin/topups", 30_000);
  const toast = useToast();
  const phone = usePhone();
  const [busy, setBusy] = useState<string | null>(null);
  async function decide(r: QueueRow, action: "approve" | "decline") {
    if (action === "decline" && !(await appConfirm("Decline this request?", "The workspace keeps its balance as it is; they can ask again.", { confirmLabel: "Decline", danger: true }))) return;
    setBusy(`${r.id}:${action}`);
    try {
      const j = await call<{ request: { credits: number; bonus?: number }; released?: number }>("/api/admin/topups", "PATCH", { id: r.id, action });
      if (action === "approve") {
        const arrived = (j.request.credits + (j.request.bonus ?? 0)).toLocaleString("en-US");
        toast(j.released ? `${arrived} cr in · ${j.released} held ${j.released === 1 ? "take" : "takes"} released` : `${arrived} cr in`);
      } else toast("Declined");
      refresh(); onChanged();
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  }
  const grid = "grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_130px_90px_190px] gap-[12px]";
  return (
    <Card title="Top-ups" label="Top-ups" line={data?.provider === "manual" ? "take payment your own way, then approve: the credits go in at once" : data ? `card checkout through ${data.provider} approves these; this is the record` : undefined}>
      {!data && <span className="flex min-h-[48px] items-center justify-center border-t border-[rgba(245,246,248,.07)]"><Loader size={36} label="Reading top-ups" /></span>}
      {data && data.open.length === 0 && <Nothing>Nothing waiting.</Nothing>}
      {data?.open.map((r) => (
        <span key={r.id} className={`${ROW} ${phone ? "grid-cols-1 gap-[8px] py-[10px]" : grid}`}>
          <span className="flex min-w-0 flex-col gap-[4px]"><span className="truncate font-medium">{r.workspaceName}</span><span className="truncate text-[12.5px] text-ink-muted">{r.note || r.workspaceSlug}</span></span>
          <span className="flex min-w-0 flex-col gap-[4px]"><span className="truncate">{r.requesterName ?? "—"}</span><span className="truncate text-[12.5px] text-ink-muted">{r.requesterEmail ?? ""}</span></span>
          <span className="flex min-w-0 flex-col gap-[4px]"><Mono cost tone="ink">{(r.credits + r.bonus).toLocaleString("en-US")} cr</Mono><span className="truncate text-[12.5px] text-ink-muted">{r.label} · ${r.usd.toLocaleString("en-US")}{r.bonus > 0 ? ` · ${r.bonus.toLocaleString("en-US")} free` : ""}</span></span>
          <Mono cost className={phone ? "" : "text-right"}>{timeAgo(r.createdAt)}</Mono>
          <span className={`flex gap-[8px] ${phone ? "" : "justify-end"}`}>
            <Button variant="secondary" placement="desk" muted disabled={busy != null} busy={busy === `${r.id}:decline`} busyLabel="Declining" onClick={() => decide(r, "decline")}>Decline</Button>
            <Button variant="secondary" placement="desk" disabled={busy != null} busy={busy === `${r.id}:approve`} busyLabel="Approving" onClick={() => decide(r, "approve")}>Approve</Button>
          </span>
        </span>
      ))}
      {data?.decided.slice(0, 8).map((r) => (
        <span key={r.id} className={`${ROW} ${phone ? "grid-cols-[minmax(0,1fr)_auto] gap-[8px]" : grid} text-ink-body`}>
          <span className="truncate">{r.workspaceName}</span>
          {!phone && <span className="truncate text-ink-muted">{r.requesterName ?? "—"}</span>}
          {!phone && <Mono cost>{(r.credits + r.bonus).toLocaleString("en-US")} cr</Mono>}
          {!phone && <Mono cost className="text-right">{r.decidedAt ? timeAgo(r.decidedAt) : ""}</Mono>}
          <Mono cost className="text-right">{r.status}</Mono>
        </span>
      ))}
    </Card>
  );
}

/* ── Reports ─────────────────────────────────────────────────────────── */
type Report = { id: string; url: string; reason: string; details: string; email: string | null; workspace: { id: string; name: string; slug: string } | null; accountEmail: string | null; createdAt: number; handledAt: number | null };

export function ReportsCard() {
  const { data, refresh } = useApi<{ open: Report[]; handled: Report[] }>("/api/admin/reports", 30_000);
  const toast = useToast();
  const phone = usePhone();
  const [busy, setBusy] = useState<string | null>(null);
  async function handled(id: string) {
    setBusy(id);
    try { await call("/api/admin/reports", "PATCH", { id }); toast("Handled"); refresh(); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  }
  const label = (r: string) => (REASON_LABELS as Record<string, string>)[r] ?? r;
  const grid = "grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_90px_110px] gap-[12px]";
  return (
    <Card title="Reports" label="Reports" line="open first · act on the studio's row, then mark it handled">
      {!data && <span className="flex min-h-[48px] items-center justify-center border-t border-[rgba(245,246,248,.07)]"><Loader size={36} label="Reading reports" /></span>}
      {data && data.open.length === 0 && <Nothing>Nothing reported.</Nothing>}
      {data?.open.map((r) => (
        <span key={r.id} className={`${ROW} ${phone ? "grid-cols-1 gap-[8px] py-[10px]" : grid} py-[8px]`}>
          <span className="flex min-w-0 flex-col gap-[4px]"><span className="font-medium">{label(r.reason)}</span><span className="break-all text-[12.5px] leading-[1.3] text-ink-muted">{r.url}</span>{r.details && <span className="text-[12.5px] leading-[1.4] text-ink-body">{r.details}</span>}</span>
          <span className="flex min-w-0 flex-col gap-[4px]"><span className="truncate">{r.workspace?.name ?? "—"}</span><span className="truncate text-[12.5px] text-ink-muted">{r.email ?? r.accountEmail ?? "no reply address"}</span></span>
          <Mono cost className={phone ? "" : "text-right"}>{timeAgo(r.createdAt)}</Mono>
          <span className={`flex ${phone ? "" : "justify-end"}`}><Button variant="secondary" placement="desk" disabled={busy != null} busy={busy === r.id} busyLabel="Marking" onClick={() => handled(r.id)}>Handled</Button></span>
        </span>
      ))}
      {data?.handled.slice(0, 5).map((r) => (
        <span key={r.id} className={`${ROW} ${phone ? "grid-cols-[minmax(0,1fr)_auto] gap-[8px]" : grid} text-ink-body`}>
          <span className="truncate">{label(r.reason)} <span className="text-ink-muted">· {r.url}</span></span>
          {!phone && <span className="truncate">{r.workspace?.name ?? "—"}</span>}
          {!phone && <Mono cost className="text-right">{r.handledAt ? timeAgo(r.handledAt) : ""}</Mono>}
          <Mono cost className="text-right">handled</Mono>
        </span>
      ))}
    </Card>
  );
}

/* ── Camera previews: one costed batch from the test workspace ───────── */
type PreviewsView = {
  plan: { modelId: string; resolution: string; duration: number; count: number; perClipUsd: number; totalUsd: number; perClipCredits: number; totalCredits: number; items: { key: string; label: string; kind: string }[] };
  scene: string;
  workspace: { id: string; name: string; internalTest: boolean } | null;
  candidates: { genId: string; key: string; model: string; costUsd: number | null; status: string; createdAt: number }[];
  assets: { key: string; bytes: number; model: string | null; costUsd: number | null; createdAt: number }[];
};

export function PreviewsCard() {
  const [model, setModel] = useState<string>(PREVIEW_MODELS[0]);
  const [resolution, setResolution] = useState<string>(PREVIEW_RESOLUTIONS[0]);
  const [duration, setDuration] = useState<number>(PREVIEW_DURATIONS[0]);
  const q = `model=${encodeURIComponent(model)}&resolution=${resolution}&duration=${duration}`;
  const { data, refresh } = useApi<PreviewsView>(`/api/admin/previews?${q}`, 0);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; failed: number } | null>(null);
  const plan = data?.plan ?? null;
  const workspace = data?.workspace ?? null;
  const candidates = data?.candidates ?? [];
  const assets = data?.assets ?? [];
  const ready = candidates.filter((c) => c.status === "succeeded").length;
  const running = candidates.filter((c) => c.status === "running" || c.status === "held").length;
  const testOk = Boolean(workspace?.internalTest);

  async function generate() {
    if (!data || !plan || !workspace || !testOk) return;
    const ok = await appConfirm(
      `Render ${plan.count} previews in ${workspace.name} for $${plan.totalUsd.toFixed(2)}?`,
      `${plan.count} clips × $${plan.perClipUsd.toFixed(3)} at ${getModel(plan.modelId).label}, ${plan.resolution}, ${plan.duration}s, silent. ${assets.length ? `${assets.length} previews are already published; publishing again replaces them.` : "This runs once for the whole platform."}`,
      { confirmLabel: `Spend $${plan.totalUsd.toFixed(2)}`, danger: true },
    );
    if (!ok) return;
    setBusy("generate"); setProgress({ done: 0, failed: 0 });
    let done = 0, failed = 0;
    for (const item of plan.items) {
      try {
        const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          prompt: data.scene, model: plan.modelId, resolution: plan.resolution, ratio: "16:9", duration: plan.duration, generateAudio: false,
          shotSpec: { [item.kind]: item.key.split(":")[1] }, previewFor: item.key, projectId: null,
        }) });
        if (!res.ok) failed++; else done++;
      } catch { failed++; }
      setProgress({ done, failed });
    }
    setBusy(null); refresh();
    toast(`${done} rendered${failed ? ` · ${failed} failed` : ""}`);
  }
  async function publish() {
    setBusy("publish");
    try {
      const j = await call<{ published?: unknown[]; failed?: unknown[] }>("/api/admin/previews", "POST", { action: "publish" });
      toast(`${(j.published ?? []).length} previews published${(j.failed ?? []).length ? ` · ${(j.failed ?? []).length} did not copy` : ""}`);
      refresh();
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <Card title="Camera previews" label="Camera previews" line="one neutral clip per move and technique, rendered once from the test workspace">
      <div className="grid grid-cols-3 gap-[10px] border-t border-[rgba(245,246,248,.07)] pt-[12px] max-md:grid-cols-1">
        <label className={FIELD_LABEL}>Engine
          <select className={FIELD} value={model} onChange={(e) => setModel(e.target.value)}>
            {PREVIEW_MODELS.map((m) => <option key={m} value={m}>{getModel(m).label}</option>)}
          </select>
        </label>
        <label className={FIELD_LABEL}>Resolution
          <select className={FIELD} value={resolution} onChange={(e) => setResolution(e.target.value)}>
            {PREVIEW_RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className={FIELD_LABEL}>Seconds
          <select className={FIELD} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {PREVIEW_DURATIONS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
      </div>
      {plan && (
        <span className="flex flex-wrap items-center gap-x-[14px] gap-y-[6px] pt-[12px] text-[13px] leading-[1.4]">
          <span className="font-medium text-ink">{plan.count} clips × ${plan.perClipUsd.toFixed(3)} = ${plan.totalUsd.toFixed(2)}</span>
          <Mono cost>≈ {plan.totalCredits.toLocaleString("en-US")} cr at the engine&rsquo;s price</Mono>
          <span className="text-ink-body">{workspace ? (testOk ? `From ${workspace.name} (the test workspace)` : `${workspace.name} is not the test workspace — switch to it, or mark one in Studios`) : "No workspace"}</span>
        </span>
      )}
      <span className="flex flex-wrap items-center gap-[8px] pt-[12px]">
        <Button variant="secondary" placement="desk" disabled={!plan || !testOk || busy != null} busy={busy === "generate"} busyLabel={progress ? `Rendering ${progress.done + progress.failed} of ${plan?.count ?? 0}` : "Rendering"} onClick={generate}>
          Render {plan?.count ?? 0} previews
        </Button>
        <Button variant="secondary" placement="desk" muted disabled={!testOk || busy != null || !ready} busy={busy === "publish"} busyLabel="Publishing" onClick={publish}>Publish {ready} ready</Button>
        {running > 0 && <Mono cost>{running} still rendering</Mono>}
        <Mono cost className="ml-auto">{assets.length} of {plan?.count ?? 0} published</Mono>
      </span>
      {assets.length > 0 && <span className="pt-[8px] text-[12.5px] leading-[1.5] text-ink-muted">Published: {assets.map((a) => a.key).join(" · ")}</span>}
    </Card>
  );
}
