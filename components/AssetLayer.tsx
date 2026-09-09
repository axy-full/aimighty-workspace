"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { Waiting, Trouble, Empty } from "@/components/ParticlMark";
import {
  layoutAssets, layoutShots, assetWires, assetShapeLine,
  ASSET_W, SHOT_W, SHOT_X, SHOT_HEAD, SHOT_KEY_H,
  type AssetAt, type ShotAt,
} from "@/lib/graph";
import type { AssetGraph } from "@/lib/assetGraph";

/**
 * How characters, elements and backgrounds connect to shots
 * (brief 3, surface 2a).
 *
 * The surface where the port model stops being a schema and becomes a
 * picture. An element's attributes are its ports, a shot's bindings are its
 * slots, and the wire between them is drawn in one of three ways that the
 * binding row already decides:
 *
 *   thin      the slot follows whatever is current
 *   ink       the slot is pinned, and will not follow
 *   dashed    the element was promoted out of a take
 *
 * There is nowhere else for the style to come from, so the drawing and the
 * database cannot disagree — which is the whole point of the layer.
 */
export default function AssetLayer({ projectId }: { projectId: string }) {
  const { data, error } = useApi<{ graph: AssetGraph }>(
    `/api/rig/assets/${encodeURIComponent(projectId)}`, 10_000);
  const [hovered, setHovered] = useState<string | null>(null);

  const graph = data?.graph ?? null;
  const assets = useMemo(() => (graph ? layoutAssets(graph.assets) : []), [graph]);
  const shots = useMemo(() => (graph ? layoutShots(graph.shots) : []), [graph]);

  const wires = useMemo(() => {
    if (!graph) return [];
    const portAt = new Map<string, { x: number; y: number }>();
    for (const a of assets) {
      /* A port with no attribute is the bundle: every current version at
         once, and it leaves from the header rather than from a tile. */
      portAt.set(`${a.id}:bundle`, { x: a.x + ASSET_W, y: a.bundleY });
      for (const p of a.ports) portAt.set(`${a.id}:${p.id}`, { x: p.x, y: p.y });
    }
    const slotAt = new Map<string, { x: number; y: number }>();
    for (const s of shots) for (const sl of s.slots) slotAt.set(sl.id, { x: sl.x, y: sl.y });

    return assetWires(graph.links.map((l) => {
      const from = portAt.get(`${l.elementId}:${l.attributeId ?? "bundle"}`);
      const to = slotAt.get(l.slot);
      return from && to
        ? { key: l.key, kind: l.kind, portX: from.x, portY: from.y, slotX: to.x, slotY: to.y }
        : null;
    }).filter(Boolean) as Parameters<typeof assetWires>[0]);
  }, [graph, assets, shots]);

  if (error) return <Trouble label="The asset layer didn't load" />;
  if (!data) return <Waiting />;
  if (!graph || (!assets.length && !shots.length)) {
    return (
      <Empty
        title="Nothing wired yet"
        line="A character, a location, a prop or a look, bound to the shots that use it. Bind one and the wire between them appears here."
      />
    );
  }

  const height = Math.max(
    assets.reduce((m, a) => Math.max(m, a.y + a.h), 0),
    shots.reduce((m, s) => Math.max(m, s.y + s.h), 0),
  ) + 32;
  const width = SHOT_X + SHOT_W + 32;

  return (
    <div className="ast">
      <div className="stg-bar">
        <span className="stg-shape">{assetShapeLine(graph.counts)}</span>
        <span className="stg-recipe">LIBRARY → SHOTS</span>
      </div>

      <div className="stg-graph">
        <div className="stg-canvas" style={{ width, height }}>
          <svg className="stg-wires" width={width} height={height} aria-hidden="true">
            {wires.map((w) => (
              <path
                key={w.key} d={w.d}
                className={`ast-wire is-${w.kind}${hovered === w.key ? " is-lit" : ""}`}
              />
            ))}
          </svg>

          {assets.map((a) => <Asset key={a.id} a={a} />)}
          {shots.map((s) => <Shot key={s.id} s={s} onHover={setHovered} links={graph.links} />)}
        </div>
      </div>
    </div>
  );
}

/* An element: a header, then one tile per port. The tile is where a
   thumbnail goes; until the frames are wired it is the placeholder fill the
   rest of the app uses, never a caption standing in for a picture. */
function Asset({ a }: { a: AssetAt }) {
  return (
    <div className="ast-node" style={{ left: a.x, top: a.y, width: ASSET_W }}>
      <div className="ast-head" style={{ height: a.headH }}>
        <span className="ast-name">{a.name}</span>
        <span className="ast-kind">{a.kind.slice(0, 4).toUpperCase()}</span>
        {a.locked ? <span className="ast-lock" aria-label="locked">◆</span> : null}
        {a.origin ? <span className="ast-origin">{a.origin}</span> : null}
      </div>
      {a.ports.map((p) => (
        <div key={p.id} className={`ast-tile${p.idle ? " is-idle" : ""}`}>
          <span className="ast-tag">{p.label}</span>
          <span className="ast-ver">{p.version}</span>
          <span className={`ast-port${p.idle ? " is-idle" : ""}`} />
        </div>
      ))}
    </div>
  );
}

/* A shot: its keyframe, then one row per slot. An overridden slot says so,
   because that is the one fact about a slot that changes what renders. */
function Shot({ s, onHover, links }: {
  s: ShotAt; onHover: (key: string | null) => void; links: AssetGraph["links"];
}) {
  return (
    <div className="ast-shot" style={{ left: s.x, top: s.y, width: SHOT_W }}>
      {/* The node's header is the way into surface 2c. The canvas shows that a
          slot is overridden; the shot's own screen is where it is changed, and
          a picture you cannot act from is a diagram. */}
      <Link className="ast-shot-head" href={`/shots/${encodeURIComponent(s.id)}`} style={{ height: SHOT_HEAD }}>
        <span className="ast-shot-id">{s.code}</span>
        <span className="ast-shot-title">{s.title}</span>
      </Link>
      <div className="ast-key" style={{ height: SHOT_KEY_H }}>
        <span className="ast-key-chip">{s.code} · KEYFRAME</span>
      </div>
      {s.slots.map((sl) => {
        const link = links.find((l) => l.slot === sl.id);
        return (
          <div
            key={sl.id}
            className={`ast-slot${sl.overridden ? " is-over" : ""}`}
            onMouseEnter={() => onHover(link?.key ?? null)}
            onMouseLeave={() => onHover(null)}
          >
            <span className="ast-slot-port" />
            <span className="ast-slot-thumb" />
            <span className="ast-slot-tag">{sl.slot}</span>
            <span className="ast-slot-val">{sl.label} · {sl.version}</span>
            {sl.overridden ? <span className="ast-ovr">OVR</span> : null}
          </div>
        );
      })}
      <div className="ast-shot-foot">{s.state.toUpperCase()}</div>
    </div>
  );
}
