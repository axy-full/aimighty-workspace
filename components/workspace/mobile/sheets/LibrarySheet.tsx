"use client";
import LazyMedia from "@/components/LazyMedia";
import {
  IconAudio,
  IconBins,
  IconCompose,
  IconFilm,
  IconGenerate,
  IconImage,
  IconLibrary,
  IconMeter,
  IconSliders,
  IconStudio,
  IconTeam,
} from "@/components/Icons";
import { formatCount } from "@/lib/workspace/format";
import { useProjectLibrary } from "@/lib/workspace/library";
import { libraryCount, libraryFor } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import type { MobileSheetBodyProps } from "./registry";

/**
 * The Library sheet (05-mobile "Sheets": Tools / Media).
 *
 * Same config as the desktop Library rail — `libraryFor(page)` over
 * lib/workspace/pages.ts, and the same project library store for Media
 * (lib/workspace/library.ts), so the two read one copy and refresh together.
 * A media tile opens the take on Takes exactly as the desktop's does, through
 * `go()`.
 *
 * Icons come from components/Icons.tsx as the mobile addendum requires — the
 * desktop rail's lucide glyphs are a wave-1 decision that does not apply on
 * the phone. The repo's set has no dedicated glyph for a few tool names
 * (wardrobe, prop, colour…), so those fall back through the set's own icons
 * rather than a new drawing; the gap is reported rather than filled by hand.
 */
const TOOL_ICONS: Record<string, (props: { className?: string }) => React.JSX.Element> = {
  brief: IconCompose,
  scene: IconStudio,
  generate: IconGenerate,
  media: IconImage,
  sound: IconAudio,
  dialogue: IconAudio,
  "sound effects": IconAudio,
  ambience: IconAudio,
  "music score": IconAudio,
  mix: IconSliders,
  assembly: IconFilm,
  casting: IconTeam,
  uploads: IconBins,
  generations: IconGenerate,
  "all assets": IconLibrary,
  compare: IconMeter,
};
const FALLBACK = [IconLibrary, IconImage, IconStudio, IconSliders];

function toolIcon(name: string, index: number) {
  return TOOL_ICONS[name.toLowerCase()] ?? FALLBACK[index % FALLBACK.length];
}

export function LibrarySheet({ scope, project }: MobileSheetBodyProps) {
  const ws = useWorkspace();
  const { state, dispatch, go, setLibFilter } = ws;
  const library = useProjectLibrary(scope, project?.id ?? null);
  const groups = libraryFor(state.page);
  const total = libraryCount(groups);
  const media = library.items.filter((item) => item.media === "image" || item.media === "video");

  const openTake = (id: string) => {
    /* An upload is hidden under the Generations filter; show it — the same
       repair the desktop rail makes. */
    if (state.libFilter === "Generations") setLibFilter("All");
    dispatch({ type: "patch", patch: { selKind: "take", selId: id } });
    ws.setSheet(null);
    go("particl", "takes");
  };

  return (
    <div data-testid="mobile-library-body">
      <div className="pxm-segmented" role="group" aria-label="Library view">
        <button
          type="button"
          className="pxm-segment"
          data-on={state.libTab === "tools" ? "" : undefined}
          aria-pressed={state.libTab === "tools"}
          data-testid="mobile-library-tools"
          onClick={() => dispatch({ type: "patch", patch: { libTab: "tools" } })}
        >
          Tools <span className="pxm-segment-count" data-functional-label="">{formatCount(total)}</span>
        </button>
        <button
          type="button"
          className="pxm-segment"
          data-on={state.libTab === "media" ? "" : undefined}
          aria-pressed={state.libTab === "media"}
          data-testid="mobile-library-media"
          onClick={() => dispatch({ type: "patch", patch: { libTab: "media" } })}
        >
          Media <span className="pxm-segment-count" data-functional-label="">{formatCount(media.length)}</span>
        </button>
      </div>

      {state.libTab === "tools" ? (
        groups.length ? (
          groups.map((group, gi) => (
            <div className="pxm-lib-group" key={group.title}>
              <div className="pxm-lib-group-head">
                <span className="pxm-kicker" data-functional-label="">{group.title}</span>
                <span className="pxm-lib-group-count" data-functional-label="">{formatCount(group.items.length)}</span>
              </div>
              {group.items.map((item, ii) => {
                const Icon = toolIcon(item.name, gi + ii);
                return (
                  <div className="pxm-lib-item" key={item.name} data-tool={item.name} data-testid="mobile-library-tool">
                    <span className="pxm-lib-tile" data-tint={gi % 4} aria-hidden="true"><Icon /></span>
                    <span className="pxm-grow">
                      <span className="pxm-lib-name">{item.name}</span>
                      <span className="pxm-lib-sub">{item.sub}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          ))
        ) : (
          <p className="pxm-note">This page’s tools are listed with its specification.</p>
        )
      ) : media.length ? (
        <div className="pxm-media-grid">
          {media.map((item) => (
            <button
              type="button"
              className="pxm-media-item"
              key={item.take.id}
              title={item.take.name}
              data-media-item={item.take.id}
              data-testid="mobile-library-media-item"
              onClick={() => openTake(item.take.id)}
            >
              <span className="pxm-media-thumb">
                {item.url && (item.media === "image" || item.media === "video") ? <LazyMedia url={item.url} kind={item.media} alt="" className="pxm-take-media" /> : null}
              </span>
              <span className="pxm-media-name">{item.take.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="pxm-note">{project ? "No media in this project yet." : "Open a project to see its media."}</p>
      )}
    </div>
  );
}
