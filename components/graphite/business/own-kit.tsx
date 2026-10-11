"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import LazyMedia from "@/components/LazyMedia";
import { EMPTY_MOLECULR, type MoleculrBrief } from "@/lib/workbench/moleculr";
import { entryAsset } from "@/lib/production/sequence";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import type { Asset, Project } from "@/lib/workbench/studio";
import { refreshProjectLibrary, uploadFilesToProject, type LibraryEntry } from "@/lib/workspace/library";
import type { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import { SaveFailedError } from '@/lib/workbench/save-then-continue';

/**
 * What every Business own-tool page shares: the project draft (the
 * revision-checked editor every Suites stage uses), the Business brief inside
 * it, and the way a picture gets into it — picked from this project's
 * Library, uploaded from the device, or imported from a reviewed web page.
 * A picture the brief points at (a product image, the logo, a poster layer,
 * the reference video) must be one of the draft's own assets
 * (lib/workbench/moleculr-bindings.ts), so a Library take is adopted into
 * the draft first, keeping its upload or render identity.
 */
export type OwnEditor = ReturnType<typeof useDraftEditor>;
export const briefOf = (project: Pick<Project, "moleculr">): MoleculrBrief => project.moleculr ?? EMPTY_MOLECULR;

/** Change the Business brief as the draft holds it now (never a render's older copy). */
export function changeBrief(editor: OwnEditor, fn: (brief: MoleculrBrief, project: Project) => MoleculrBrief) {
  editor.change((old) => {
    const before = briefOf(old);
    const next = fn(before, old);
    return next === before ? old : { ...old, moleculr: next };
  });
}

/** The draft as it is now, for work that awaits (an upload, an import) and must not act on an older copy. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; }, [value]);
  return ref;
}

/** A Library take's record in the draft: the one already there, or a new one filed under `category`. Null when the draft is full. */
export function adoptEntry(editor: OwnEditor, project: Project, entry: LibraryEntry, category: string): Asset | null {
  const id = entry.take.sourceId;
  const known = project.assets.find((a) => a.id === id || a.generationId === id || a.uploadId === id);
  if (known) return known;
  if (project.assets.length >= PROJECT_LIMITS.assets) return null;
  const asset: Asset = { ...entryAsset(entry), category };
  editor.change((old) => (old.assets.some((a) => a.id === asset.id) ? old : { ...old, assets: [...old.assets, asset] }));
  return asset;
}

/** A device file: stored, filed in this project's Library and recorded in the draft under `category`; `refs` names the originals it was made from. */
export async function uploadToDraft(scope: string, editor: OwnEditor, project: Project, file: File, category: string, description: string, refs: string[] = []): Promise<Asset> {
  if (project.assets.length >= PROJECT_LIMITS.assets) throw new Error("The project’s asset library is full.");
  const { uploads, notes } = await uploadFilesToProject(scope, project.id, [file]);
  const stored = uploads[0];
  if (!stored) throw new Error(notes[0] ?? `${file.name} could not be uploaded.`);
  const kind: Asset["kind"] = stored.kind === "video" ? "video" : "image";
  const asset: Asset = {
    id: stored.id, uploadId: stored.id, url: `/api/uploads/${stored.id}`, mime: stored.mime || file.type, kind, category,
    name: file.name.slice(0, 200), description: description.slice(0, 500), prompt: "", status: "Draft", version: 1, locked: false, refs: [...refs],
  };
  editor.change((old) => (old.assets.some((a) => a.id === asset.id) ? old : { ...old, assets: [...old.assets, asset] }));
  return asset;
}

const IMPORT_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif" };
const IMPORT_MAX = 10 * 1024 * 1024;
/**
 * An image a reviewed page offered (a logo, a product photograph): read once
 * through the existing import route — which fetches only a public image, for
 * a saved project — then stored like an upload. Free: nothing is generated.
 */
export async function importToDraft(scope: string, editor: OwnEditor, project: Project, url: string, category: "Product" | "Brand"): Promise<Asset> {
  if (!(await editor.ensureSaved())) throw new SaveFailedError();
  const response = await fetch("/api/workbench/moleculr/import-image", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
    body: JSON.stringify({ projectId: project.id, url }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof data.error === "string" ? data.error : "The image could not be imported.");
  }
  const mime = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!IMPORT_TYPES[mime] || Number(response.headers.get("content-length") || 0) > IMPORT_MAX) throw new Error("The image has an unsupported format or size.");
  const blob = await response.blob();
  if (blob.size > IMPORT_MAX) throw new Error("Imported images must be 10 MB or smaller.");
  let host = "the reviewed page";
  try { host = new URL(url).hostname; } catch { /* the label stays general */ }
  const file = new File([blob], `${category.toLowerCase()}-reference.${IMPORT_TYPES[mime]}`, { type: mime });
  return uploadToDraft(scope, editor, project, file, category, `Original ${category.toLowerCase()} reference imported from ${host}`);
}

