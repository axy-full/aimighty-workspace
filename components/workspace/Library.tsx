"use client";
import LazyMedia from "@/components/LazyMedia";
import { libraryCount, libraryFor } from "@/lib/workspace/pages";
import { nextLine } from "@/lib/workspace/activity";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { agentDot } from "@/lib/workspace/next";
import { useWorkspace } from "@/lib/workspace/state";
import { formatCount } from "@/lib/workspace/format";
import { toolIcon } from "./icons";
import { IconTile, Kicker, Segmented } from "./ui";

/** One upload in the Media tab. `takeId` opens it on Takes when it is a library item. */
export type MediaItem = { id: string; name: string; url: string | null; media: "image" | "video" | "audio" | null; takeId: string | null };

/** 274px. Tools per page, Media from the project's own uploads, NEXT footer. */
export function Library({ uploads }: { uploads: MediaItem[] }) {
  const { state, dispatch, go, setLibFilter } = useWorkspace();
  const openUpload = (item: MediaItem) => {
    /* An upload is hidden under the Generations filter; show it. */
    if (state.libFilter === "Generations") setLibFilter("All");
    if (item.takeId) dispatch({ type: "patch", patch: { selKind: "take", selId: item.takeId } });
    go("particl", "takes");
  };
  const atomik = useAtomik();
  const groups = libraryFor(state.page);
  const total = libraryCount(groups);
  const run = atomik.runFor(state.page);
  const next = nextLine(atomik.state, {
    page: state.page,
    rendering: atomik.rendering,
    readyShots: (state.lists.shots ?? []).filter((shot) => shot.status === "ready" || shot.status === "queued"),
  });
  const dot = run?.status === "waiting" ? "var(--pxw-amber)" : run?.status === "running" ? "var(--pxw-blue)" : agentDot(state);
  return (
    <aside className="pxw-library" aria-label="Library">
      <div className="pxw-library-head">
        <div className="pxw-library-title-row">
          <span className="pxw-panel-title">Library</span>
          <span className="pxw-library-count">{formatCount(total)} {total === 1 ? "tool" : "tools"}</span>
        </div>
        <Segmented
          label="Library view"
          className="pxw-library-tabs"
          border="field"
          fill
          value={state.libTab}
          onChange={(libTab) => dispatch({ type: "patch", patch: { libTab } })}
          options={[
            { id: "tools", label: "Tools" },
            { id: "media", label: "Media", count: <span className="pxw-library-media-count" data-functional-label="">{formatCount(uploads.length)}</span> },
          ]}
        />
      </div>
      <div className="pxw-library-body">
        {state.libTab === "tools" ? (
          groups.length ? (
            groups.map((group, gi) => (
              <div className="pxw-library-group" key={group.title}>
                <div className="pxw-library-group-head">
                  <Kicker>{group.title}</Kicker>
                  <span className="pxw-library-group-count" data-functional-label="">{formatCount(group.items.length)}</span>
                </div>
                {group.items.map((item, ii) => (
                  <div className="pxw-library-item" key={item.name}>
                    <IconTile icon={toolIcon(item.name, gi + ii)} tint={gi} size={32} />
                    <span className="pxw-library-item-text">
                      <span className="pxw-library-item-name">{item.name}</span>
                      <span className="pxw-library-item-sub">{item.sub}</span>
                    </span>
                  </div>
                ))}
              </div>
            ))
          ) : (
            <p className="pxw-library-empty">This page’s tools are listed with its specification.</p>
          )
        ) : uploads.length ? (
          <div className="pxw-media-grid">
            {uploads.map((item) => (
              <button type="button" className="pxw-media-item" key={item.id} title={item.name} data-media-item={item.id} onClick={() => openUpload(item)}>
                <span className="pxw-media-thumb">
                  {item.url && (item.media === "image" || item.media === "video") ? <LazyMedia url={item.url} kind={item.media} alt="" className="pxw-lazy" /> : null}
                </span>
                <span className="pxw-media-name">{item.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="pxw-library-empty">No uploads in this project yet.</p>
        )}
      </div>
      <button type="button" className="pxw-next" onClick={() => dispatch({ type: "patch", patch: { agentOpen: true } })}>
        <span className="pxw-next-head">
          <span className="pxw-dot" style={{ background: dot }} aria-hidden="true" />
          <Kicker>Next</Kicker>
        </span>
        <span className="pxw-next-text" data-testid="library-next">{next}</span>
      </button>
    </aside>
  );
}
