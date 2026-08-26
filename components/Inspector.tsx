"use client";

import { MODELS, getModel, dimensionsFor } from "@/lib/models";
import { Panel, Row, Group, Switch } from "./Panel";

export type Params = {
  modelId: string; ratio: string; resolution: string; duration: number;
  watermark: boolean; generateAudio: boolean; seed: string;
};

export default function Inspector({
  params, patch, projects, projectId, setProjectId, lockedProjectId,
}: {
  params: Params;
  patch: (p: Partial<Params>) => void;
  projects: { id: string; name: string }[];
  projectId: string;
  setProjectId: (v: string) => void;
  lockedProjectId?: string;
}) {
  const model = getModel(params.modelId);
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

    </Panel>
  );
}
