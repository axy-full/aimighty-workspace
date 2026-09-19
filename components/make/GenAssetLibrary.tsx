"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { AudioLines, Download, File, FileText, Film, Image as ImageIcon, Upload, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { useUploadFile } from "@/lib/useUploadFile";
import { useApi } from "@/lib/useApi";
import { GEN_ASSETS_CHANGED } from "@/lib/genAssetInput";
import { inlineSafe } from "@/lib/serveType";
import { startGenDrag, startUploadDrag, type DraggedAsset } from "@/lib/dnd";
import { ASSET_GROUPS, libraryId, libraryInput, libraryKind, libraryName, libraryReady, libraryUrl, librarySource, type LibrarySource, type LibraryAsset, type LibraryUpload } from "@/lib/genLibrary";
import { fileProjectUpload, unfileProjectUpload } from '@/lib/workbench/project-library-client';
import type { Generation } from "@/lib/jobs";
import type { ProductionRow } from "@/lib/productions";
import type { Shot } from "@/lib/shots";
import { shortLabel } from "@/lib/models";
import { timeAgo } from "@/lib/format";
import LazyMedia from "@/components/LazyMedia";
import { useToast } from "@/components/ui/Toast";
import { ActionMenu, ActionDropdown, type StudioAction } from "@/components/workbench/ActionMenu";
import styles from "./gen.module.css";

export type GenAssetLibraryProps = {
  controller?: Ref<GenAssetLibraryHandle>;
  search: string;
  onUseAsset: (asset: DraggedAsset) => void;
  onEdit: (asset: LibraryAsset) => void;
  onUpscale: (asset: LibraryAsset) => void;
  onUsePrompt: (take: Generation) => void;
  workbenchProjectId?: string;
  projectName?: string;
  allowWorkspaceBrowse?: boolean;
  initialBrowseScope?: 'project' | 'workspace';
  source?: LibrarySource;
  onSourceChange?: (source: LibrarySource) => void;
  initialSource?: LibrarySource;
  onUseFirstFrame?: (asset: LibraryAsset) => void;
  onUseReference?: (asset: LibraryAsset) => void;
  /** Offer "Use as reference" on audio cards too (roles that take audio). */
  audioReference?: boolean;
  onAddToProject?: (asset: LibraryAsset) => void;
};
type Props = GenAssetLibraryProps;
export type GenAssetLibraryHandle = { upload: () => void };
type Page<T> = { items: T[]; next: string | null };

