"use client";
import type { Asset } from "@/lib/workbench/studio";
import { libraryCount, libraryFor } from "@/lib/workspace/pages";
import { nextLine } from "@/lib/workspace/activity";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { agentDot } from "@/lib/workspace/next";
import { useWorkspace } from "@/lib/workspace/state";
import { formatCount } from "@/lib/workspace/format";
import { toolIcon } from "./icons";
import { IconTile, Kicker, Segmented } from "./ui";

/** 274px. Tools per page, Media from the project's own uploads, NEXT footer. */
export function Library({ uploads }: { uploads: Asset[] }) {
  const { state, dispatch } = useWorkspace();
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
            {uploads.map((asset) => (
              <div className="pxw-media-item" key={asset.id} title={asset.name}>
                <span className="pxw-media-thumb">
                  {asset.kind === "image" && asset.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- workspace-scoped media URLs, same as the workbench library
                    <img src={asset.url} alt="" loading="lazy" />
                  ) : null}
                </span>
                <span className="pxw-media-name">{asset.name}</span>
              </div>
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
