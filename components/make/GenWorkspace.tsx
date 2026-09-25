"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  AudioLines,
  Film,
  Image as ImageIcon,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { usePageTitle } from "@/lib/usePageTitle";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { ToastHost, useToast } from "@/components/ui/Toast";
import { importLibraryAsset } from "@/components/workbench/ProjectLibraryPage";
import type { Generation } from "@/lib/jobs";
import type { Project } from "@/lib/workbench/studio";
import { isAssetDrag, readDrag, type DraggedAsset } from "@/lib/dnd";
import { GEN_ASSETS_CHANGED, type GenAssetInputHandle } from "@/lib/genAssetInput";
import { libraryId, libraryInput, libraryKind, type LibraryAsset } from "@/lib/genLibrary";
import Composer, { type ComposerHandle, type ComposerKind } from "./Composer";
import GenAssetLibrary from "./GenAssetLibrary";
import SeedanceEdit from "./SeedanceEdit";
import AstraUpscale from "./AstraUpscale";
import TopazImageUpscale from "./TopazImageUpscale";
import styles from "./gen.module.css";

export const GEN_MODES = [
  { slug: "video", kind: "video", label: "Video", icon: Film },
  { slug: "images", kind: "image", label: "Images", icon: ImageIcon },
  { slug: "audio", kind: "audio", label: "Audio", icon: AudioLines },
] as const;

export default function GenWorkspace({
  initialKind,
}: {
  initialKind?: string;
}) {
  const { workspace, email } = useSession();
  return (
    <ToastHost>
      <Workspace
        key={JSON.stringify([workspace?.id, email])}
        initialKind={initialKind}
      />
    </ToastHost>
  );
}

