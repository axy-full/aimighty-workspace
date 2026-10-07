"use client";
import LazyMedia from "@/components/LazyMedia";
import { ROLE_LABEL, blockingOf, moveWords, roleOf } from "@/lib/production/blocking";
import type { Project } from "@/lib/workbench/studio";
import { rigShots } from "@/lib/workspace/shots";
import { Eyebrow } from "./PhoneChrome";

/**
 * 3D blocking on the phone (gap screens): view only. Each shot with blocking saved shows its frame, its lens and move, and what is in
 * the scene. Building and saving are the desktop's: nothing here changes the project or spends anything.
 */
export function BlockingSection({ project }: { project: Project }) {
  const shots = rigShots(project, []).filter((s) => blockingOf(project, s.id));
  if (!shots.length) return null;
  return (
    <section className="ph-section" aria-label="3D blocking" data-testid="phone-blocking">
      <Eyebrow aside="view only on the phone">3D blocking</Eyebrow>
      {shots.map((shot) => {
        const entry = blockingOf(project, shot.id)!;
        const asset = entry.frameAssetId ? [...project.assets, ...(project.sharedAssets ?? [])].find((a) => a.id === entry.frameAssetId) : undefined;
        const things = entry.scene.objects.filter((o) => !o.id.startsWith("set-"));
        return (
          <div key={shot.id} className="ph-record-brief" data-testid="phone-blocking-shot" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {asset?.uploadId ? <span style={{ display: "block", aspectRatio: "16 / 9", overflow: "hidden", borderRadius: 8 }}><LazyMedia url={`/api/workbench/preview/upload/${encodeURIComponent(asset.uploadId)}`} kind="image" alt="" preview={false} /></span> : null}
            <span className="ph-row-title">Shot {shot.index} · 3D blocking</span>
            <span className="ph-row-line">{entry.scene.camera.focalLength}mm · {moveWords(entry.move)}</span>
            {things.map((o) => <span key={o.id} className="ph-row-line">{o.name} · {ROLE_LABEL[roleOf(o)].toLowerCase()}</span>)}
          </div>
        );
      })}
    </section>
  );
}
