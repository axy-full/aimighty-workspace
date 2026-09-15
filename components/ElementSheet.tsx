"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useOnChange } from "@/lib/changes";
import { appConfirm, appPrompt, appAlert } from "./dialog";
import { IconClose, IconSparkle } from "./Icons";
import { Empty } from "./ParticlMark";
import LazyMedia from "./LazyMedia";
import Boundary from "./Boundary";
import type { CastMember } from "@/lib/cast";
import type { Gen } from "./GenCard";

/**
 * One cast member or element, opened: what it is, and everything made with it.
 *
 * The two words are the same thing here and the app says both, because the
 * studio does: a face or a place is cast, a prop or a look is an element,
 * and both are a named visual reference dropped into a prompt as @Name.
 *
 * What the cast could not do was answer the obvious next question — what has
 * this actually been used for — because the renders that cited it were
 * scattered through the library with nothing tying them back.
 *
 * They were tied all along: every render records the names its prompt cited
 * in params.cast. This reads that back, so an element has its own body of
 * work the way an identity does.
 */

const KIND_LABEL: Record<string, string> = {
  character: "Character", location: "Location", prop: "Prop", style: "Look",
};

export default function ElementSheet({ member, onClose, onChanged }: {
  member: CastMember;
  onClose: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const { data, refresh } = useApi<{ generations: Gen[] }>(
    `/api/jobs?castName=${encodeURIComponent(member.name)}&limit=48&sync=0`, 0
  );
  useOnChange(refresh);
  const made = data?.generations ?? [];

  // Escape closes, like every other sheet in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Carry the citation to the composer, the way the Studio carries a spec. */
  function useInPrompt() {
    try {
      window.localStorage.setItem("aw_compose_seed", `@${member.name} `);
    } catch { /* private mode — the composer just opens empty */ }
    router.push("/");
  }

  async function rename() {
    const next = await appPrompt("Rename this element", member.name,
      "Letters and digits — it is what you write in a prompt");
    if (!next?.trim() || next.trim() === member.name) return;
    const res = await fetch(`/api/cast/${member.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next.trim() }),
    });
    if (!res.ok) {
      await appAlert("Couldn't rename it", (await res.json().catch(() => ({}))).error);
      return;
    }
    // Renders already made keep the OLD name in params.cast, so their link to
    // this element is broken by a rename. Said plainly rather than hidden.
    if (made.length) {
      await appAlert("Renamed",
        `The ${made.length} render${made.length === 1 ? "" : "s"} already made with @${member.name} still record the old name, so they will no longer be listed here.`);
    }
    onChanged();
    onClose();
  }

  async function describe() {
    const next = await appPrompt("Describe it in a line", member.description,
      "what must stay the same, in a breath");
    if (next === null) return;
    const res = await fetch(`/api/cast/${member.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: next }),
    });
    if (!res.ok) { await appAlert("Couldn't save it"); return; }
    onChanged();
  }

  async function remove() {
    if (!(await appConfirm(`Remove @${member.name}?`,
      made.length
        ? `Prompts citing the name will stop resolving. The ${made.length} render${made.length === 1 ? "" : "s"} already made with it are untouched.`
        : "Prompts that cite the name will stop resolving.",
      { confirmLabel: "Remove", danger: true }))) return;
    await fetch(`/api/cast/${member.id}`, { method: "DELETE" });
    onChanged();
    onClose();
  }

  return (
    <div className="sheet-veil" onClick={onClose}>
      <div className="sheet !max-w-[760px]" onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label={member.name}>
        <header className="sheet-head">
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-[16px] font-semibold tracking-[-0.01em]">
              @{member.name}
            </span>
            <span className="text-[12.5px] text-mute">
              {KIND_LABEL[member.kind] ?? member.kind}
              {member.projectId ? " · this project" : " · the whole workspace"}
            </span>
          </span>
          <button type="button" onClick={onClose} className="ml-auto theatre-close" title="Close"><IconClose /></button>
        </header>

        <div className="sheet-body">
          <div className="flex flex-wrap gap-4">
            {member.uploadId && (
              <span className="block w-[180px] shrink-0 overflow-hidden rounded-[var(--r)] bg-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/uploads/${member.uploadId}`} alt={member.name}
                  className="aspect-[4/3] w-full object-cover" />
              </span>
            )}
            <div className="min-w-[220px] flex-1">
              <p className="text-[14.5px] leading-relaxed text-dim">
                {member.description || "No description yet."}
              </p>
              <p className="mt-3 text-[13px] leading-relaxed text-mute">
                Write <span className="font-mono text-dim">@{member.name}</span> in any prompt and
                this still comes with it, in the position the engine expects.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={useInPrompt} className="btn-render h-[34px] px-4 text-[13.5px]">
                  <IconSparkle className="!h-4 !w-4" /> Use in a prompt
                </button>
                <button type="button" onClick={describe} className="chip !py-1.5 !text-[13px]">Describe</button>
                <button type="button" onClick={rename} className="chip !py-1.5 !text-[13px]">Rename</button>
                <button type="button" onClick={remove} className="chip !py-1.5 !text-[13px] !text-lift">Remove</button>
              </div>
            </div>
          </div>

          {/* ── What has been made with it ─────────────────────────────── */}
          <p className="grouplabel mt-7">
            Made with @{member.name}
            <span className="ml-2 font-sans text-[12px] normal-case tracking-normal text-mute">
              {made.length || "none yet"}
            </span>
          </p>
          <Boundary what="This element's renders" compact resetKey={member.id}>
            {made.length === 0 ? (
              <div className="card mt-2">
                <Empty compact title="Nothing made with it yet"
                  line="Cite the name in a prompt and every render that used it collects here." />
              </div>
            ) : (
              <div className="mt-2 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(116px,1fr))]">
                {made.map((g) => {
                  const url = g.storedUrl ?? g.sourceUrl;
                  const still = g.kind === "image";
                  return (
                    <span key={g.id} title={g.title || g.prompt}
                      data-gen-id={g.id} data-gen-prompt={g.prompt}
                      data-gen-label={g.title || g.id.slice(-6).toUpperCase()}
                      data-gen-title={g.title ?? ""}
                      className="relative block aspect-square overflow-hidden rounded-[10px] bg-thumb">
                      {g.status === "succeeded" && url ? (
                        <LazyMedia url={url} kind={still ? "image" : "video"} hoverPlay
                          alt={g.prompt.slice(0, 80)} className="!absolute inset-0" />
                      ) : (
                        <span className="grid h-full w-full place-items-center px-1 text-center text-[10.5px] text-mute">
                          {g.status === "failed" ? "failed" : "rendering…"}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
          </Boundary>
        </div>
      </div>
    </div>
  );
}
