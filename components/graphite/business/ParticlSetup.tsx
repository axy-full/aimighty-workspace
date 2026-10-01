"use client";
import { useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import type { Project } from "@/lib/workbench/studio";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import { OWN_PAGE_LABEL, PARTICL_SETUP_TYPES, chooseProduct, particlItemActions, particlSetupItems, type OwnPage, type ParticlSetupItem } from "@/lib/shell/business-own";
import { briefOf, changeBrief } from "./own-kit";

/**
 * Business › Setup: the setup items Particl made in this project — its saved
 * products, its brand kit and its reference ad — for every member, with or
 * without a connected account. They are Particl's own records in the project
 * draft (lib/shell/business-own.ts › particlSetupItems), used by Particl's
 * own tools (Format, Hooks, Design); none is ever sent to a connected
 * account. They follow the account's own lists, which keep their place.
 */
export function ParticlSetup({ scope, project }: { scope: string; project: Project | null }) {
  if (!project) return null;
  return <ParticlSetupBody key={project.id} scope={scope} projectId={project.id} />;
}

function ParticlSetupBody({ scope, projectId }: { scope: string; projectId: string }) {
  const shell = useShell();
  const { toast } = useWorkspace();
  const editor = useDraftEditor(scope, projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const p = editor.project;
  if (editor.status === "loading" || !p) {
    return (
      <section className="bo bo-setup" aria-label="Made in Particl" aria-busy={editor.status === "loading"} data-testid="particl-setup">
        <div className="bz-group">
          <span className="gx-eyebrow bo-label" data-functional-label="">Made in Particl</span>
          {editor.status === "loading" ? <span className="bz-skel bz-skel--row" aria-hidden="true" /> : (
            <div className="gx-retry" role="alert">
              <span className="gx-gen-error">{editor.error || "This project could not be read."}</span>
              <button type="button" className="gx-hbtn" onClick={editor.reload}>Try again</button>
            </div>
          )}
        </div>
      </section>
    );
  }
  const items = particlSetupItems(p);
  const count = PARTICL_SETUP_TYPES.reduce((n, [type]) => n + items[type].length, 0);
  const chosen = PARTICL_SETUP_TYPES.flatMap(([type]) => items[type]).find((item) => item.id === selected) ?? null;
  const go = (page: OwnPage) => shell.goSuite("business", page);
  const use = (item: ParticlSetupItem, page: OwnPage) => {
    if (item.type === "product" && !item.active) {
      const next = chooseProduct(briefOf(p), item.source);
      if (!next.brief) { setProblem(next.problem); return; }
      changeBrief(editor, () => next.brief);
      void editor.ensureSaved();
      toast(`${item.name} is the product every brief is about`);
    }
    setProblem("");
    go(page);
  };
  return (
    <section className="bo bo-setup" aria-label="Made in Particl" data-testid="particl-setup">
      <div className="bz-group">
        <div className="bz-group-head">
          <span className="gx-eyebrow bo-label" data-functional-label="">Made in Particl · this project</span>
          <span className="gx-hint" data-testid="particl-setup-count">{count} {count === 1 ? "item" : "items"}</span>
        </div>
        {count ? PARTICL_SETUP_TYPES.filter(([type]) => items[type].length).map(([type, label]) => (
          <div className="bo-setup-type" key={type} data-testid={`particl-setup-${type}`}>
            <span className="bo-field-label" data-functional-label="">{label} · {items[type].length}</span>
            {items[type].map((item) => (
              <button type="button" className="bz-row bo-setup-row" key={item.id} aria-pressed={selected === item.id} onClick={() => setSelected(selected === item.id ? null : item.id)}>
                <span className="bo-setup-name">
                  {item.previewUrl ? <span className="bo-thumb bo-thumb--sm"><LazyMedia url={item.previewUrl} kind="image" alt="" className="gx-lazy" preview={false} /></span> : null}
                  <span className="bz-row-name">{item.name}</span>
                </span>
                <span className="gx-hint bo-setup-meta">{item.active && item.type === "product" ? "In use · " : ""}{item.meta.replace(/^Made in Particl · /, "")}</span>
              </button>
            ))}
          </div>
        )) : (
          <div className="bo-setup-empty" data-testid="particl-setup-empty">
            <span className="bo-strong">Nothing made in Particl yet</span>
            <span className="gx-hint">Save a product profile, a brand kit or a reference ad and it is listed here, ready for Format, Hooks and Design.</span>
            <div className="gx-gen-enhance">
              <button type="button" className="gx-hbtn" onClick={() => go("product")}>Open Product</button>
              <button type="button" className="gx-hbtn" onClick={() => go("brand")}>Open Brand</button>
              <button type="button" className="gx-hbtn" onClick={() => go("reference")}>Open Reference</button>
            </div>
          </div>
        )}
        {chosen ? (
          <div className="bo-setup-detail" data-testid="particl-setup-detail">
            <span className="bo-strong">{chosen.name}</span>
            <span className="gx-hint">{chosen.meta}</span>
            <div className="gx-gen-enhance">
              {particlItemActions(chosen).use.map((page) => <button key={page} type="button" className="gx-primary" onClick={() => use(chosen, page)}>Use in {OWN_PAGE_LABEL[page]}</button>)}
              <button type="button" className="gx-hbtn" onClick={() => go(particlItemActions(chosen).open)}>Open in {OWN_PAGE_LABEL[particlItemActions(chosen).open]}</button>
            </div>
          </div>
        ) : null}
        {problem ? <p className="gx-gen-error" role="alert">{problem}</p> : null}
      </div>
    </section>
  );
}
