"use client";
import type { ButtonHTMLAttributes } from "react";
import { Price } from "@/components/graphite/Price";
import { openGenOn } from "@/components/graphite/OwnerRunCard";
import { FREE } from "@/lib/shell/price-words";
import { IdentityBlock } from "@/components/graphite/security/IdentityBlock";
import { consentProjectKey } from "@/lib/security/consent-words";
import { identityCardView } from "@/lib/security/identity-card";
import { useConsents } from "@/lib/security/use-consents";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { useIdentities } from "@/lib/workspace/identities";
import { usePaidAction } from "@/lib/usePaidAction";
import { dropParked, markAttached, parkBind, useParked } from "./parked-binds";
import { useState } from "react";
import type { BoardCard } from "@/lib/board/types";
import { defineCard, type BoardCtx, type CardProps } from "../types";
import { CastWell } from "./CastWell";
import { CutoutAction } from "./CutoutAction";
import { cutoutView } from "./cutout-model";
import { CastBody } from "../../inspector/CastBody";
import { VARIANT_LABEL, attachHeld, castBindingOf, castLabel, castStatus, consentLine, earlierSheetOf, heldBindFor, identityOf, renderPreset, restoreCastBinding, shotsWords, updateToNewerSheet, type CastBinding, type CastCardData } from "./cast-model";
import "./cast.css";

/*
 * Frame h's three cards: a character (Cast), a place (Environment) and an element, in "Cast, environment and
 * elements" (README § 3.1). Each shows its picture, its own words, its state in one line, and the shots it is in.
 *
 * - A character shows its identity's state and its consent tick (components/graphite/security/IdentityBlock.tsx): a
 *   person may tick it; Train Identity (its fixed training price) opens the Inspector's form, ticked or not.
 * - Render a still and Render a plate hand the words to Make, which quotes the price before anything is sent.
 * - Lock as master is free and anyone's: the Rig's own lock (RigContext.lockMaster).
 * - Nothing here is shown or sent without a signed-in person, and an offline board is read-only.
 */