/** The project's pictures in the Library (renders and uploads), newest first. */
export const libraryPictures = (items: readonly LibraryEntry[], kind: "image" | "video" = "image") =>
  items.filter((e): e is LibraryEntry & { url: string } => e.media === kind && Boolean(e.url));

/** A card's head: its label (at the label floor) and whatever sits on the right. */
export function CardHead({ label, children, testId }: { label: string; children?: ReactNode; testId?: string }) {
  return (
    <div className="bo-head" data-testid={testId}>
      <span className="gx-eyebrow bo-label" data-functional-label="">{label}</span>
      {children ? <span className="bo-head-side">{children}</span> : null}
    </div>
  );
}

/** A labelled field. */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="bo-field">
      <span className="bo-field-label" data-functional-label="">{label}</span>
      {children}
      {hint ? <span className="gx-hint bo-field-hint">{hint}</span> : null}
    </label>
  );
}

/** What the draft says about its last save: saved, saving, or why not. */
export function SaveLine({ editor, testId }: { editor: OwnEditor; testId: string }) {
  return <p className="gx-hint bo-save" role="status" data-testid={testId}>{editor.saveState}{editor.error ? ` — ${editor.error}` : ""}{editor.notice ? ` · ${editor.notice}` : ""}</p>;
}

/**
 * This project's pictures to choose from, with Upload first: a Library take
 * or a device file. `kind` video lists the project's videos instead.
 */
export function PicturePicker({ items, kind = "image", label, chosen, busy, disabled, onPick, onUpload, testId, max = 36 }: {
  items: readonly LibraryEntry[]; kind?: "image" | "video"; label: string; chosen?: readonly string[]; busy?: boolean; disabled?: boolean;
  onPick: (entry: LibraryEntry & { url: string }) => void; onUpload: (file: File) => void; testId: string; max?: number;
}) {
  const file = useRef<HTMLInputElement>(null);
  const pictures = useMemo(() => libraryPictures(items, kind).slice(0, max), [items, kind, max]);
  const picked = new Set(chosen ?? []);
  return (
    <div className="bo-picker" role="group" aria-label={label} data-testid={testId}>
      <button type="button" className="bo-tile bo-tile-upload" disabled={busy || disabled} onClick={() => file.current?.click()} data-testid={`${testId}-upload`}>
        <span aria-hidden="true">+</span><span>{busy ? "Adding…" : "Upload"}</span>
      </button>
      {pictures.map((entry) => (
        <button key={entry.take.id} type="button" className="bo-tile" disabled={disabled} aria-pressed={picked.has(entry.take.sourceId)} aria-label={entry.take.name} title={entry.take.name} onClick={() => onPick(entry)}>
          <LazyMedia url={entry.url} kind={kind} alt="" name={entry.take.name} className="gx-lazy" preview={false} />
        </button>
      ))}
      <input ref={file} type="file" hidden accept={kind === "video" ? "video/mp4,video/webm,video/quicktime" : "image/png,image/jpeg,image/webp,image/avif"}
        onChange={(e) => { const chosenFile = e.target.files?.[0]; e.target.value = ""; if (chosenFile) onUpload(chosenFile); }} data-testid={`${testId}-file`} />
    </div>
  );
}

/** A small async state for one page's free reads and imports: what it is doing, what went wrong, what it did. */
export function useWork() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async (label: string, work: () => Promise<string | void>) => {
    setBusy(label); setError(""); setNotice("");
    try { const said = await work(); if (alive.current && said) setNotice(said); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "That did not work. Try again."); }
    finally { if (alive.current) setBusy(""); }
  };
  return { busy, error, notice, run, setError, setNotice, alive };
}

/** The page's words after an action: what went wrong (with the way on), or what it did. */
export function Said({ error, notice, testId }: { error: string; notice: string; testId: string }) {
  return (
    <>
      {error ? <p className="gx-gen-error" role="alert" data-testid={`${testId}-error`}>{error}</p> : null}
      {notice ? <p className="gx-gen-note" role="status" data-testid={`${testId}-notice`}>{notice}</p> : null}
    </>
  );
}

/** After a Library picture joins the draft, the Library is read again so its tiles know. */
export const refreshLibrary = (scope: string, projectId: string) => void refreshProjectLibrary(scope, projectId);
