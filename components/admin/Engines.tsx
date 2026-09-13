"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { usePhone } from "@/lib/usePhone";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { MODELS } from "@/lib/models";
import { Mono, StateDot, Switch } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { appPrompt } from "@/components/dialog";
import Loader from "@/components/atomik/Loader";
import { Card, ROW, Nothing } from "./Card";
import { call } from "./api";
import { fmtPct, roomText } from "./adminFormat";
import type { EnginesView, Provider } from "./types";

/**
 * Engines (SOW surfaces board 12h, block 2): one 48px row per PROVIDER
 * from the registry — a dot, the label, `N% ERRORS`, the room under the
 * vendor's ceiling (an em dash until a ceiling is declared; nobody types
 * a vendor's number here), the seven-day margin, and the switch. The dot
 * is ink when the engine is healthy and `--ink-muted` when a fifth of its
 * week failed — never the accent, which means done. Off is dashed, with
 * the reason in `--ink-body` beneath. Flipping a switch off asks why, and
 * the reason is what every composer reads; the refusal itself lives where
 * money starts (lib/meter.ts), not here.
 */
const WARN_AT = 0.2;

function rowsOf(data: EnginesView, peaks: Record<string, number>): Provider[] {
  if (data.providers) return data.providers;
  /* A route a version behind: the week's health grouped by provider, every switch on. */
  return PROVIDERS.map((p) => {
    const wk = data.week.filter((h) => h.engine === p.id);
    const jobs = wk.reduce((a, h) => a + h.jobs, 0);
    const failed = wk.reduce((a, h) => a + h.failed, 0);
    return {
      id: p.id, label: p.label, short: p.short, models: MODELS.filter((m) => m.provider === p.id).map((m) => m.id), configured: true,
      on: true, reason: null, jobs7d: jobs, failed7d: failed, failRate7d: jobs ? failed / jobs : 0, running: wk.reduce((a, h) => a + h.running, 0),
      peak30d: peaks[p.id] ?? 0, concurrent: null, room: null, marginPct7d: null,
    };
  });
}

export default function Engines({ peaks = {} }: { peaks?: Record<string, number> }) {
  const { data, refresh } = useApi<EnginesView>("/api/admin/engines", 60_000);
  const toast = useToast();
  const phone = usePhone();
  const [busy, setBusy] = useState<ProviderId | null>(null);

  async function flip(p: Provider, on: boolean) {
    let reason: string | undefined;
    if (!on) {
      const said = await appPrompt(`Pause ${p.label} everywhere? Say why — every composer reads it.`, p.reason ?? "", "Vendor incident");
      if (said === null) return;
      reason = said;
    }
    setBusy(p.id);
    try {
      await call("/api/admin/engines", "PATCH", on ? { id: p.id, on: true } : { id: p.id, on: false, reason });
      toast(on ? `${p.label} is back on` : `${p.label} paused`);
      refresh();
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  }

  const rows = data ? rowsOf(data, peaks) : null;
  return (
    <Card title="Engines" line="one switch stops one engine everywhere" label="Engines">
      {!rows && <span className="flex min-h-[48px] items-center justify-center border-t border-[rgba(245,246,248,.07)]"><Loader size={36} label="Reading the engines" /></span>}
      {rows && rows.length === 0 && <Nothing>No engine is registered.</Nothing>}
      {rows?.map((p) => {
        const warn = p.on && p.jobs7d > 0 && p.failRate7d > WARN_AT;
        const dot = !p.on ? <StateDot state="queued" size={8} /> : warn
          ? <span aria-hidden="true" className="inline-block h-[8px] w-[8px] flex-none rounded-full bg-ink-muted" data-dot="warn" />
          : <StateDot state="picked" size={8} />;
        const room = roomText(p.room);
        const errors = p.jobs7d > 0 ? `${Math.round(p.failRate7d * 100)}% errors` : "no jobs";
        const under = p.marginPct7d != null && p.marginPct7d < 0.1;
        const readouts = (
          <>
            <Mono tone={warn ? "ink" : "muted"} className="whitespace-nowrap">{errors}</Mono>
            <Mono tone={room.near ? "ink" : "muted"} className="whitespace-nowrap">{room.text}{p.room == null && p.peak30d > 0 ? ` · peak ${p.peak30d}` : ""}</Mono>
            <Mono tone={under ? "ink" : "muted"} className="whitespace-nowrap">margin 7d {fmtPct(p.marginPct7d)}</Mono>
          </>
        );
        const sw = <Switch on={p.on} disabled={busy === p.id} label={`${p.label} on`} onChange={(v) => flip(p, v)} className="justify-self-end" />;
        return (
          <span key={p.id} className="flex flex-col" data-engine={p.id}>
            {phone ? (
              <span className={`${ROW} grid-cols-[minmax(0,1fr)_40px] gap-[12px] py-[8px]`}>
                <span className="flex min-w-0 flex-col gap-[6px]">
                  <span className="flex items-center gap-[8px]">{dot}<span className="truncate">{p.label}</span></span>
                  <span className="flex flex-wrap gap-x-[10px] gap-y-[4px]">{readouts}</span>
                </span>
                {sw}
              </span>
            ) : (
              <span className={`${ROW} grid-cols-[minmax(0,1fr)_100px_120px_120px_40px] gap-[12px]`}>
                <span className="flex min-w-0 items-center gap-[8px]">{dot}<span className="truncate">{p.label}</span></span>
                {readouts}
                {sw}
              </span>
            )}
            {!p.on && <span className="pb-[10px] text-[13px] leading-[1.4] text-ink-body">Paused{p.reason ? ` · ${p.reason}` : ""}</span>}
          </span>
        );
      })}
    </Card>
  );
}