/** Refresh the loaded range atomically: new arrivals cannot open gaps between cursors. */
function useLibraryPages<T extends { id: string }>(path: string, field: "generations" | "uploads") {
  const { signedIn, requestScope } = useSession();
  const [pages, setPages] = useState<Page<T>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const live = useRef(true), pageCache = useRef<Page<T>[]>([]), lock = useRef(false), refreshQueued = useRef(false);
  const read = useCallback(async (cursor?: string): Promise<Page<T>> => {
    const response = await fetch(path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""), {
      cache: "no-store", headers: requestScope ? { "X-Workbench-Scope": requestScope } : {},
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(json?.[field])) throw new Error(json?.error || "The asset library could not be loaded.");
    return { items: json[field], next: (field === "generations" ? json.nextPageCursor : json.nextCursor) ?? null };
  }, [path, field, requestScope]);
  const refresh = useCallback(async (): Promise<void> => {
    if (!signedIn) return;
    if (lock.current) { refreshQueued.current = true; return; }
    lock.current = true;
    do {
      refreshQueued.current = false;
      try {
        const updated: Page<T>[] = [];
        const count = Math.max(1, pageCache.current.length);
        let cursor: string | undefined;
        for (let index = 0; index < count; index++) {
          if (!live.current) break;
          const page = await read(cursor);
          updated.push(page);
          if (!page.next) break;
          cursor = page.next;
        }
        if (live.current) {
          pageCache.current = updated; setPages(updated); setError(null);
        }
      } catch (e) {
        if (live.current) setError((e as Error).message);
      }
    } while (refreshQueued.current && live.current && !document.hidden);
    lock.current = false;
  }, [read, signedIn]);
  useEffect(() => {
    live.current = true;
    // Results follow awaited reads and are ignored after unmount. Allow the same
    // scoped read to settle across Strict Mode's setup/cleanup/setup rehearsal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const visible = () => { if (!document.hidden) void refresh(); };
    const changed = (event: Event) => { if ((event as CustomEvent).detail?.scope === requestScope) void refresh(); };
    const timer = setInterval(visible, 30000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener(GEN_ASSETS_CHANGED, changed);
    return () => { live.current = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener(GEN_ASSETS_CHANGED, changed); };
  }, [refresh, requestScope]);
  const next = pages.at(-1)?.next ?? null;
  const more = async () => {
    if (!next || lock.current) return;
    lock.current = true; setMoreBusy(true);
    try {
      const page = await read(next);
      if (live.current) { pageCache.current = [...pageCache.current, page]; setPages(pageCache.current); setError(null); }
    } catch (e) { if (live.current) setError((e as Error).message); }
    finally {
      lock.current = false;
      if (live.current) {
        setMoreBusy(false);
        if (refreshQueued.current) { refreshQueued.current = false; void refresh(); }
      }
    }
  };
  const items = useMemo(() => {
    const unique = new Map<string, T>();
    for (const page of pages) for (const item of page.items) if (!unique.has(item.id)) unique.set(item.id, item);
    return [...unique.values()];
  }, [pages]);
  return { items, ready: pages.length > 0, next, more, moreBusy, error, refresh };
}

export default function GenAssetLibrary(props: Props) {
  const { requestScope } = useSession();
  return <AssetLibrary key={`${requestScope}:${props.workbenchProjectId ?? 'all'}`} {...props}/>;
}
function AssetLibrary(props: Props) {
  const { signedIn, workspace, requestScope } = useSession(), upload = useUploadFile(), toast = useToast();
  const picker = useRef<HTMLInputElement>(null), lock = useRef(false), live = useRef(true);
  useImperativeHandle(props.controller, () => ({ upload: () => {
    if (lock.current) toast("Wait for the current uploads to finish.");
    else picker.current?.click();
  } }), [toast]);
  const [progress, setProgress] = useState<string | null>(null), [dragOver, setDragOver] = useState(false);
  const [localSource, setLocalSource] = useState<LibrarySource>(props.initialSource ?? 'uploads');
  const [localBrowseScope, setBrowseScope] = useState<'project' | 'workspace'>(props.allowWorkspaceBrowse ? props.initialBrowseScope ?? 'project' : 'project');
  const browseScope = props.workbenchProjectId ? localBrowseScope : 'workspace';
  const source = props.source ?? localSource;
  const changeSource = (next: LibrarySource) => { setLocalSource(next); props.onSourceChange?.(next); };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, [requestScope]);
  async function files(selected: FileList | globalThis.File[]) {
    if (lock.current) { toast("Wait for the current uploads to finish."); return; }
    if (!signedIn) { toast("Sign in to your workspace before uploading assets."); return; }
    const all = Array.from(selected);
    if (all.length > 20) { toast("Choose up to 20 assets per upload batch."); return; }
    lock.current = true;
    let completed = 0;
    try {
      for (const file of all) {
        if (!live.current) break;
        setProgress(`Uploading ${file.name}`);
        const stored = await upload(file, "chat", pct => {
          if (live.current) setProgress(`${file.name} · ${pct}%`);
        });
        if (props.workbenchProjectId && requestScope) await fileProjectUpload(props.workbenchProjectId,stored.id,requestScope);
        completed++;
        if (live.current) window.dispatchEvent(new CustomEvent(GEN_ASSETS_CHANGED, { detail: { scope: requestScope } }));
      }
      if (live.current && completed) { changeSource('uploads'); toast(`${completed} ${completed === 1 ? "asset" : "assets"} added to ${props.workbenchProjectId ? 'this project' : 'All assets'}.`); }
    } catch (e) { if (live.current) toast((e as Error).message); }
    finally { lock.current = false; if (live.current) setProgress(null); }
  }
  return <div className={styles.assetLibrary} data-file-drop={dragOver || undefined}
    onDragOver={e => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDragOver(true); } }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
    onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); setDragOver(false); void files(e.dataTransfer.files); } }}>
    <div className={styles.libraryToolbar}>
      <p>{browseScope === 'project' ? `${props.projectName || 'This project'} · Project assets` : `${workspace?.name ? `${workspace.name} · ` : ''}Workspace assets`}</p>
      <button type="button" className={styles.libraryUpload} aria-label="Upload assets" disabled={!signedIn || !!progress} onClick={() => picker.current?.click()}><Upload size={15}/><span data-library-upload-label="">Upload assets</span><span className="hidden" data-phone-upload-label="">Upload</span></button>
      <input ref={picker} type="file" multiple hidden aria-label="Upload library assets" disabled={!signedIn || !!progress}
        onChange={e => { if (e.target.files) void files(e.target.files); e.target.value = ""; }}/>
    </div>
    {props.allowWorkspaceBrowse && props.workbenchProjectId && <>
      <div className={styles.libraryScope} role="group" aria-label="Asset scope">
        <button type="button" aria-pressed={browseScope === 'project'} onClick={() => setBrowseScope('project')}>This project</button>
        <button type="button" aria-pressed={browseScope === 'workspace'} onClick={() => setBrowseScope('workspace')}>All workspace assets</button>
      </div>
      <p className={styles.libraryScopeNote}>{browseScope === 'project' ? `Files and takes linked to ${props.projectName || 'this project'}.` : 'Browse shared originals and takes across this workspace.'} Uploads are added to {props.projectName || 'this project'}.</p>
    </>}
    <div className={styles.librarySources} role="group" aria-label="Asset source">
      {(['uploads','generations'] as const).map(value=><button key={value} type="button" aria-pressed={source===value} onClick={()=>changeSource(value)}>{value==='uploads'?'Uploads':'Generations'}</button>)}
    </div>
    {progress && <p className={styles.libraryProgress} role="status">{progress}</p>}
    {!signedIn ? <div className={styles.empty}><h3>Your workspace library</h3><p>Sign in to upload assets and use your team’s takes.</p></div>
      : <LibraryResults key={`${requestScope}:${props.workbenchProjectId ?? 'all'}:${browseScope}:${props.search.trim()}`} {...props} source={source} browseScope={browseScope} onBrowseWorkspace={props.allowWorkspaceBrowse ? () => setBrowseScope('workspace') : undefined}/>}
  </div>;
}

