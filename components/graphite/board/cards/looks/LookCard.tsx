"use client";
import { withPickedLook } from "./model";
import { useLookPoller } from "./use-looks";
import { readOnlyOf } from "../doc/DocCards";
import type { CardProps } from "../types";
import type { LookData } from "./derive";
import { LookTile } from "./LookTile";

/**
 * A look on the board (README § 3.1 c): the still, its name and engine line, and a tick to pick it. Picking is
 * free; it makes this look the one the storyboard is drawn in. While the look renders it reads the job until it
 * lands and files it on the look (free reads only).
 */
export function LookCard({ data, ctx }: CardProps<LookData>) {
  const error = useLookPoller({ scope: ctx.scope, project: ctx.project, apply: ctx.rig.apply, save: ctx.rig.save }, data.id);
  const readOnly = readOnlyOf(ctx);
  return (
    <LookTile name={data.name} meta={data.meta} genId={data.genId} aspect={ctx.project.aspect} rendering={data.rendering} picked={data.picked}
      problem={error} readOnly={readOnly} testId="board-look"
      onPick={() => {
        if (data.picked) return;
        ctx.rig.apply((p) => withPickedLook(p, data.id));
        ctx.toast(`${data.name} picked`);
      }} />
  );
}
