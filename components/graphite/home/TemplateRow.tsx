"use client";
import { HomeGlyph } from "./BriefBox";
import { TEMPLATES, type Template, type TemplateId } from "./home-model";

/**
 * The templates under the box (README § 1: Film and Start from a script open a Studio board, Ad campaign
 * an Ads board, Social clips a Social board). A press makes the project at once, with what the box holds.
 */
export function TemplateRow({ pending, disabled, onPick }: { pending: TemplateId | null; disabled: boolean; onPick: (template: Template) => void }) {
  return (
    <div className="gx-hm-templates" role="group" aria-label="Templates" data-testid="home-templates">
      {TEMPLATES.map((t) => (
        <button key={t.id} type="button" className="gx-hm-tpl" disabled={disabled} aria-busy={pending === t.id || undefined} onClick={() => onPick(t)} data-testid={`home-template-${t.id}`}>
          <HomeGlyph d={t.glyph} />{pending === t.id ? "Opening…" : t.label}
        </button>
      ))}
    </div>
  );
}