function Btn({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={`gx-cast-btn nodrag nopan${className ? ` ${className}` : ""}`} onDoubleClick={(e) => e.stopPropagation()} />;
}

const WELL = 173;
/* A character's card holds the identity block (lane 5, Gaps A): its consent, its state and its actions. */
export const CAST_SIZE = { cast: { w: 308, h: WELL + 320 }, environment: { w: 308, h: WELL + 173 }, element: { w: 308, h: WELL + 173 } } as const;
/** The row the Cut-out action takes on a card with a still: its state line and its button, or Before and After. */
export const CUTOUT_ROW = 72;

export function CastCard({ card, data, ctx, selected }: CardProps<CastCardData>) {
  const shell = useShell();
  const { signedIn } = useSession();
  const { state } = useIdentities(ctx.scope, signedIn ? ctx.project.id : null);
  const identities = state.data?.identities ?? null;
  const identity = identityOf(data, identities);
  const consent = data.variant === "cast" ? consentLine(identity, signedIn) : null;
  /* A character's state is its identity and consent together (Gaps A); a place's and an element's are as before. */
  const consentKey = consentProjectKey(ctx.project);
  const consents = useConsents(signedIn && data.variant === "cast" ? ctx.scope : null, consentKey);
  /* A training sent from this card whose reply wasn't read here (the person left the production while it was out): its
     request is saved (lib/usePaidAction.ts), and the card offers Recover, which asks about that same request and is never
     charged twice; never a second Train press. Read only: nothing is sent from the card. */
  const saved = usePaidAction(`soul-identity:${ctx.project.id}`, signedIn && data.variant === "cast", { signedIn, requestScope: ctx.scope }).pending;
  const sentFrom = (() => { try { return saved ? (JSON.parse(saved.body) as { subjectKey?: unknown }).subjectKey ?? null : null; } catch { return null; } })();
  /* A training started from this card and held for it (its card was renamed since the press, R6-3): said by name, with
     Attach and Not this card (free, undoable); held from Train only until its outcome is known (R6-1). */
  const parked = useParked(signedIn && data.variant === "cast" ? ctx.scope : null);
  const held = heldBindFor(parked, ctx.project, data);
  const idView = identityCardView({ consents: consents.state.consents, subjectKey: card.id, bound: identity, identities, earlier: consent,
    readFailed: consents.state.status === "error" || state.status === "error", requestSaved: sentFrom === card.id,
    held: held ? { name: held.name ?? "", identity: identities?.find((i) => i.id === held.identityId) ?? null } : null });
  /* "Attach to <name>": the person says it is the same person; the bind runs without the name check. The bind stays
     parked as attached (R7-2), so whatever undoes the attach (this toast's Undo, Cmd/Ctrl+Z, any other change to the
     binding) holds the training on the card again. Undo while another production is open changes nothing there, and
     says so. */
  const attach = () => {
    if (!held) return;
    let was: CastBinding = { entry: null, asset: null };
    const refused = ctx.rig.apply((p) => { was = castBindingOf(p, held); return attachHeld(p, held, held.identityId); });
    if (refused) { ctx.toast(refused); return; }
    markAttached(ctx.scope, held.identityId, was, data.title);
    void ctx.rig.save();
    ctx.toast(`Attached to ${data.title.trim() || "this card"}`, { label: "Undo", run: () => {
      let elsewhere = false;
      const no = ctx.rig.apply((p) => { elsewhere = p.id !== held.projectId; return restoreCastBinding(p, held, was); });
      if (no || elsewhere) { ctx.toast(no ?? "The attach stays. Change it from that production's card."); return; }
      void ctx.rig.save();
    } });
  };
  /* "Not this card": drops this one held bind; the training stays listed under Build identity. Undo holds it again. */
  const notThis = () => {
    if (!held) return;
    dropParked(ctx.scope, held.identityId);
    ctx.toast("Not attached. It stays listed under Build identity.", { label: "Undo", run: () => parkBind(ctx.scope, held, held.at) });
  };
  const status = data.variant === "cast" && !data.retired && !data.rendering && signedIn ? { text: idView.text, tone: idView.tone } : castStatus(data, identities);
  const shots = shotsWords(data.shots);
  const act = signedIn && !ctx.offline && !data.retired;
  const training = state.data?.terms.trainingCredits ?? null;
  /* The card's own asset still renders with an earlier identity while a newer one is ready (owner, 23 Oct 2026, 17:10):
     the card says so, and Update moves the asset through the existing bind, which refuses a locked asset in words. */
  const earlier = data.variant === "cast" && act && data.nodeId ? earlierSheetOf(data, identities) : null;
  const updateSheet = () => {
    if (!earlier || !data.nodeId) return;
    const nodeId = data.nodeId;
    const refused = ctx.rig.apply((p) => updateToNewerSheet(p, nodeId, earlier));
    if (refused) ctx.toast(refused); else void ctx.rig.save();
  };
  const lock = async () => {
    if (!data.nodeId) return;
    const refused = await ctx.rig.lockMaster(data.nodeId);
    if (refused) ctx.toast(refused);
  };
  const render = () => openGenOn(shell, { ...renderPreset(data), type: "image" });
  const cut = data.cutout && act ? cutoutView(ctx.project, data.nodeId, data.master) : null;
  const [showing, setShowing] = useState<"before" | "after">("after");
  const picture = cut?.done && showing === "before" && cut.before ? cut.before : data.still;
  return (
    <article className="gx-cast" data-variant={data.variant} data-tone={status.tone} aria-label={castLabel(data) || VARIANT_LABEL[data.variant]} data-testid="cast-card">
      <CastWell still={picture} name={data.title} transparent={Boolean(cut?.done && showing === "after")} />
      <div className="gx-cast-body">
        <div className="gx-cast-kicker">{VARIANT_LABEL[data.variant]}{data.master ? " · master" : ""}</div>
        <div className="gx-cast-title" data-testid="cast-title">{data.title.trim() || VARIANT_LABEL[data.variant]}</div>
        <div className="gx-cast-desc" data-testid="cast-desc">{data.description}</div>
        <div className="gx-cast-status">
          <span className="gx-cast-state" data-tone={status.tone} data-testid="cast-status"><i aria-hidden="true" />{status.text}</span>
          {shots ? <span className="gx-cast-shots" data-testid="cast-shots">{shots}</span> : null}
        </div>
        {data.variant === "cast" ? (
          /* Identity and its consent tick (Gaps A): ticked by a person if they choose; trained from the Inspector's form. */
          <IdentityBlock scope={ctx.scope} projectKey={consentKey} subjectKey={card.id} subjectLabel={data.title.trim()}
            view={idView} consents={consents.state} trainingCredits={training} canAct={act}
            spendOff={ctx.exploreOnly ?? null} onTrain={() => ctx.openInspector(card.id)}
            heldActions={held ? { currentName: data.title.trim() || "this card", onAttach: attach, onDismiss: notThis } : null} />
        ) : null}
        {/* A locked asset can't move: it says so rather than offer an Update that can only fail. Update also swaps the
            asset's portrait for the newer identity's and raises its version (the existing bind). */}
        {earlier ? (
          <div className="gx-cast-earlier" data-testid="cast-earlier-sheet">
            {data.assetLocked ? <span>Renders with the earlier sheet · Unlock to update</span> : (
              <>
                <span>Renders with the earlier sheet</span>
                <Btn onClick={(e) => { e.stopPropagation(); updateSheet(); }} data-testid="cast-update-sheet">Update</Btn>
              </>
            )}
          </div>
        ) : null}
        {act ? (
          <div className="gx-cast-acts">
            {data.variant === "element" && data.lockable ? (
              <Btn onClick={(e) => { e.stopPropagation(); void lock(); }} data-testid="cast-lock">Lock as master · <Price value={FREE} /></Btn>
            ) : null}
            {data.prompt ? (
              <Btn onClick={(e) => { e.stopPropagation(); render(); }} data-testid="cast-render" title="Make shows its price before anything is sent">
                {data.variant === "environment" ? "Render a plate" : "Render a still"}
              </Btn>
            ) : null}
          </div>
        ) : null}
        {cut && data.nodeId ? <CutoutAction ctx={ctx} nodeId={data.nodeId} view={cut} showing={showing} onShow={setShowing} primary={selected} /> : null}
      </div>
    </article>
  );
}

export const castDef = defineCard<CastCardData>({
  kind: "cast",
  size: (data) => { const base = CAST_SIZE[data.variant]; return data.cutout ? { w: base.w, h: base.h + CUTOUT_ROW } : base; },
  Card: CastCard,
  Inspector: CastBody,
  /* Double-click or Enter: the Inspector, where a character's identity is built. */
  onOpen: (card: BoardCard<CastCardData>, ctx: BoardCtx) => ctx.openInspector(card.id),
});
