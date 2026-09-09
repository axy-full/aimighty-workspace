"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { usePageTitle } from "@/lib/usePageTitle";
import { Waiting, Trouble, Empty } from "@/components/ParticlMark";
import ImpactSheet from "@/components/ImpactSheet";
import { versionLine } from "@/lib/rig";
import type { ElementFull } from "@/lib/elements";
import type { Impact } from "@/lib/impact";

/**
 * The element library, and the swap that opens the impact panel
 * (brief 3, surface 1b).
 *
 * Deliberately thin. Surface 2b is the character screen this grows into — the
 * reference thumbs, the four attribute rows, the version strip — and it is
 * later in the build order. What is here is the one thing 1b needs to be real:
 * somewhere a person changes which version everything follows, so the panel
 * has something to stop.
 */
export default function RigElementsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params);
  usePageTitle("Elements");
  const { data, error, refresh } = useApi<{ elements: ElementFull[] }>(
    `/api/rig/elements?projectId=${encodeURIComponent(projectId)}`);

  const [asking, setAsking] = useState<{ impact: Impact; kindWord: string; versionLabel: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (error) return <Trouble label="The element library didn't load" />;
  if (!data) return <Waiting />;
  if (!data.elements.length) {
    return <Empty title="No elements yet" line="A character, a location, a prop or a look, defined once and cited in every shot after." />;
  }

  /* Asking is a POST with no choice on it. The route answers 409 with the
     impact, which is the rule working rather than an error: the swap cannot
     happen until somebody decides what becomes of the takes. */
  async function ask(attributeId: string, versionId: string, kindWord: string, versionLabel: string) {
    if (busy) return;
    setBusy(versionId);
    try {
      const res = await fetch(`/api/rig/attributes/${encodeURIComponent(attributeId)}/current`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        /* The ask carries no production either: what the panel shows has to
           be what the swap does, and the swap is workspace-wide. */
        body: JSON.stringify({ versionId }),
      });
      const json = await res.json().catch(() => ({}));
      if (json?.impact) setAsking({ impact: json.impact, kindWord, versionLabel });
      else if (json?.ok) await refresh();
    } finally { setBusy(null); }
  }

  return (
    <div className="rig-els">
      <header className="rig-els-head">
        <h1 className="rig-els-title">Elements</h1>
        <p className="rig-els-said">
          A version is added freely; it is the swap that costs, because it is the swap that
          reaches the shots already made with the old one.
        </p>
      </header>

      {data.elements.map((el) => (
        <section key={el.id} className="rig-el">
          <div className="rig-el-top">
            {/* The list is the phone's way into 2b: the canvas is the only
                other door and it is hidden below 1180. */}
            <Link className="rig-el-name" href={`/elements/${encodeURIComponent(el.id)}`}>{el.name}</Link>
            <span className="rig-el-kind">{el.kind.toUpperCase()}</span>
          </div>
          {el.attributes.filter((a) => a.versions.length).map((a) => (
            <div key={a.id} className="rig-attr">
              <span className="rig-attr-kind">{a.kind.toUpperCase()}</span>
              <div className="rig-vers">
                {a.versions.map((v, i) => {
                  const on = a.currentId === v.id;
                  return (
                    <button
                      key={v.id} type="button"
                      className={`rig-ver${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      disabled={busy === v.id || v.status !== "ready"}
                      onClick={() => on ? undefined : ask(a.id, v.id, a.kind, versionLine(
                        a.versions.findIndex((x) => x.id === a.currentId), ""))}
                    >
                      {versionLine(i, v.label)}
                      {on ? <i className="rig-ver-now" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ))}

      {asking ? (
        <ImpactSheet
          impact={asking.impact}
          kindWord={asking.kindWord}
          versionLabel={asking.versionLabel}
          onClose={() => setAsking(null)}
          onApplied={() => { setAsking(null); refresh(); }}
        />
      ) : null}
    </div>
  );
}
