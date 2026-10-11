"use client";
import { useSession } from "@/lib/session";
import { cutMeta, secondsWords, type CutCardData } from "../cards/cut/cut-model";
import { openEditSound } from "../cards/cut/edit-sound";
import type { CardProps } from "../cards/types";

/*
 * The Inspector on the Cut card: the clips in order with their length and whether each is an approved take, the
 * shots still waiting, and Open Edit & Sound. Recorded facts only.
 */

export function CutBody({ data, ctx }: CardProps<CutCardData>) {
  const { signedIn } = useSession();
  const { cut } = data;
  return (
    <div className="gx-insp-take" data-testid="insp-cut">
      <div>
        <div className="gx-insp-title">The cut</div>
        <div className="gx-insp-meta">{cutMeta(cut)}</div>
      </div>
      {cut.clips.length ? (
        <section>
          <span className="gx-insp-eyebrow">Clips</span>
          <ol className="gx-insp-history">
            {cut.clips.map((c) => <li key={c.id}><span>{c.label}{c.approved ? " · approved" : " · not approved"}</span><time>{secondsWords(c.seconds)}</time></li>)}
          </ol>
        </section>
      ) : <p className="gx-insp-quiet">No takes in the cut yet.</p>}
      {cut.waiting.length ? <p className="gx-insp-quiet" data-testid="insp-cut-waiting">{cut.waiting.map((w) => `Shot ${w.shot} ${w.word}`).join(" · ")}</p> : null}
      {signedIn && !ctx.offline ? (
        <div className="gx-insp-actions"><button type="button" className="gx-insp-act" onClick={openEditSound} data-testid="insp-open-edit">Open Edit &amp; Sound</button></div>
      ) : null}
    </div>
  );
}
