"use client";
import type { CardProps } from "../types";
import type { FrameData } from "../plan/derive";
import { FrameTile } from "./FrameTile";
import { useFramePoller } from "./use-frames";

/**
 * A storyboard frame on the board (README § 3.1 d): the shot's picture, name and line. While its frame renders it
 * reads the job until it lands and files it on the frame (free reads only); a frame that did not render says so
 * in the provider's words.
 */
export function FrameCard({ data, ctx }: CardProps<FrameData>) {
  const errors = useFramePoller({ scope: ctx.scope, project: ctx.project, apply: ctx.rig.apply, save: ctx.rig.save }, data.shotId);
  return (
    <FrameTile name={data.name} line={data.line} genId={data.genId} aspect={ctx.project.aspect} rendering={data.rendering}
      empty={errors[data.shotId] ?? "No frame yet"} testId="board-frame" />
  );
}
