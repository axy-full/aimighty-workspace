"use client";

import {
  MODELS, getModel, estimateCostUsd, estimateTokens, dimensionsFor, ACCOUNT_DISCOUNT,
} from "@/lib/models";
import { usd, compactTokens } from "@/lib/format";
import { Panel, Row, Group, Switch } from "./Panel";

export type Params = {
  modelId: string; ratio: string; resolution: string; duration: number;
  watermark: boolean; generateAudio: boolean; seed: string;
};

export default function Inspector({
  params, patch, projects, projectId, setProjectId, lockedProjectId,
  onRender, busy, canRender, inputSeconds = 0, hasVideoInput = false,
}: {
  params: Params;
  patch: (p: Partial<Params>) => void;
  projects: { id: string; name: string }[];
  projectId: string;
  setProjectId: (v: string) => void;
  lockedProjectId?: string;
  onRender: () => void;
  busy: boolean;
  canRender: boolean;
  /** Combined duration of attached reference videos, if any. */
  inputSeconds?: number;
  hasVideoInput?: boolean;
}) {
  const model = getModel(params.modelId);
  const est = estimateCostUsd(
    params.modelId, params.resolution, params.ratio, params.duration,
    inputSeconds, hasVideoInput
  );
  const tokens = estimateTokens(params.resolution, params.ratio, params.duration, inputSeconds);
  const dims = dimensionsFor(params.resolution, params.ratio);

  function switchModel(next: string) {
    const m = getModel(next);
    patch({
      modelId: next,
      ratio: m.ratios.includes(params.ratio) ? params.ratio : m.ratios[0],
      resolution: m.resolutions.includes(params.resolution) ? params.resolution : m.resolutions[0],
      duration: m.durations.includes(params.duration) ? params.duration : m.durations[0],
      generateAudio: m.supportsAudio ? params.generateAudio : false,
    });
  }

  return (
    <Panel title="Inspector" className="h-full border-0" bodyClass="flex flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Group label="Model">
          <Row label="Engine">
            <select className="ctl" value={params.modelId} onChange={(e) => switchModel(e.target.value)}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Row>
          <p className="px-2.5 pb-1 pt-1 text-[10.5px] leading-relaxed text-mute">{model.note}</p>
        </Group>

        <Group label="Format">
          <Row label="Ratio">
            <select className="ctl" value={params.ratio} onChange={(e) => patch({ ratio: e.target.value })}>
              {model.ratios.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Row>
          <Row label="Resolution">
            <select className="ctl" value={params.resolution} onChange={(e) => patch({ resolution: e.target.value })}>
              {model.resolutions.map((r) => <option key={r} value={r}>{r.toUpperCase()}</option>)}
            </select>
          </Row>
          <Row label="Frame">
            <span className="block truncate font-mono text-[11.5px] text-dim">
              {dims ? `${dims.w} × ${dims.h}` : "set at render"}
            </span>
          </Row>
        </Group>

        <Group label="Timing">
          <Row label="Duration">
            <select className="ctl" value={params.duration} onChange={(e) => patch({ duration: Number(e.target.value) })}>
              {model.durations.map((d) => <option key={d} value={d}>{d}s</option>)}
            </select>
          </Row>
          <Row label="Frame rate">
            <span className="block font-mono text-[11.5px] text-dim">24 fps</span>
          </Row>
        </Group>

        <Group label="Output">
          <Row label="Seed" hint="Leave blank for a random seed">
            <input className="ctl" value={params.seed} inputMode="numeric" placeholder="random"
              onChange={(e) => patch({ seed: e.target.value.replace(/\D/g, "") })} />
          </Row>
          <Row label="Audio" hint={model.supportsAudio ? "Native audio track" : "Seedance 2.5 only"}>
            <Switch checked={params.generateAudio} onChange={(v) => patch({ generateAudio: v })}
              disabled={!model.supportsAudio} />
          </Row>
          <Row label="Watermark">
            <Switch checked={params.watermark} onChange={(v) => patch({ watermark: v })} />
          </Row>
        </Group>

        {!lockedProjectId && (
          <Group label="Destination">
            <Row label="Bin">
              <select className="ctl" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Unfiled</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Row>
          </Group>
        )}
      </div>

      {/* Transport */}
      <div className="shrink-0 border-t border-line bg-panel2">
        <div className="grid grid-cols-2 gap-px bg-line">
          <div className="bg-panel2 px-2.5 py-2">
            <p className="lbl">Est. tokens</p>
            <p className="mt-1 font-mono text-[14px] tabular-nums text-bone">
              {tokens != null ? compactTokens(tokens) : "—"}
            </p>
          </div>
          <div className="bg-panel2 px-2.5 py-2">
            <p className="lbl">Est. cost</p>
            <p className="mt-1 font-mono text-[14px] tabular-nums text-lift">
              {est ? usd(est.net) : "—"}
            </p>
            {est && ACCOUNT_DISCOUNT > 0 && (
              <p className="mt-0.5 font-mono text-[9px] text-mute">
                <span className="line-through">{usd(est.list)}</span>
                <span className="ml-1 text-ok">−{Math.round(ACCOUNT_DISCOUNT * 100)}%</span>
              </p>
            )}
          </div>
        </div>

        {!est && (
          <p className="px-2.5 pt-2 text-[10px] leading-relaxed text-mute">
            Adaptive ratio — frame size is chosen at render, so cost lands after.
          </p>
        )}
        {est && hasVideoInput && (
          <p className="px-2.5 pt-2 text-[10px] leading-relaxed text-mute">
            Includes {inputSeconds.toFixed(1)}s of reference video, billed at the
            lower with-video rate.
          </p>
        )}

        <div className="p-2.5">
          <button
            type="button" onClick={onRender} disabled={busy || !canRender}
            className="ptitle h-9 w-full rounded-[3px] bg-red text-[12px] tracking-[.1em] text-white transition-colors hover:bg-lift disabled:cursor-not-allowed disabled:bg-panel3 disabled:text-mute"
          >
            {busy ? "Submitting…" : "Render"}
          </button>
          <p className="lbl mt-2 text-center">⌘ + ↵</p>
        </div>
      </div>
    </Panel>
  );
}
