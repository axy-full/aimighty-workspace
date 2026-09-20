"use client";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import type { ConsumerShortsInput } from "@/lib/higgsfield-consumer/shorts-studio";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import { DraftGate, DraftStatus } from "../spec/tools/DraftStatus";
import type { PageBodyProps } from "./registry";

const Shorts = dynamic(() => import("@/components/suites/ConsumerShorts").then((m) => m.ConsumerShorts), {
  ssr: false,
  loading: function Opening() {
    return <p className="pxw-spec-work-empty" role="status">Opening Shorts…</p>;
  },
});

/**
 * Shorts: the existing Shorts Studio for this project, inside the shell. It
 * keeps its own behaviour — the connected account's styles, one quote in
 * connected credits for the whole set, an explicit approval before any
 * submission, and clips filed into the project library.
 *
 * The form's own quote input — exactly what it would post, and only once it
 * could post it — is the request the page's Atomik plan prices at its gate.
 */
export function ShortsPage({ project, scope }: PageBodyProps) {
  const editor = useDraftEditor(scope, project?.id ?? null);
  const [input, setInput] = useState<ConsumerShortsInput | null>(null);
  const onInput = useCallback((next: ConsumerShortsInput | null) => setInput(next), []);
  const request = useMemo(() => (input ? { ...input } : undefined), [input]);
  /* The plan sends exactly this body; it never invents one. */
  usePlanRequest("shorts", request);
  const refresh = useCallback(async () => {
    await editor.refresh();
  }, [editor]);
  if (!project) return <p className="pxw-spec-work-empty">Open a saved project to make shorts.</p>;
  if (editor.status !== "ready" || !editor.project) return <DraftGate editor={editor} label="Shorts" />;
  return (
    <div className="pxw-spec" data-page-body="shorts">
      <DraftStatus editor={editor} />
      <div className="pxw-embed pxw-tool pxw-tool--shorts" data-tool-body="shorts">
        <Shorts project={editor.project} scope={scope} refreshProject={refresh} onInput={onInput} />
      </div>
    </div>
  );
}
