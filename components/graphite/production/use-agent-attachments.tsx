"use client";
import { useState } from "react";
import { attachedAsset, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { assetPreview, previewAttrs } from "@/lib/preview";
import type { Asset, Project } from "@/lib/workbench/studio";

/** Up to four pictures or text files ride with an agent run (lib/workbench/development-server attachmentAssetIds). */
export const AGENT_ATTACH_MAX = 4;

/**
 * An agent's prompt box takes media too (owner, 25 September): attached
 * pictures and text files are filed on the project and go with the agent's
 * next run — the pictures as images a seeing model looks at, text files as
 * text it reads. Anything else is kept in the Library, and the note says so.
 * `input` spreads into the run's request; `chips` shows what goes, each
 * previewable and removable. Attaching clears a quote, so the price is for
 * exactly what the agent will see.
 */
export function useAgentAttachments({ scope, project, change, save, onChange }: {
  scope: string; project: Project;
  change: (fn: (p: Project) => Project) => void; save: () => Promise<boolean>;
  onChange?: () => void;
}) {
  const [ids, setIds] = useState<string[]>([]);
  const live = ids.filter((id) => project.assets.some((a) => a.id === id));

  const onAttach = async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(scope, attached);
    const take: Asset[] = [], kept = [...unreadable];
    for (const m of media) {
      if (m.kind === "image" || (m.kind === "file" && m.mime.startsWith("text/"))) take.push(attachedAsset(m, "Reference", "Attached for the agent"));
      else kept.push(m.name);
    }
    const room = AGENT_ATTACH_MAX - live.length;
    const going = take.filter((a) => !live.includes(a.id)).slice(0, Math.max(0, room));
    const over = take.filter((a) => !live.includes(a.id)).slice(Math.max(0, room));
    if (going.length) {
      change((old) => ({ ...old, assets: [...old.assets, ...going.filter((a) => !old.assets.some((x) => x.id === a.id))] }));
      await save();
      setIds((prev) => [...prev.filter((id) => !going.some((a) => a.id === id)), ...going.map((a) => a.id)]);
      onChange?.();
    }
    return [
      going.length ? `The agent sees ${going.map((a) => a.name).join(", ")} on its next run.` : "",
      over.length ? `${over.map((a) => a.name).join(", ")} ${over.length === 1 ? "is" : "are"} kept in the Library — an agent run takes up to ${AGENT_ATTACH_MAX} attachments.` : "",
      keptNote(kept, "an agent reads pictures and text files.") ?? "",
    ].filter(Boolean).join(" ") || null;
  };

  const chips = live.length ? (
    <div className="pa-chips" data-testid="agent-attachments" aria-label="Attached for the agent">
      {live.map((id) => {
        const asset = project.assets.find((a) => a.id === id);
        return (
          <span key={id} className="pa-chip" {...previewAttrs(assetPreview(asset))}>
            <span className="pa-chip-name">{asset?.name ?? id}</span>
            <button type="button" aria-label={`Do not send ${asset?.name ?? "this"} to the agent`} onClick={() => { setIds((prev) => prev.filter((x) => x !== id)); onChange?.(); }}>×</button>
          </span>
        );
      })}
    </div>
  ) : null;

  return { ids: live, onAttach, chips, input: live.length ? { attachmentAssetIds: live } : {} };
}
