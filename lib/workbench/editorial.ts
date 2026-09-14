import type { Asset, Project, Shot } from "./studio";
import { validateSequence } from "./studio";
import { audioClips, type AudioClip } from "./audio";
import type { ColorGrade } from "./color";

export type AssetBin = { id: string; name: string; assetIds: string[] };
export type EditSnapshot = {
  format: "particl.edit.v1";
  fps: number;
  aspect: string;
  shots: Shot[];
  audioClips: AudioClip[];
  clipAudio: boolean;
  colorGrade?: ColorGrade;
  assets: Asset[];
};
export type EditVersion = {
  id: string;
  label: string;
  revision: number;
  createdAt: number;
  shots: number;
  frames: number;
  fps: number;
  hash: string;
};

export function validateBins(project: Project) {
  const names = new Set<string>(),
    ids = new Set<string>(),
    assets = new Set(project.assets.map((a) => a.id));
  for (const bin of project.bins ?? []) {
    const name = bin.name.trim().toLowerCase();
    if (!name || names.has(name) || ids.has(bin.id))
      throw Error("Use a unique name and identity for each asset bin.");
    if (
      new Set(bin.assetIds).size !== bin.assetIds.length ||
      bin.assetIds.some((id) => !assets.has(id))
    )
      throw Error("A bin contains duplicate or missing assets.");
    names.add(name);
    ids.add(bin.id);
  }
}

/** Freeze selected source records and their lineage without copying unrelated canvas work. */
export function captureEdit(project: Project): EditSnapshot {
  validateSequence(project);
  const all = new Map(project.assets.map((a) => [a.id, a])),
    seen = new Set<string>(),
    assets: Asset[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    const asset = all.get(id);
    if (!asset)
      throw Error(
        "An edit source or reference is missing. Repair its binding before saving a version.",
      );
    seen.add(id);
    assets.push(asset);
    for (const ref of [
      ...asset.refs,
      ...(asset.parentId ? [asset.parentId] : []),
    ])
      visit(ref);
  };
  for (const shot of project.shots) visit(shot.assetId);
  const audio = audioClips(project);
  for (const clip of audio) visit(clip.assetId);
  if (project.colorGrade?.lutAssetId) visit(project.colorGrade.lutAssetId);
  return structuredClone({
    format: "particl.edit.v1",
    fps: project.fps,
    aspect: project.aspect,
    shots: project.shots,
    audioClips: audio,
    clipAudio: project.clipAudio !== false,
    colorGrade: project.colorGrade,
    assets,
  });
}

/** Restore editorial decisions only. Never silently replace a source identity used elsewhere. */
export function applyEdit(project: Project, edit: EditSnapshot): Project {
  if (edit.format !== "particl.edit.v1")
    throw Error("This edit version is not supported.");
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  for (const frozen of edit.assets) {
    const current = assets.get(frozen.id);
    if (
      current &&
      (current.url !== frozen.url ||
        current.kind !== frozen.kind ||
        current.uploadId !== frozen.uploadId ||
        current.generationId !== frozen.generationId)
    )
      throw Error(
        "A source identity changed after this version was saved. Restore its original source before restoring the edit.",
      );
    if (!current) assets.set(frozen.id, structuredClone(frozen));
  }
  if (assets.size > 500)
    throw Error(
      "Restoring these sources would exceed the 500-asset limit. Make room before restoring.",
    );
  const next = {
    ...project,
    fps: edit.fps,
    aspect: edit.aspect,
    shots: structuredClone(edit.shots),
    audioClips: structuredClone(edit.audioClips),
    audioAssetId: undefined,
    clipAudio: edit.clipAudio,
    colorGrade: structuredClone(edit.colorGrade),
    assets: [...assets.values()],
  };
  validateSequence(next);
  return next;
}
