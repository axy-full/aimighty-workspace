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
import type { BoardCard } from "@/lib/board/types";
import { defineCard, type BoardCtx, type CardProps } from "../types";
import { CastWell } from "./CastWell";
import { CastBody } from "../../inspector/CastBody";
import { VARIANT_LABEL, castLabel, castStatus, consentLine, identityOf, renderPreset, shotsWords, type CastCardData } from "./cast-model";
import "./cast.css";

/*
 * Frame h's three cards: a character (Cast), a place (Environment) and an element, in "Cast, environment and
 * elements" (README § 3.1). Each shows its picture, its own words, its state in one line, and the shots it is in.
 *
 * - A character shows its identity's state and its consent (components/graphite/security/IdentityBlock.tsx): a person
 *   records consent first, then Train Identity (its fixed training price) opens the Inspector's form, armed with it.
 * - Render a still and Render a plate hand the words to Make, which quotes the price before anything is sent.
 * - Lock as master is free and anyone's: the Rig's own lock (RigContext.lockMaster).
 * - Nothing here is shown or sent without a signed-in person, and an offline board is read-only.
 */

function Btn({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={`gx-cast-btn nodrag nopan${className ? ` ${className}` : ""}`} onDoubleClick={(e) => e.stopPropagation()} />;
}

const WELL = 173;
export const CAST_SIZE = { cast: { w: 308, h: WELL + 275 }, environment: { w: 308, h: WELL + 173 }, element: { w: 308, h: WELL + 173 } } as const;

export function CastCard({ card, data, ctx }: CardProps<CastCardData>) {
  const shell = useShell();
  const { signedIn } = useSession();
  const { state } = useIdentities(ctx.scope, signedIn ? ctx.project.id : null);
  const identities = state.data?.identities ?? null;
  const identity = identityOf(data, identities);
  const consent = data.variant === "cast" ? consentLine(identity, signedIn) : null;
  /* A character's state is its identity and consent together (Gaps A); a place's and an element's are as before. */
  const consentKey = consentProjectKey(ctx.project);
  const consents = useConsents(signedIn && data.variant === "cast" ? ctx.scope : null, consentKey);
  const idView = identityCardView({ consents: consents.state.consents, subjectKey: card.id, bound: identity, identities, earlier: consent });
  const status = data.variant === "cast" && !data.retired && !data.rendering && signedIn ? { text: idView.text, tone: idView.tone } : castStatus(data, identities);
  const shots = shotsWords(data.shots);
  const act = signedIn && !ctx.offline && !data.retired;
  const training = state.data?.terms.trainingCredits ?? null;
  const lock = async () => {
    if (!data.nodeId) return;
    const refused = await ctx.rig.lockMaster(data.nodeId);
    if (refused) ctx.toast(refused);
  };
  const render = () => openGenOn(shell, { ...renderPreset(data), type: "image" });
  return (
    <article className="gx-cast" data-variant={data.variant} data-tone={status.tone} aria-label={castLabel(data) || VARIANT_LABEL[data.variant]} data-testid="cast-card">
      <CastWell still={data.still} name={data.title} />
      <div className="gx-cast-body">
        <div className="gx-cast-kicker">{VARIANT_LABEL[data.variant]}{data.master ? " · master" : ""}</div>
        <div className="gx-cast-title" data-testid="cast-title">{data.title.trim() || VARIANT_LABEL[data.variant]}</div>
        <div className="gx-cast-desc" data-testid="cast-desc">{data.description}</div>
        <div className="gx-cast-status">
          <span className="gx-cast-state" data-tone={status.tone} data-testid="cast-status"><i aria-hidden="true" />{status.text}</span>
          {shots ? <span className="gx-cast-shots" data-testid="cast-shots">{shots}</span> : null}
        </div>
        {data.variant === "cast" ? (
          /* Identity and its consent (Gaps A): recorded by a person, then trained from the Inspector's form. */
          <IdentityBlock scope={ctx.scope} projectKey={consentKey} subjectKey={card.id} subjectLabel={data.title.trim()}
            view={idView} consents={consents.state} trainingCredits={training} canAct={act}
            onTrain={() => ctx.openInspector(card.id)} />
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
      </div>
    </article>
  );
}

export const castDef = defineCard<CastCardData>({
  kind: "cast",
  size: (data) => CAST_SIZE[data.variant],
  Card: CastCard,
  Inspector: CastBody,
  /* Double-click or Enter: the Inspector, where a character's identity is built. */
  onOpen: (card: BoardCard<CastCardData>, ctx: BoardCtx) => ctx.openInspector(card.id),
});
