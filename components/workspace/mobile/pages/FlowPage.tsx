"use client";
import { useMemo } from "react";
import { NODE_DEFS, operationsFor, resolveAsset } from "@/lib/workbench/node-graph";
import type { Asset, CanvasNode } from "@/lib/workbench/studio";
import { mediaBands } from "@/lib/workspace/format";
import { flowChain } from "@/lib/workspace/mobile-templates";
import { isShotNode, shotNote, type RigShot } from "@/lib/workspace/shots";
import { useWorkspace } from "@/lib/workspace/state";
import { MobileRing, RING } from "../MobileRing";
import { useRig } from "../../rig/RigProvider";

/**
 * Flow (05-mobile, template 2): the desktop node graph as a vertical stack down
 * one wire — 15px pins, a blue wire for the inputs feeding the Scene and grey
 * after it, and the blue border and the ring on the Scene itself. There is no
 * wire dragging on a phone: a wire is read here, not made.
 *
 * The nodes, their order and their links are the real draft graph's, through
 * `flowChain` over `graphEdges` — the same data the desktop canvas positions.
 * Nothing is a fixture, and a graph with no scene still reads as a chain.
 */

function Media({ id, asset }: { id: string; asset: Asset | undefined }) {
  const [c1, c2] = mediaBands(id);
  const preview = asset?.generationId
    ? `/api/workbench/preview/generation/${encodeURIComponent(asset.generationId)}`
    : asset?.uploadId
      ? `/api/workbench/preview/upload/${encodeURIComponent(asset.uploadId)}`
      : asset?.kind === "image"
        ? asset.url
        : null;
  return (
    <span className="pxm-flow-media" aria-hidden="true">
      <span className="pxm-flow-band-a" style={{ background: c1 }} />
      <span className="pxm-flow-band-b" style={{ background: c2 }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview ? <img src={preview} alt="" loading="lazy" decoding="async" /> : null}
    </span>
  );
}

/** The footer dot and role, exactly as the desktop card computes them. */
function footer(node: CanvasNode, shot: RigShot | undefined) {
  if (node.type === "grade") {
    const active = operationsFor(node).filter((op) => op.enabled).length;
    return { dot: "var(--pxw-blue-ink)", label: `${active.toLocaleString("en-US")} active ${active === 1 ? "tool" : "tools"}` };
  }
  const status = shot?.status ?? node.status;
  const dot = status === "approved" ? "var(--pxw-green)" : status === "ready" || status === "queued" ? "var(--pxw-atomik-gold)" : "var(--pxw-label-floor)";
  return { dot, label: node.role || NODE_DEFS[node.type].role };
}

export function FlowPage() {
  const { state } = useWorkspace();
  const rig = useRig();
  const project = rig.project;
  const nodes = useMemo(() => project?.nodes ?? [], [project]);
  const selId = state.selKind === "shot" ? state.selId : null;
  const chain = useMemo(() => flowChain(nodes, selId), [nodes, selId]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const shotsById = useMemo(() => new Map(rig.shots.map((shot) => [shot.id, shot])), [rig.shots]);
  const assets = useMemo(() => (project ? [...project.assets, ...(project.sharedAssets ?? [])] : []), [project]);

  if (!project) return <p className="pxm-empty pxm-pad-x">{rig.status === "loading" ? "Loading the graph…" : "Open a project to see its flow."}</p>;

  const count = rig.shots.length;
  return (
    <div className="pxm-pad-x pxm-pad-top pxm-rows" data-template="flow" data-testid="mobile-flow">
      <p className="pxm-lede pxm-flow-lede">
        The flow is the same {count.toLocaleString("en-US")} {count === 1 ? "shot" : "shots"} as the list, read down one wire. Everything here can be
        done from the shot list.
      </p>
      {chain.map((step) => {
        const node = byId.get(step.id);
        if (!node) return null;
        const def = NODE_DEFS[node.type];
        const shot = isShotNode(node) ? shotsById.get(node.id) : undefined;
        const asset = resolveAsset(node, nodes, assets);
        const version = asset ? `v${asset.version}` : `v${(node.versions?.length ?? 0) + 1}`;
        const text = shot ? shotNote(node) : (node.text ?? "").trim();
        const f = footer(node, shot);
        return (
          <div className="pxm-flow-step" key={step.id} data-node-id={step.id} data-scene={step.scene ? "" : undefined}>
            {step.wire ? <span className="pxm-flow-wire" data-wire={step.wire} aria-hidden="true" /> : null}
            <span className="pxm-flow-pin" data-scene={step.scene ? "" : undefined} aria-hidden="true" />
            <div className="pxm-flow-card" role="group" aria-label={`${def.label}: ${node.title}`}>
              <div className="pxm-flow-kicker">
                <span data-functional-label="">{def.label.toUpperCase()}</span>
                <span data-functional-label="">{version}</span>
              </div>
              <div className="pxm-flow-body">
                <Media id={node.id} asset={asset} />
                <span className="pxm-grow">
                  <span className="pxm-flow-title">{node.title}</span>
                  {text ? <span className="pxm-flow-desc">{text}</span> : null}
                </span>
                {step.scene ? <MobileRing size={RING.card} color="var(--pxw-blue)" /> : null}
              </div>
              <div className="pxm-row pxm-flow-foot">
                <span className="pxm-dot5" style={{ background: f.dot }} aria-hidden="true" />
                <span className="pxm-flow-role">{f.label}</span>
              </div>
            </div>
          </div>
        );
      })}
      {!chain.length ? <p className="pxm-empty">This project has no graph yet. Add a shot to start one.</p> : null}
    </div>
  );
}