function LibraryResults({ search, onUseAsset, onEdit, onUpscale, onUsePrompt, onUseFirstFrame, onUseReference, audioReference, onAddToProject, workbenchProjectId, projectName, source, browseScope, onBrowseWorkspace }: Props & { browseScope: 'project' | 'workspace'; onBrowseWorkspace?: () => void }) {
  const {requestScope}=useSession(),toast=useToast(),removing=useRef(new Set<string>());
  const q = search.trim() ? `&q=${encodeURIComponent(search.trim())}` : "";
  const projectPath = browseScope === 'project' && workbenchProjectId ? `/api/workbench/library?projectId=${encodeURIComponent(workbenchProjectId)}&limit=60${q}` : null;
  const gens = useLibraryPages<Generation>(projectPath ? `${projectPath}&source=generations` : `/api/jobs?limit=60&sync=0&pagination=stable${q}`, "generations");
  const uploads = useLibraryPages<LibraryUpload>(projectPath ? `${projectPath}&source=uploads` : `/api/uploads?limit=60${q}`, "uploads");
  const money = useMoney();
  const [selected, setSelected] = useState<LibraryAsset | null>(null), [filing, setFiling] = useState<Generation | null>(null);
  const assets = useMemo(() => [
    ...gens.items.map(value => ({ origin: "generation" as const, value })),
    ...uploads.items.map(value => ({ origin: "upload" as const, value })),
  ].sort((a, b) => b.value.createdAt - a.value.createdAt || libraryId(b).localeCompare(libraryId(a))), [gens.items, uploads.items]);
  const errors = [gens.error, uploads.error].filter(Boolean);
  const sourceReady = source === 'uploads' ? uploads.ready : gens.ready && (!projectPath || uploads.ready);
  const sourceError = source === 'uploads' ? uploads.error : gens.error || (projectPath && uploads.error);
  const visibleAssets = assets.filter(asset => librarySource(asset) === source);
  async function removeFiling(upload:LibraryUpload) {
    if(!requestScope||!workbenchProjectId||removing.current.has(upload.id))return;
    removing.current.add(upload.id);
    try{await unfileProjectUpload(workbenchProjectId,upload.id,requestScope);await uploads.refresh();toast('Project filing removed. The original remains in All assets and wherever project content uses it.');}
    catch(error){toast(error instanceof Error?error.message:'Could not remove this filing.');}
    finally{removing.current.delete(upload.id);}
  }
  return <>
    {errors.length > 0 && <div className={styles.notice} role="alert"><p>{[...new Set(errors)].join(" ")}</p><button type="button" className={styles.secondary} onClick={() => { void gens.refresh(); void uploads.refresh(); }}>Retry library</button></div>}
    {!sourceReady && !sourceError && <p role="status">Loading {source === 'uploads' ? 'uploads' : 'generated takes'} from this {projectPath ? 'project' : 'workspace'}…</p>}
    {sourceReady && !visibleAssets.length && projectPath && !search && <div className={styles.notice}><p>No {source === 'uploads' ? 'uploads' : 'generated takes'} are linked to {projectName || 'this project'} yet.</p>{onBrowseWorkspace && <button type="button" className={styles.secondary} onClick={onBrowseWorkspace}>Browse all workspace assets</button>}</div>}
    {sourceReady && ASSET_GROUPS.map(group => {
      const items = visibleAssets.filter(asset => libraryKind(asset) === group.kind);
      return <section className={styles.assetGroup} key={group.kind} aria-label={group.label}>
        <div className={styles.assetGroupHeader}><h3>{group.label}</h3><span>{items.length} loaded</span></div>
        {!items.length ? <p className={styles.groupEmpty}>{search ? `No matching ${group.label.toLowerCase()} loaded in this ${projectPath ? 'project' : 'workspace'}.` : `No ${source === 'uploads' ? 'uploaded' : 'generated'} ${group.label.toLowerCase()} loaded in this ${projectPath ? 'project' : 'workspace'}.`}</p>
          : <div className={styles.takeGrid} data-library-grid="">{items.map(asset => {
            const kind = libraryKind(asset), ready = libraryReady(asset), gen = asset.origin === "generation" ? asset.value : null;
            const name = libraryName(asset), id = libraryId(asset), visual = kind === "image" || kind === "video";
            const actions: StudioAction[] = [
              { label: "Preview", run: () => setSelected(asset), disabled: !ready },
              ...(onAddToProject ? [{label:'Add to project',run:()=>onAddToProject(asset),disabled:!ready}]:[]),
              ...(visual ? [
                ...(kind==='image'&&onUseFirstFrame?[{label:'Use as first frame',run:()=>onUseFirstFrame(asset),disabled:!ready}]:[]),
                { label: "Use as reference", run: () => onUseReference ? onUseReference(asset) : onUseAsset(libraryInput(asset)), disabled: !ready },
                { label: kind === "video" ? "Edit clip" : "Edit image", run: () => onEdit(asset), disabled: !ready },
                { label: kind === "video" ? "Upscale video" : "Upscale image", run: () => onUpscale(asset), disabled: !ready },
              ] : []),
              ...(kind === "audio" && audioReference && onUseReference ? [{ label: "Use as reference", run: () => onUseReference(asset), disabled: !ready }] : []),
              ...(gen ? [{ label: "Use prompt", run: () => onUsePrompt(gen) }, { label: "File to shot", run: () => setFiling(gen), disabled: !ready }] : []),
              ...(workbenchProjectId&&asset.origin==='upload'&&asset.value.projectFiled?[{label:'Remove project filing',run:()=>void removeFiling(asset.value)}]:[]),
            ];
            return <ActionMenu key={id} label={`Actions for ${name}`} actions={actions}><article className={styles.takeCard} data-library-id={id} tabIndex={0}
              draggable={!!ready} onDragStart={e => { if (!ready) { e.preventDefault(); return; } if (asset.origin === "generation") startGenDrag(e, asset.value); else startUploadDrag(e, asset.value); }}>
              <button type="button" className={styles.takeMedia} disabled={!ready} onClick={() => setSelected(asset)} aria-label={`Preview ${name}`}>
                {ready && visual && (asset.origin === "generation" || inlineSafe(asset.value.mime)) ? <LazyMedia url={libraryUrl(asset)} kind={kind === "video" ? "video" : "image"} className={styles.thumbnail} hoverPlay={kind === "video"} alt={name}/>
                  : <span className={styles.mediaSymbol}>{kind === "audio" ? <AudioLines size={32}/> : kind === "document" ? <FileText size={32}/> : kind === "video" ? <Film size={32}/> : kind === "image" ? <ImageIcon size={32}/> : <File size={32}/>}</span>}
                <span className={styles.takeKind}>{librarySource(asset) === "uploads" ? "Uploaded" : "Generated"}</span>
                {gen && <span className={styles.takeCost}>{money.take(gen)}</span>}
                {gen && !ready && <span className={styles.jobStatus}>{gen.status === "held" ? "Needs attention" : gen.status === "failed" ? "Failed" : gen.status === "cancelled" ? "Cancelled" : gen.status === "succeeded" ? "Output not retained" : "Generating"}</span>}
              </button>
              <div className={styles.takeInfo}><div className={styles.assetTitle}><p title={name}>{name}</p><ActionDropdown label={`Actions for ${name}`} actions={actions}/></div>
                <span>{gen ? shortLabel(gen.model) : `${(asset.value as LibraryUpload).bytes.toLocaleString()} bytes`} · {timeAgo(asset.value.createdAt)}</span>
                {gen?.projectName && <small className={styles.assetProduction}>{gen.projectName}{gen.shotCode ? ` · ${gen.shotCode}` : ""}</small>}
                {gen?.error && <p className={styles.takeError}>{gen.error}</p>}
              </div>
              <div className={styles.takeActions} data-expanded-actions={onAddToProject || (kind==='image'&&onUseFirstFrame) ? '' : undefined}>
                {onAddToProject && <button type="button" disabled={!ready} onClick={()=>onAddToProject(asset)}>Add to project</button>}
                {visual ? <>{kind==='image'&&onUseFirstFrame&&<button type="button" disabled={!ready} onClick={()=>onUseFirstFrame(asset)}>Use as first frame</button>}<button type="button" disabled={!ready} onClick={() => onUseReference ? onUseReference(asset) : onUseAsset(libraryInput(asset))}>Use as reference</button><button type="button" disabled={!ready} onClick={() => onEdit(asset)}>{kind === "video" ? "Edit clip" : "Edit image"}</button></>
                  : <>{kind === "audio" && audioReference && onUseReference && <button type="button" disabled={!ready} onClick={() => onUseReference(asset)}>Use as reference</button>}<button type="button" disabled={!ready} onClick={() => setSelected(asset)}>Preview</button></>}
                {ready && <a href={libraryUrl(asset).split("?")[0] + "?download=1"} download={asset.origin === "upload" ? asset.value.filename : true} aria-label={`Download ${name}`}><Download size={15}/></a>}
              </div>
            </article></ActionMenu>;
          })}</div>}
      </section>;
    })}
    <div className={styles.libraryMore}>
      {source==='generations'&&(gens.next||(projectPath&&uploads.next))&&<button type="button" disabled={gens.moreBusy||uploads.moreBusy} onClick={()=>void Promise.all([gens.more(),...(projectPath?[uploads.more()]:[])])}>{gens.moreBusy||uploads.moreBusy?'Loading takes…':'Load more takes'}</button>}
      {source==='uploads'&&uploads.next&&<button type="button" disabled={uploads.moreBusy} onClick={() => void uploads.more()}>{uploads.moreBusy ? "Loading uploads…" : "Load more uploads"}</button>}
    </div>
    <Dialog.Root open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}><Dialog.Portal><Dialog.Overlay className={styles.dialogOverlay}/><Dialog.Content className={`${styles.dialog} ${styles.previewDialog}`} aria-describedby={undefined}>
      <div className={styles.dialogHeader}><Dialog.Title>{selected ? libraryName(selected) : "Asset preview"}</Dialog.Title><Dialog.Close aria-label="Close preview"><X size={19}/></Dialog.Close></div>
      {/* Private original images require the browser's authenticated same-origin request. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {selected && <><div className={styles.preview}>{selected.origin === "upload" && !inlineSafe(selected.value.mime) ? <p>This original format has no browser preview. Download it to open in your media, document or colour application.</p> : libraryKind(selected) === "image" ? <img src={libraryUrl(selected)} alt={libraryName(selected)}/> : libraryKind(selected) === "video" ? <video src={libraryUrl(selected)} controls playsInline/> : libraryKind(selected) === "audio" ? <audio src={libraryUrl(selected)} controls/> : <p>Download the original to open it in your document or colour application.</p>}</div>
        <a className={styles.secondary} href={libraryUrl(selected).split("?")[0] + "?download=1"} download={selected.origin === "upload" ? selected.value.filename : true}><Download size={16}/>Download original</a></>}
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    <FileTakeDialog take={filing} onClose={() => setFiling(null)} onChanged={() => void gens.refresh()}/>
  </>;
}

function FileTakeDialog({ take, onClose, onChanged }: { take: Generation | null; onClose: () => void; onChanged: () => void }) {
  return <Dialog.Root open={!!take} onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className={styles.dialogOverlay}/><Dialog.Content className={styles.dialog} aria-describedby={undefined}>
    <div className={styles.dialogHeader}><Dialog.Title>File to a project</Dialog.Title><Dialog.Close aria-label="Close filing"><X size={19}/></Dialog.Close></div>
    {take && <Filing key={take.id} take={take} onClose={onClose} onChanged={onChanged}/>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
function Filing({ take, onClose, onChanged }: { take: Generation; onClose: () => void; onChanged: () => void }) {
  const [project, setProject] = useState(take.projectId || ""), [busy, setBusy] = useState(false);
  const { requestScope } = useSession(), toast = useToast();
  const productions = useApi<{ productions: ProductionRow[] }>("/api/productions", 0, requestScope);
  const shots = useApi<{ shots: Shot[] }>(project ? `/api/shots?projectId=${encodeURIComponent(project)}` : null, 0, requestScope);
  async function file(shot: Shot) {
    setBusy(true);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(take.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...(requestScope ? { "X-Workbench-Scope": requestScope } : {}) }, body: JSON.stringify({ shotId: shot.id }) });
      if (!response.ok) throw new Error("This take could not be filed. Try again.");
      onChanged(); onClose(); toast(`Filed to ${shot.code}`);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  return <div className={styles.filingForm}><label>Project<select aria-label="Project for take" value={project} onChange={e => setProject(e.target.value)} disabled={busy}><option value="">Choose a project</option>{productions.data?.productions.flatMap(p => p.projects.map(child => <option key={child.id} value={child.id}>{p.name}{p.projects.length > 1 ? ` · ${child.name}` : ""}</option>))}</select></label>
    {(productions.error || shots.error) && <p role="alert">{productions.error || shots.error}</p>}
    <div className={styles.modelList}>{shots.data?.shots.map(shot => <button type="button" key={shot.id} disabled={busy} onClick={() => void file(shot)}><span><strong>{shot.code}</strong><small>{shot.title || shot.description}</small></span></button>)}</div>
    {project && shots.data && !shots.data.shots.length && <p>No shots in this project yet.</p>}
  </div>;
}
