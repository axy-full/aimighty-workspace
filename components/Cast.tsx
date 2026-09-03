"use client";

import { useRef, useState } from "react";
import { useApi } from "@/lib/useApi";
import { uploadFile } from "@/lib/uploadClient";
import { appAlert, appConfirm, appPrompt } from "./dialog";
import type { CastMember } from "@/lib/cast";
import { IconPlus, IconClose } from "./Icons";

const KINDS = [
  { id: "character", label: "Character" },
  { id: "location", label: "Location" },
  { id: "prop", label: "Prop" },
  { id: "style", label: "Look" },
] as const;

/**
 * The cast for this project: who and where a production keeps returning to.
 *
 * Define someone once — a name, a description, a still — and write @Maya in
 * any prompt afterwards. At render time that becomes the reference citation
 * the model understands, so the same face survives from shot to shot without
 * being described again.
 */
export default function Cast({ projectId, onCite }: {
  projectId: string;
  onCite: (token: string) => void;
}) {
  const scoped = projectId !== "all" && projectId !== "unfiled";
  const { data, refresh } = useApi<{ cast: CastMember[] }>(
    `/api/cast${scoped ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, 0
  );
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pendingKind, setPendingKind] = useState<CastMember["kind"]>("character");

  const cast = data?.cast ?? [];

  /** A still is what actually holds a likeness, so adding one starts here. */
  async function addFrom(files: FileList) {
    const f = files[0];
    if (!f) return;
    const name = await appPrompt(
      `Name this ${pendingKind === "style" ? "look" : pendingKind}`, "",
      pendingKind === "character" ? "e.g. Maya" : pendingKind === "location" ? "e.g. HarbourSet" : pendingKind === "prop" ? "e.g. RedHelmet" : "e.g. NoirLook"
    );
    if (!name?.trim()) return;
    const description = await appPrompt(
      "Describe them in a line",
      "",
      pendingKind === "character"
        ? "e.g. late 30s, close-cropped hair, navy field jacket"
        : pendingKind === "prop"
          ? "e.g. scuffed red motorcycle helmet, matte finish"
          : "e.g. rain-soaked stone quay at dusk, sodium lamps"
    );

    setBusy(true);
    try {
      const up = await uploadFile(f, "reference", () => {});
      const res = await fetch("/api/cast", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), kind: pendingKind,
          description: description ?? "",
          uploadId: up.id,
          projectId: scoped ? projectId : null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { appAlert("Couldn't add them", json.error); return; }
      refresh();
    } catch (e) {
      appAlert("Couldn't add them", (e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  async function remove(m: CastMember) {
    if (!(await appConfirm(`Remove @${m.name}?`,
      "Prompts that already used them keep working — this only stops new ones.",
      { confirmLabel: "Remove", danger: true }))) return;
    await fetch(`/api/cast/${m.id}`, { method: "DELETE" });
    refresh();
  }

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-baseline gap-2">
        <span className="text-[16px] font-semibold tracking-[-0.015em]">Cast</span>
        <span className="ml-auto text-[13px] text-mute">{cast.length || ""}</span>
      </div>
      <p className="text-[13.5px] leading-relaxed text-dim">
        Name a face or a place once, then write{" "}
        <span className="font-medium text-blue">@Name</span> in any prompt. The same
        person comes back in every shot.
      </p>

      {cast.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {cast.map((m) => (
            <div key={m.id} className="group flex items-center gap-2.5 rounded-[12px] bg-panel2 p-1.5">
              <button onClick={() => onCite(`@${m.name}`)} title="Cite in the prompt"
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                <span className="h-9 w-9 shrink-0 overflow-hidden rounded-[8px] bg-thumb">
                  {m.uploadId && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={`/api/uploads/${m.uploadId}`} alt={m.name}
                      className="h-full w-full object-cover" />
                  )}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px] font-medium text-blue">@{m.name}</span>
                  <span className="truncate text-[12px] text-mute">
                    {m.description || KINDS.find((k) => k.id === m.kind)?.label}
                  </span>
                </span>
              </button>
              <button onClick={() => remove(m)} title="Remove"
                className="reveal grid h-7 w-7 shrink-0 place-items-center rounded-full text-mute hover:bg-chip2 hover:text-lift">
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {KINDS.map((k) => (
          <button key={k.id} disabled={busy}
            onClick={() => { setPendingKind(k.id); file.current?.click(); }}
            className="chip !py-1.5 !text-[13px] disabled:opacity-50">
            <IconPlus /> {k.label}
          </button>
        ))}
      </div>
      <input ref={file} type="file" hidden accept="image/jpeg,image/png,image/webp"
        onChange={(e) => e.target.files && addFrom(e.target.files)} />

      {!scoped && (
        <p className="text-[12px] leading-relaxed text-mute">
          You&apos;re in All projects, so anyone added here is available everywhere.
          Pick a project first to keep a cast to that production.
        </p>
      )}
    </div>
  );
}
