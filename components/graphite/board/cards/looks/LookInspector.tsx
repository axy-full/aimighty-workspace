"use client";
import { withPickedLook } from "./model";
import { readOnlyOf } from "../doc/DocCards";
import type { CardProps } from "../types";
import type { LookData } from "./derive";

/** A look in the Inspector (the nearest frame to README § 3.1 k): its name, engine line and words, and the free pick. */
export function LookInspector({ data, ctx }: CardProps<LookData>) {
  const prompt = ctx.project.production?.boards?.looks?.[data.id]?.prompt ?? "";
  const readOnly = readOnlyOf(ctx);
  return (
    <div className="gx-insp-take" data-testid="insp-look">
      <div className="gx-insp-title">{data.name}</div>
      <div className="gx-insp-meta">{data.meta}</div>
      {prompt ? <div><div className="gx-insp-eyebrow">Made from</div><p className="gx-insp-prompt">{prompt}</p></div> : null}
      {data.genId ? (
        <button type="button" className="gx-insp-act" disabled={Boolean(readOnly) || data.picked} title={readOnly ?? undefined}
          onClick={() => { ctx.rig.apply((p) => withPickedLook(p, data.id)); ctx.toast(`${data.name} picked`); }}>
          {data.picked ? "Picked" : "Pick this look"}
        </button>
      ) : null}
    </div>
  );
}