function Workspace({ initialKind }: { initialKind?: string }) {
  const router = useRouter(),
    search = useSearchParams();
  const { workspace, email, requestScope } = useSession();
  const workbenchProjectId = search.get("project");
  const projectResult = useApi<{ project: Project | null; projects: { id: string; name: string }[] }>(requestScope
    ? `/api/workbench/projects${workbenchProjectId ? `?id=${encodeURIComponent(workbenchProjectId)}` : ""}` : null, 0, requestScope);
  useEffect(() => {
    if (workbenchProjectId || !requestScope || !projectResult.data) return;
    let remembered: string | null = null;
    try { remembered = localStorage.getItem(requestScope); } catch {}
    if (remembered && projectResult.data.projects.some(project => project.id === remembered)) {
      const params = new URLSearchParams(search.toString()); params.set("project", remembered);
      router.replace(`/generate?${params}`);
    }
  }, [workbenchProjectId, requestScope, projectResult.data, router, search]);
  const project = projectResult.data?.project?.id === workbenchProjectId ? projectResult.data.project : null;
  const generationProject = project?.productionProjectId ? { id: project.id, name: project.name, productionProjectId: project.productionProjectId } : null;
  const projectQuery = workbenchProjectId ? `&project=${encodeURIComponent(workbenchProjectId)}` : "";
  const toast = useToast();
  const mode =
    GEN_MODES.find(
      (item) => item.slug === (initialKind ?? search.get("mode")),
    ) ?? GEN_MODES[0];
  usePageTitle(`Gen · ${mode.label}`);
  const [query, setQuery] = useState("");
  const [mobileView, setMobileView] = useState<"create" | "takes">("create");
  const importContext = useRef<object | null>(null);
  const importLock = useRef(false);
  useEffect(() => {
    const context = {};
    importContext.current = context;
    return () => { if (importContext.current === context) importContext.current = null; };
  }, [requestScope, workbenchProjectId]);
  async function addToProject(asset: LibraryAsset) {
    const target = generationProject;
    const capturedScope = requestScope;
    const context = importContext.current;
    if (!target || !capturedScope || !context || importLock.current) return;
    importLock.current = true;
    try {
      await importLibraryAsset(target.id, capturedScope, asset);
      if (importContext.current !== context) return;
      window.dispatchEvent(new CustomEvent(GEN_ASSETS_CHANGED, { detail: { scope: capturedScope } }));
      toast(`Asset added to ${target.name}.`);
    } catch (error) {
      if (importContext.current === context) toast(error instanceof Error ? error.message : "Could not add this asset to the project.");
    } finally {
      importLock.current = false;
    }
  }
  const refreshLibrary = () => window.dispatchEvent(new CustomEvent(GEN_ASSETS_CHANGED, { detail: { scope: requestScope } }));
  const composer = useRef<ComposerHandle>(null);
  const specialized = useRef<GenAssetInputHandle>(null);
  const pendingPrompt = useRef<Generation | null>(null);
  const promptFrom = search.get("promptFrom");
  const prompted = useRef("");
  const promptTake = useApi<{ generation: Generation }>(
    requestScope && promptFrom && /^[A-Za-z0-9_-]{1,160}$/.test(promptFrom) ? `/api/jobs/${encodeURIComponent(promptFrom)}?sync=0` : null,
    0, requestScope,
  );
  const switchMode = (slug: string) => {
    if (slug === mode.slug) {
      setMobileView("create");
      return;
    }
    const params = new URLSearchParams(search.toString());
    params.set("mode", slug);
    for (const key of ["task", "source", "ref", "promptFrom"]) params.delete(key);
    router.push(`/generate?${params.toString()}`);
    setMobileView("create");
  };
  const reuse = (take: Generation) => {
    if (take.kind === mode.kind && composer.current) {
      if (composer.current.usePrompt(String(take.params.rawPrompt || take.prompt))) setMobileView("create");
      return;
    }
    pendingPrompt.current = take;
    router.push(`/generate?mode=${take.kind === "image" ? "images" : take.kind}${projectQuery}`);
    setMobileView("create");
  };
  const scope = JSON.stringify([workspace?.id, email, workbenchProjectId, mode.kind]);
  const upscaling = mode.kind === "image" && search.get("task") === "upscale";
  const upscaleSource = (asset?: LibraryAsset) => {
    if (asset && upscaling) { void specialized.current?.useAsset(libraryInput(asset)); setMobileView("create"); return; }
    const params = new URLSearchParams(search.toString());
    params.set("mode", "images");
    params.set("task", "upscale");
    params.delete("ref");
    if (asset) params.set("source", libraryId(asset));
    else params.delete("source");
    router.push(`/generate?${params}`);
    setMobileView("create");
  };
  const astraUpscaling = mode.kind === "video" && search.get("task") === "upscale";
  const astraSource = (asset?: LibraryAsset) => {
    if (asset && astraUpscaling) { void specialized.current?.useAsset(libraryInput(asset)); setMobileView("create"); return; }
    const params = new URLSearchParams(search.toString());
    params.set("mode", "video");
    params.set("task", "upscale");
    params.delete("ref");
    if (asset) params.set("source", libraryId(asset));
    else params.delete("source");
    router.push(`/generate?${params}`);
    setMobileView("create");
  };
  const editing = mode.kind === "video" && search.get("task") === "edit";
  const editSource = (asset?: LibraryAsset) => {
    if (asset && editing) { void specialized.current?.useAsset(libraryInput(asset)); setMobileView("create"); return; }
    const params = new URLSearchParams(search.toString());
    params.set("mode", "video");
    params.set("task", "edit");
    params.delete("ref");
    if (asset) params.set("source", libraryId(asset));
    else params.delete("source");
    router.push(`/generate?${params}`);
    setMobileView("create");
  };
  const toolOpen = editing || upscaling || astraUpscaling;
  const hasProject = Boolean(generationProject);
  useEffect(() => {
    if (!promptFrom || prompted.current === promptFrom || toolOpen) return;
    if (promptTake.error) { prompted.current = promptFrom; toast(promptTake.error); return; }
    const take = promptTake.data?.generation;
    /* The composer mounts once the project resolves (often after the take has
       loaded, when the project comes from memory); wait for it, and run again then. */
    if (!take || take.id !== promptFrom || !hasProject || !composer.current) return;
    prompted.current = promptFrom;
    if (take.kind !== mode.kind) { toast("Open this take in its matching generation mode to reuse the prompt."); return; }
    // The receiving composer refuses replacement while a paid request needs recovery.
    composer.current.usePrompt(String(take.params.rawPrompt || take.prompt));
  }, [promptFrom, promptTake.data, promptTake.error, toolOpen, mode.kind, toast, hasProject]);
  useEffect(() => {
    const take = pendingPrompt.current;
    if (take && take.kind === mode.kind && !toolOpen && composer.current) {
      pendingPrompt.current = null;
      composer.current.usePrompt(String(take.params.rawPrompt || take.prompt));
    }
  }, [mode.kind, toolOpen]);
  const receiver = () => toolOpen ? specialized.current : composer.current;
  async function addAsset(asset: DraggedAsset) {
    const kind = asset.kind === "gen" ? asset.gen.kind : asset.kind === "upload" ? asset.upload.kind : "image";
    if (mode.kind === "audio" && (kind === "image" || kind === "video") || mode.kind === "image" && kind === "video") {
      const id = asset.kind === "gen" ? `generation:${asset.gen.id}` : asset.kind === "upload" ? `upload:${asset.upload.id}` : `upload:${asset.uploadId}`;
      router.push(`/generate?mode=${kind === "image" ? "images" : "video"}&ref=${encodeURIComponent(id)}${projectQuery}`);
      setMobileView("create");
    } else if (await receiver()?.useAsset(asset)) setMobileView("create");
  }
  function editAsset(asset: LibraryAsset) {
    if (libraryKind(asset) === "video") editSource(asset);
    else if (mode.kind === "image" && !toolOpen) { void addAsset(libraryInput(asset)); }
    else {
      router.push(`/generate?mode=images&ref=${encodeURIComponent(libraryId(asset))}${projectQuery}`);
      setMobileView("create");
    }
  }
  return (
    <div
      className={styles.workspace}
      data-generation-workspace=""
      data-mobile-view={mobileView}
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          <div className="hidden" data-phone-gen-heading="">
            <span>Gen</span>
            <h1>Generation workspace</h1>
          </div>
          <Link className={styles.studioBack} href={workbenchProjectId ? `/workbench?project=${encodeURIComponent(workbenchProjectId)}&view=workspace` : "/workbench"}>
            <ArrowLeft size={15} aria-hidden="true" />
            Back to Studio
          </Link>
          <h1>
            Gen<span>/</span>
            {mode.label}
          </h1>
        </div>
        <nav className={styles.modes} aria-label="Generation mode">
          {GEN_MODES.map(({ slug, label, icon: Icon }) => (
            <button
              key={slug}
              type="button"
              aria-pressed={mode.slug === slug}
              onClick={() => switchMode(slug)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </header>
      <div
        className={styles.mobileViews}
        role="group"
        aria-label="Generation view"
      >
        <button
          type="button"
          aria-pressed={mobileView === "create"}
          onClick={() => setMobileView("create")}
        >
          <SlidersHorizontal size={16} />
          Create
        </button>
        <button
          type="button"
          aria-pressed={mobileView === "takes"}
          onClick={() => setMobileView("takes")}
        >
          <Film size={16} />
          Takes & assets
        </button>
      </div>
      <div className={styles.desk}>
        <div className={styles.creationPane}
          onDragOver={e => { if (isAssetDrag(e) || Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
          onDrop={e => {
            e.preventDefault(); e.stopPropagation();
            const asset = readDrag(e);
            if (asset) void receiver()?.useAsset(asset);
            else if (e.dataTransfer.files.length) void receiver()?.useFiles(e.dataTransfer.files);
            else toast("Drag a saved workspace asset or a file from your device.");
          }}>
          {!generationProject ? <div className={styles.notice} role="status">
            <p>{projectResult.error || (workbenchProjectId ? projectResult.data ? "This saved project is unavailable for generation. Open it in Studio to save its production mapping." : "Loading the saved project…" : "Choose a saved project before generating.")}</p>
            <Link href="/workbench">Choose a project in Studio</Link>
          </div> : astraUpscaling ? (
            <AstraUpscale
              project={generationProject}
              controller={specialized}
              key={`${scope}:${search.get("source") ?? ""}`}
              initialSource={search.get("source")}
              onBack={() => {
                const params = new URLSearchParams(search.toString());
                params.delete("task");
                params.delete("source");
                router.push(`/generate?${params}`);
              }}
              onMade={refreshLibrary}
            />
          ) : upscaling ? (
            <TopazImageUpscale
              project={generationProject}
              controller={specialized}
              key={`${scope}:${search.get("source") ?? ""}`}
              initialSource={search.get("source")}
              onMade={refreshLibrary}
              onBack={() => {
                const params = new URLSearchParams(search.toString());
                params.delete("task");
                params.delete("source");
                router.push(`/generate?${params}`);
              }}
            />
          ) : editing ? (
            <SeedanceEdit
              project={generationProject}
              controller={specialized}
              key={`${scope}:${search.get("source") ?? ""}`}
              initialSource={search.get("source")}
              onBack={() => {
                const params = new URLSearchParams(search.toString());
                params.delete("task");
                params.delete("source");
                router.push(`/generate?${params}`);
              }}
              onMade={refreshLibrary}
            />
          ) : (
            <Composer
              project={generationProject}
              key={scope}
              kind={mode.kind as ComposerKind}
              controller={composer}
              initialRef={search.get("ref")}
              onEditRequested={() => editSource()}
              onAstraRequested={() => astraSource()}
              onUpscaleRequested={() => upscaleSource()}
              onMade={refreshLibrary}
            />
          )}
        </div>
        <section className={styles.takesPane} aria-label="Workspace asset library">
          <div className={styles.takesHeader}>
            <div>
              <h2>Takes & assets</h2>
              <span>{project ? `${project.name} · drag or choose an asset` : "Choose a project to see its assets"}</span>
            </div>
            <label className={styles.search}>
              <Search size={15} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search assets"
                aria-label="Search assets"
                maxLength={200}
              />
            </label>
          </div>
          <div className={styles.takesScroll}>
            {generationProject && <GenAssetLibrary
              workbenchProjectId={generationProject.id}
              projectName={generationProject.name}
              allowWorkspaceBrowse
              initialBrowseScope="workspace"
              search={query}
              onAddToProject={asset => void addToProject(asset)}
              onUseAsset={asset => void addAsset(asset)}
              onUsePrompt={reuse}
              onEdit={editAsset}
              onUpscale={asset => libraryKind(asset) === "video" ? astraSource(asset) : upscaleSource(asset)}
              onUseFirstFrame={mode.kind === "video" && !toolOpen ? asset => { void composer.current?.useFirstFrame(libraryInput(asset)); setMobileView("create"); } : undefined}
              onUseReference={mode.kind === "video" && !toolOpen ? asset => { void composer.current?.useReference(libraryInput(asset)); setMobileView("create"); } : undefined}
            />}
            <Link href={workbenchProjectId ? `/library?all=1&project=${encodeURIComponent(workbenchProjectId)}` : "/library?all=1"} className="hidden" data-phone-library-link="">
              <span><strong>Your workspace library</strong><small>All uploads and generated takes</small></span>
              <ArrowLeft size={16} aria-hidden="true" />
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
