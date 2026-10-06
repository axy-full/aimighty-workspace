"use client";
import type { ButtonHTMLAttributes } from "react";
import { Price } from "@/components/graphite/Price";
import { FREE } from "@/lib/shell/price-words";
import { useSession } from "@/lib/session";
import type { BoardCard } from "@/lib/board/types";
import { defineCard, type BoardCtx, type CardProps } from "../types";
import { DeliverBody } from "../../inspector/DeliverBody";
import { deliverRows, type CutCardData } from "../cut/cut-model";
import { SpecRowView } from "./SpecRow";
import { useLoudnessInput } from "../../edit/loudness-store";
import "./deliver.css";

/*
 * Frame i's Deliver card (README § 3.1): what the cut is delivered as, the checks, and Export the cut · free (the browser export, not the final render), which
 * opens the Inspector where the existing on-device renderer (with its progress and Download) lives. The checks read
 * "pending" until the cut is complete; a rate or a length is never ticked that nothing was checked against; loudness
 * reads "Not checked" and the deliverable's target until Edit & Sound has measured the sound the cut holds now.
 * Nothing here is paid: the export runs in the browser.
 */

function Btn({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={`gx-deliver-btn nodrag nopan${className ? ` ${className}` : ""}`} onDoubleClick={(e) => e.stopPropagation()} />;
}

export const DELIVER_SIZE = { w: 486, h: 330 } as const;

export function DeliverCard({ card, data, ctx }: CardProps<CutCardData>) {
  const { signedIn } = useSession();
  const { cut } = data;
  const rows = deliverRows(cut, useLoudnessInput(ctx.project));
  const act = signedIn && !ctx.offline;
  return (
    <article className="gx-deliver" aria-label="Deliver" data-testid="deliver-card" data-complete={cut.complete || undefined}>
      <div>
        <div className="gx-deliver-title">Deliver</div>
        <div className="gx-deliver-sub" data-testid="deliver-sub">{cut.aspect} · {cut.fps} fps</div>
      </div>
      <div className="gx-deliver-rows">{rows.map((r) => <SpecRowView key={r.key} row={r} />)}</div>
      {act ? (
        <div className="gx-deliver-acts">
          <Btn disabled={cut.clips.length === 0} title={cut.clips.length === 0 ? "Add takes to the cut first" : "Encodes the cut into a video file in your browser. The final render comes with server rendering."}
            onClick={(e) => { e.stopPropagation(); ctx.openInspector(card.id); }} data-testid="deliver-render">Export the cut · <Price value={FREE} /></Btn>
        </div>
      ) : null}
    </article>
  );
}

export const deliverDef = defineCard<CutCardData>({
  kind: "deliver",
  size: () => DELIVER_SIZE,
  Card: DeliverCard,
  Inspector: DeliverBody,
  onOpen: (card: BoardCard<CutCardData>, ctx: BoardCtx) => ctx.openInspector(card.id),
});
