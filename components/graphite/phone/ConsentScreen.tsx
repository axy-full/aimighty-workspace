"use client";
import type { Project } from "@/lib/workbench/studio";
import { consentProjectKey, dateWords } from "@/lib/security/consent-words";
import { ConsentForm } from "@/components/graphite/security/ConsentForm";
import "@/components/graphite/security/security.css";

/**
 * The phone's consent step (Gaps A, "?device=phone&screen=consent"): the same form as the board's dialog, full
 * screen, every target 44 px. It records for one cast member of the open project (`cast=`, the Cast card's id), and
 * only a signed-in person can press it; the route refuses tokens and agents.
 */
export function castLabelOf(project: Project | null, cast: string | null): string {
  if (!project || !cast) return "";
  const node = project.nodes.find((n) => n.id === cast);
  if (node) return node.title.trim();
  const entry = cast.startsWith("cast:cast:") ? project.production?.cast?.entries.find((e) => e.id === cast.slice("cast:cast:".length)) : undefined;
  return entry?.name.trim() ?? "";
}

export function ConsentScreen({ scope, project, cast, onDone, onCancel }: {
  scope: string; project: Project | null; cast: string | null;
  onDone: (line: string) => void; onCancel: () => void;
}) {
  const label = castLabelOf(project, cast);
  if (!project || !cast || !label) {
    return (
      <main className="ph-scroll" data-testid="phone-consent-missing">
        <p className="gsec-sub gsec-phone-note">Open the cast member on the board first; their consent is recorded from there.</p>
      </main>
    );
  }
  return (
    <main className="ph-scroll" data-testid="phone-consent">
      <ConsentForm scope={scope} projectId={consentProjectKey(project)} subjectKey={cast} subjectLabel={label} layout="phone"
        onCancel={onCancel} onDone={(c) => onDone(`Consent recorded · by you · until ${dateWords(c.untilAt)}`)} />
    </main>
  );
}
