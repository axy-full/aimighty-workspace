"use client";
import { useState } from "react";
import { CastWell } from "../cards/cast/CastWell";
import { VARIANT_LABEL, bindCastIdentity, heldBindFor, startedBindStep, castStatus, consentLine, identityOf, shotsWords, type CastCardData } from "../cards/cast/cast-model";
import type { CardProps } from "../cards/types";
import { CastIdentities } from "@/components/graphite/production/CastIdentities";
import { Price } from "@/components/graphite/Price";
import { FREE } from "@/lib/shell/price-words";
import { useSession } from "@/lib/session";
import { useIdentities } from "@/lib/workspace/identities";
import { useProjectLibrary } from "@/lib/workspace/library";
import { consentProjectKey } from "@/lib/security/consent-words";
import { identityCardView } from "@/lib/security/identity-card";
import { useConsents } from "@/lib/security/use-consents";
import { ConsentTick } from "@/components/graphite/security/IdentityBlock";
import { parkBind, useParked } from "../cards/cast/parked-binds";

/*
 * The Inspector on a Cast, Environment or Element card (the nearest frame is k: preview, title, the card's own
 * words, its prompt with Copy). A character adds its identity: the state, its consent tick, and, until one is ready,
 * the existing Build identity form with its fixed price on the button. A tick, not a gate (owner, 23 Oct 2026): the
 * form is there ticked or not; a live tick is cited by the request.
 * Nothing here is shown or sent without a signed-in person.
 */

export function CastBody({ card, data, ctx }: CardProps<CastCardData>) {
  const { signedIn } = useSession();
  const { state } = useIdentities(ctx.scope, signedIn ? ctx.project.id : null);
  const { items } = useProjectLibrary(ctx.scope, signedIn ? ctx.project.id : null);
  const [lockNote, setLockNote] = useState<string | null>(null);
  const identities = state.data?.identities ?? null;
  const status = castStatus(data, identities);
  const identity = identityOf(data, identities);
  const consent = data.variant === "cast" ? consentLine(identity, signedIn) : null;
  const consentKey = consentProjectKey(ctx.project);
  const consents = useConsents(signedIn && data.variant === "cast" ? ctx.scope : null, consentKey);
  /* A training started from this card and held for it (renamed since the press): no second priced press here either. */
  const parked = useParked(signedIn && data.variant === "cast" ? ctx.scope : null);
  const held = heldBindFor(parked, ctx.project, data);
  const idView = identityCardView({ consents: consents.state.consents, subjectKey: card.id, bound: identity, identities, earlier: consent,
    readFailed: consents.state.status === "error" || state.status === "error",
    held: held ? { name: held.name ?? "", identity: identities?.find((i) => i.id === held.identityId) ?? null } : null });
  const shots = shotsWords(data.shots);
  const act = signedIn && !ctx.offline && !data.retired;
  /* Offered only once the identities and ticks were read (as the card: "Couldn't read this · reload" offers nothing), and
     only while there is something to train: no identity, or one that failed (Retry). Never beside a training in flight,
     one that needs review (uncertain, until it is reconciled) or a ready identity, so a paid press is never repeated. */
  const trainable = state.status === "ready" && state.data != null && idView.stage !== "unread" && idView.stage !== "started" && (!identity || identity.status === "failed");
  /* The card this press was made from, captured now (the production and the cast member); the reply binds only there. */
  const pressed = { entryId: data.entryId, nodeId: data.nodeId, name: data.title };
  /* Bound now when that production is the open one; otherwise (another is open, or the board can't take the edit now)
     parked for it, and bound the next time it is open (parked-binds.ts, applied by the board), so its card follows the
     training and never offers Train again for it. */
  const bindStarted = (identityId: string, pressedIn: string) => {
    const at = { ...pressed, projectId: pressedIn };
    let step: ReturnType<typeof startedBindStep> = startedBindStep(null, at);
    const refused = ctx.rig.apply((p) => {
      step = startedBindStep(p, at);
      return step.action === "bind" ? bindCastIdentity(p, at, identityId) : p;
    });
    if (refused || step.action === "park") {
      /* Kept, never dropped: a renamed card holds it with Attach and Not this card; another production binds it when it
         opens (R5-2, R6-1). */
      parkBind(ctx.scope, { ...at, identityId });
      ctx.toast(!refused && step.action === "park" && step.why === "renamed"
        ? `Training started for ${at.name}, whose card was renamed. On that card: Attach, or Not this card.`
        : "The training started. Its card follows it when that production is open again.");
      return;
    }
    void ctx.rig.save();
  };
  const copy = () => { void navigator.clipboard?.writeText(data.prompt).then(() => ctx.toast("Prompt copied"), () => ctx.toast("The prompt could not be copied.")); };
  const lock = async () => {
    if (!data.nodeId) return;
    const refused = await ctx.rig.lockMaster(data.nodeId);
    setLockNote(refused);
    if (refused) ctx.toast(refused);
  };
  return (
    <div className="gx-insp-take" data-testid="insp-cast">
      <div className="gx-insp-preview"><CastWell still={data.still} name={data.title} /></div>
      <div>
        <div className="gx-insp-title">{data.title.trim() || VARIANT_LABEL[data.variant]}</div>
        <div className="gx-insp-meta" data-testid="insp-cast-status">{[VARIANT_LABEL[data.variant], status.text, shots].filter(Boolean).join(" · ")}</div>
      </div>
      {data.description ? <p className="gx-insp-prompt">{data.description}</p> : null}
      {data.variant === "cast" ? (
        <section>
          <span className="gx-insp-eyebrow">Consent</span>
          <p className="gx-insp-prompt" data-testid="insp-cast-consent">{idView.consent}</p>
          {/* The tick (a person's own, recorded at once) and the optional details; nothing waits on it. */}
          {act && trainable ? (
            <div className="gsec-id-head" data-testid="insp-consent-tick">
              <ConsentTick scope={ctx.scope} projectKey={consentKey} subjectKey={card.id} subjectLabel={data.title.trim()} ready={consents.state.status === "ready"} />
            </div>
          ) : null}
        </section>
      ) : null}
      {data.prompt ? (
        <section>
          <div className="gx-insp-eyebrow-row"><span className="gx-insp-eyebrow">Prompt</span><button type="button" className="gx-insp-link" onClick={copy} data-testid="insp-copy">Copy</button></div>
          <p className="gx-insp-prompt">{data.prompt}</p>
        </section>
      ) : null}
      {act && data.variant === "element" && data.lockable ? (
        <div className="gx-insp-actions">
          <button type="button" className="gx-insp-act" onClick={() => void lock()} data-testid="insp-lock">Lock as master · <Price value={FREE} /></button>
          {lockNote ? <span className="gx-insp-hint" role="alert">{lockNote}</span> : null}
        </div>
      ) : null}
      {act && data.variant === "cast" && trainable ? (
        <section data-testid="insp-build">
          <div className="pxw gx-legacy pxw-embed">
            <CastIdentities scope={ctx.scope} projectId={ctx.project.id} items={items} save={ctx.rig.save}
              consent={idView.consentId ? { id: idView.consentId, line: idView.consent, subjectKey: card.id } : null} subjectKey={card.id}
              defaultName={data.title.trim()} onTrained={() => void consents.refresh()}
              onStarted={(started, pressedIn) => bindStarted(started.id, pressedIn)} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
