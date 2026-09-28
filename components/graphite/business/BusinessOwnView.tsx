"use client";
import type { Project } from "@/lib/workbench/studio";
import { useShell } from "@/lib/shell/state";
import { OWN_PAGE_LABEL, type OwnPage } from "@/lib/shell/business-own";
import { useProjectLibrary } from "@/lib/workspace/library";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import { BrandTool } from "./BrandTool";
import { DesignTool } from "./DesignTool";
import { FormatTool } from "./FormatTool";
import { HooksTool } from "./HooksTool";
import { ProductTool } from "./ProductTool";
import { ReferenceTool } from "./ReferenceTool";

/**
 * Business › Particl's own tools (lib/shell/business-own.ts): one project
 * draft, edited through the revision-checked editor every Suites stage uses,
 * for every member of every workspace — none of these pages needs a
 * connected account.
 */
export function BusinessOwnView({ scope, project, page }: { scope: string; project: Project | null; page: OwnPage }) {
  if (!project) {
    return (
      <div className="bo gx-enter" data-testid={`${page}-tool`}>
        <p className="gx-empty" role="status" data-testid="business-own-no-project">Open or create a project first: {OWN_PAGE_LABEL[page]} is saved with it.</p>
      </div>
    );
  }
  return <OwnPageBody key={project.id} scope={scope} projectId={project.id} page={page} />;
}

function OwnPageBody({ scope, projectId, page }: { scope: string; projectId: string; page: OwnPage }) {
  const shell = useShell();
  const editor = useDraftEditor(scope, projectId);
  const library = useProjectLibrary(scope, projectId);
  if (editor.status !== "ready" || !editor.project) {
    /* A read that failed says so and reads again on Try again ("Retry" is a render's own word). */
    return (
      <div className="bo gx-enter" data-testid={`${page}-tool`}>
        {editor.status === "loading" ? <p className="gx-empty" role="status" data-testid="business-own-opening">Opening {OWN_PAGE_LABEL[page]}…</p> : (
          <div className="gx-retry" role="alert" data-testid="business-own-error">
            <span className="gx-gen-error">{editor.error || "This project could not be opened."}</span>
            <button type="button" className="gx-hbtn" onClick={editor.reload}>Try again</button>
          </div>
        )}
      </div>
    );
  }
  const onOpen = (to: OwnPage) => shell.goSuite("business", to);
  const items = library.items;
  switch (page) {
    case "brand": return <BrandTool scope={scope} editor={editor} items={items} />;
    case "product": return <ProductTool scope={scope} editor={editor} items={items} />;
    case "format": return <FormatTool editor={editor} onOpen={onOpen} />;
    case "hooks": return <HooksTool scope={scope} editor={editor} onOpen={onOpen} />;
    case "reference": return <ReferenceTool scope={scope} editor={editor} items={items} onOpen={onOpen} />;
    case "design": return <DesignTool scope={scope} editor={editor} items={items} />;
  }
}
