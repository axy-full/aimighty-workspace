"use client";
import { useEffect, useRef, useState } from "react";
import { previewAttrs } from "@/lib/preview";
import { X } from "lucide-react";
import GenAssetLibrary from "@/components/make/GenAssetLibrary";
import { libraryInput } from "@/lib/genLibrary";
import { resolveGenInput } from "@/lib/genAssetInput";
import type { Project } from "@/lib/workbench/studio";
import {
  BILLING_LABELS,
  COMPOSER_TYPES,
  TYPE_LABELS,
  type BillingSource,
  type ComposerType,
} from "@/lib/workspace/composer";
import { useComposer } from "@/lib/workspace/use-composer";
import { useWorkspace } from "@/lib/workspace/state";
import { Button, Field, Input, Segmented, Select } from "./ui";

/**
 * The global Generate composer (owner decision, 20 Sep 2026): generation used
 * to sit four steps into a project, and most people come to generate. This is
 * an overlay over whatever is on screen — it never navigates, and it is the
 * same composer in all four suites.
 *
 * Shape: type first (Image / Video / Audio), then the model, then the prompt,
 * then optional references from the project library. The button carries the
 * exact live credit quote and is re-quoted on click; a moved, missing or stale
 * price blocks the send with a visible reason.
 *
 * Esc closes, focus is trapped while it is open, and focus returns to whatever
 * opened it.
 */

