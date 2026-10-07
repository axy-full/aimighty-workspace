"use client";
import { useState } from "react";
import { CastWell } from "../cards/cast/CastWell";
import { VARIANT_LABEL, castStatus, consentLine, identityOf, shotsWords, type CastCardData } from "../cards/cast/cast-model";
import type { CardProps } from "../cards/types";
import { CastIdentities } from "@/components/graphite/production/CastIdentities";
import { Price } from "@/components/graphite/Price";
import { FREE } from "@/lib/shell/price-words";
import { useSession } from "@/lib/session";
import { useIdentities } from "@/lib/workspace/identities";
import { useProjectLibrary } from "@/lib/workspace/library";

/*
 * The Inspector on a Cast, Environment or Element card (the nearest frame is k: preview, title, the card's own
 * words, its prompt with Copy). A character adds its identity: the state, the training consent that exists, and,
 * until one is ready, the existing Build identity form with its consent box and its fixed price on the button.
 * Nothing here is shown or sent without a signed-in person.
 */

export function CastBody({ data, ctx }: CardProps<CastCardData>) {
  const { signedIn } = useSession();
  const { state } = useIdentities(ctx.scope, signedIn ? ctx.project.id : null);
  const { items } = useProjectLibrary(ctx.scope, signedIn ? ctx.project.id : null);
  const [lockNote, setLockNote] = useState<string | null>(null);
  const identities = state.data?.identities ?? null;
  const status = castStatus(data, identities);
  const identity = identityOf(data, identities);
  const consent = data.variant === "cast" ? consentLine(identity, signedIn) : null;
  const shots = shotsWords(data.shots);
  const act = signedIn && !ctx.offline && !data.retired;
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
          <p className="gx-insp-prompt" data-testid="insp-cast-consent">{consent ?? "None recorded yet. Building an identity asks for it."}</p>
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
      {act && data.variant === "cast" && identity?.status !== "ready" ? (
        <section data-testid="insp-build">
          <div className="pxw gx-legacy pxw-embed"><CastIdentities scope={ctx.scope} projectId={ctx.project.id} items={items} save={ctx.rig.save} /></div>
        </section>
      ) : null}
    </div>
  );
}
