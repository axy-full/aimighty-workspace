"use client";

import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AudioLines,
  Film,
  Image as ImageIcon,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { usePageTitle } from "@/lib/usePageTitle";
import { useSession } from "@/lib/session";
import { ToastHost } from "@/components/ui/Toast";
import type { Generation } from "@/lib/jobs";
import Composer, { type ComposerHandle, type ComposerKind } from "./Composer";
import UnfiledWall from "./UnfiledWall";
import SeedanceEdit from "./SeedanceEdit";
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
  const search = useSearchParams();
  const mode =
    GEN_MODES.find((item) => item.slug === (initialKind ?? search.get("mode")))
      ?.slug ?? "video";
  return (
    <ToastHost>
      <Workspace
        key={JSON.stringify([workspace?.id, email, mode])}
        initialKind={initialKind}
      />
    </ToastHost>
  );
}

function Workspace({ initialKind }: { initialKind?: string }) {
  const router = useRouter(),
    search = useSearchParams();
  const { workspace, email } = useSession();
  const mode =
    GEN_MODES.find(
      (item) => item.slug === (initialKind ?? search.get("mode")),
    ) ?? GEN_MODES[0];
  usePageTitle(`Gen · ${mode.label}`);
  const [query, setQuery] = useState("");
  const [mobileView, setMobileView] = useState<"create" | "takes">("create");
  const [tick, setTick] = useState(0);
  const [totals, setTotals] = useState<{ takes: number; spent: string } | null>(
    null,
  );
  const composer = useRef<ComposerHandle>(null);
  const switchMode = (slug: string) => {
    if (slug === mode.slug) {
      setMobileView("create");
      return;
    }
    const params = new URLSearchParams(search.toString());
    params.set("mode", slug);
    router.push(`/generate?${params.toString()}`);
    setMobileView("create");
  };
  const reuse = (take: Generation) => {
    if (
      composer.current?.usePrompt(String(take.params.rawPrompt || take.prompt))
    )
      setMobileView("create");
  };
  const scope = JSON.stringify([workspace?.id, email, mode.kind]);
  const editing = mode.kind === "video" && search.get("task") === "edit";
  const editSource = (take?: Generation) => {
    const params = new URLSearchParams(search.toString());
    params.set("mode", "video");
    params.set("task", "edit");
    if (take) params.set("source", `generation:${take.id}`);
    else params.delete("source");
    router.push(`/generate?${params}`);
    setMobileView("create");
  };
  return (
    <div
      className={styles.workspace}
      data-generation-workspace=""
      data-mobile-view={mobileView}
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.eyebrow}>Generation workspace</span>
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
          Takes{totals ? <span>{totals.takes}</span> : null}
        </button>
      </div>
      <div className={styles.desk}>
        <div className={styles.creationPane}>
          {editing ? (
            <SeedanceEdit
              key={`${scope}:${search.get("source") ?? ""}`}
              initialSource={search.get("source")}
              onBack={() => {
                const params = new URLSearchParams(search.toString());
                params.delete("task");
                params.delete("source");
                router.push(`/generate?${params}`);
              }}
              onMade={() => setTick((value) => value + 1)}
            />
          ) : (
            <Composer
              key={scope}
              kind={mode.kind as ComposerKind}
              controller={composer}
              initialRef={search.get("ref")}
              onEditRequested={() => editSource()}
              onMade={() => {
                setTick((value) => value + 1);
              }}
            />
          )}
        </div>
        <section className={styles.takesPane} aria-label="Generated takes">
          <div className={styles.takesHeader}>
            <div>
              <h2>Your takes</h2>
              <span>
                {totals
                  ? `${totals.takes} takes · ${totals.spent}`
                  : "Unfiled · ready for a production"}
              </span>
            </div>
            <label className={styles.search}>
              <Search size={15} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search takes"
                aria-label="Search takes"
              />
            </label>
          </div>
          <div className={styles.takesScroll}>
            <UnfiledWall
              key={`${scope}:${tick}`}
              kind={mode.kind}
              search={query}
              onTotals={setTotals}
              onUsePrompt={reuse}
              onEdit={mode.kind === "video" ? editSource : undefined}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