export function GenerateComposer({
  scope,
  project,
  onProject,
  workspaceName,
}: {
  scope: string;
  project: Project | null;
  onProject: (projectId: string) => void;
  workspaceName: string | null;
}) {
  const ws = useWorkspace();
  const open = ws.state.composer;
  const composer = useComposer({ scope, open, project, onProject, workspaceName });
  const panel = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const prompt = useRef<HTMLTextAreaElement | null>(null);
  const [search, setSearch] = useState("");
  const [referenceError, setReferenceError] = useState<string | null>(null);

  const close = () => ws.dispatch({ type: "patch", patch: { composer: false } });

  /* Remember the opener while it is still focused, and give it the focus back. */
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restore = opener.current;
    prompt.current?.focus();
    return () => { restore?.focus?.(); };
  }, [open]);

  /* Esc closes; Tab cycles inside the panel (the shell's keymap never sees these). */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.current.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const { state, model, offered, blocked, buttonLabel, credits, submitting } = composer;
  const audioTask = model?.audioTask;
  const wantsVoice = audioTask === "speech";
  const wantsSeconds = audioTask === "sound" || audioTask === "music";

  const addReference = async (payload: Parameters<typeof resolveGenInput>[0]) => {
    setReferenceError(null);
    try {
      const asset = await resolveGenInput(payload, scope);
      if (asset.kind !== "image" && asset.kind !== "video") throw new Error("References are images and videos.");
      composer.dispatch({ type: "addReference", value: { key: asset.key, id: asset.id, origin: asset.origin, kind: asset.kind, name: asset.name, url: asset.url } });
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : "This file cannot be used as a reference.");
    }
  };

  return (
    <div className="pxw-composer" data-testid="generate-composer">
      <div className="pxw-composer-catcher" onClick={close} aria-hidden="true" />
      <div className="pxw-composer-panel" role="dialog" aria-modal="true" aria-label="Generate" ref={panel}>
        <header className="pxw-composer-head">
          <div>
            <span className="pxw-kicker" data-functional-label="">Generate</span>
            <h2 className="pxw-composer-title">Make something now</h2>
          </div>
          <button type="button" className="pxw-composer-close" onClick={close} aria-label="Close the composer"><X size={15} /></button>
        </header>

        <div className="pxw-composer-body">
          <div className="pxw-composer-form">
            {/* Type first. */}
            <Field label="Type">
              {() => (
                <Segmented<ComposerType>
                  label="Output type"
                  fill
                  value={state.type}
                  onChange={(value) => composer.dispatch({ type: "type", value })}
                  options={COMPOSER_TYPES.map((type) => ({ id: type, label: TYPE_LABELS[type] }))}
                />
              )}
            </Field>

            {/* Model second, defaulted so the composer works untouched. */}
            <Field label="Model">
              {(id) => (
                <Select
                  id={id}
                  aria-label="Model"
                  data-testid="composer-model"
                  value={model?.id ?? ""}
                  disabled={submitting || !offered.length}
                  onChange={(event) => composer.dispatch({ type: "model", value: event.target.value })}
                >
                  {offered.length ? null : <option value="">No model available</option>}
                  {offered.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </Select>
              )}
            </Field>

            <Field label={wantsVoice ? "Script" : "Prompt"}>
              {(id) => (
                <textarea
                  id={id}
                  ref={prompt}
                  className="pxw-textarea"
                  aria-label={wantsVoice ? "Script" : "Prompt"}
                  data-testid="composer-prompt"
                  rows={5}
                  maxLength={5000}
                  value={state.prompt}
                  disabled={submitting}
                  onChange={(event) => composer.dispatch({ type: "prompt", value: event.target.value })}
                />
              )}
            </Field>

            {wantsSeconds ? (
              <Field label="Seconds">
                {(id) => (
                  <Input
                    id={id}
                    aria-label="Seconds"
                    type="number"
                    min={audioTask === "music" ? 10 : 1}
                    max={audioTask === "music" ? 300 : 30}
                    value={state.seconds}
                    disabled={submitting}
                    onChange={(event) => composer.dispatch({ type: "seconds", value: Math.max(1, Number(event.target.value) || 1) })}
                  />
                )}
              </Field>
            ) : null}

            {wantsVoice ? (
              <Field label="Voice">
                {(id) => (
                  <Select id={id} aria-label="Voice" value={state.voiceId} disabled={submitting} onChange={(event) => composer.dispatch({ type: "voice", value: event.target.value })}>
                    <option value="">Choose a voice</option>
                    {(composer.audio?.voices ?? []).map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
                  </Select>
                )}
              </Field>
            ) : null}

            {/* Billing: this workspace's credits by default, the connected account as a switch. */}
            <Field label="Credits">
              {() => (
                <Segmented<BillingSource>
                  label="Credits used"
                  fill
                  value={state.billing}
                  onChange={(value) => composer.dispatch({ type: "billing", value })}
                  options={(["workspace", "connected"] as BillingSource[]).map((source) => ({ id: source, label: BILLING_LABELS[source] }))}
                />
              )}
            </Field>
            <p className="pxw-composer-billing" data-testid="composer-billing">{composer.wording}</p>

            {state.type === "audio" ? null : (
              <div className="pxw-composer-refs" role="group" aria-label="References">
                <span className="pxw-kicker" data-functional-label="">References</span>
                {state.references.length ? (
                  <ul className="pxw-composer-ref-list">
                    {state.references.map((reference) => (
                      <li key={reference.key} data-testid="composer-reference">
                        <span {...previewAttrs({ url: reference.url, kind: reference.kind === "video" ? "video" : "image", name: reference.name })}>{reference.name}</span>
                        <button type="button" aria-label={`Remove ${reference.name}`} onClick={() => composer.dispatch({ type: "removeReference", key: reference.key })}><X size={12} /></button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="pxw-composer-hint">Optional. Pick images or videos from this project on the right.</p>
                )}
                {referenceError ? <p role="alert" className="pxw-composer-problem">{referenceError}</p> : null}
              </div>
            )}

            {composer.projectNotice ? <p role="status" className="pxw-composer-hint" data-testid="composer-project-notice">{composer.projectNotice}</p> : null}
            {state.notice ? <p role="alert" className="pxw-composer-problem" data-testid="composer-notice">{state.notice}</p> : null}
            {blocked && !state.notice ? <p role="status" className="pxw-composer-hint" data-testid="composer-blocked">{blocked}</p> : null}

            <div className="pxw-composer-actions">
              <Button
                variant="primary"
                data-testid="composer-generate"
                disabled={Boolean(blocked) || credits === null}
                onClick={composer.generate}
              >
                {buttonLabel}
              </Button>
              <Button onClick={close}>Close</Button>
            </div>
          </div>

          {/* The project library — the existing picker, not a second one. */}
          {state.type === "audio" ? null : (
            <aside className="pxw-composer-library" aria-label="Project library">
              <span className="pxw-kicker" data-functional-label="">Project files</span>
              {composer.project ? (
                <>
                  <Field label="Search">
                    {(id) => <Input id={id} aria-label="Search project files" value={search} onChange={(event) => setSearch(event.target.value)} />}
                  </Field>
                  <GenAssetLibrary
                    workbenchProjectId={composer.project.id}
                    projectName={composer.project.name}
                    allowWorkspaceBrowse
                    initialBrowseScope="project"
                    search={search}
                    onUseAsset={(asset) => void addReference(asset)}
                    onUseReference={(asset) => void addReference(libraryInput(asset))}
                    onUsePrompt={(take) => composer.dispatch({ type: "prompt", value: take.prompt.slice(0, 5000) })}
                    onEdit={() => {}}
                    onUpscale={() => {}}
                  />
                </>
              ) : (
                <p className="pxw-composer-hint">Open a project to attach references. Generating without one starts a project called “Untitled”.</p>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
