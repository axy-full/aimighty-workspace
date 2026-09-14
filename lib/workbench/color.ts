import type { Asset, Project } from "./studio";

/** Display-referred corrections on browser-decoded SDR RGB, before the LUT. */
export type ColorGrade = {
  lutAssetId?: string;
  mix: number;
  brightness: number;
  contrast: number;
  saturation: number;
  bypassed: boolean;
};
export const defaultColorGrade: ColorGrade = {
  mix: 1,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  bypassed: false,
};
export function colorActive(grade?: ColorGrade): grade is ColorGrade {
  return (
    !!grade &&
    !grade.bypassed &&
    ((!!grade.lutAssetId && grade.mix > 0) ||
      grade.brightness !== 1 ||
      grade.contrast !== 1 ||
      grade.saturation !== 1)
  );
}
export function colorLutAsset(project: Project): Asset | undefined {
  return project.assets.find(
    (asset) => asset.id === project.colorGrade?.lutAssetId,
  );
}
export function validateColor(project: Project): void {
  const grade = project.colorGrade;
  if (!grade) return;
  if (
    typeof grade.bypassed !== "boolean" ||
    !Number.isFinite(grade.mix) ||
    grade.mix < 0 ||
    grade.mix > 1 ||
    ![grade.brightness, grade.contrast, grade.saturation].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 2,
    )
  )
    throw new Error("Use valid sequence color settings.");
  if (grade.lutAssetId) {
    const asset = colorLutAsset(project);
    if (
      !asset ||
      asset.kind !== "document" ||
      !asset.uploadId ||
      asset.url !== `/api/uploads/${asset.uploadId}` ||
      !/\.cube$/i.test(asset.name)
    )
      throw new Error(
        "Keep the uploaded .cube LUT in this production's asset library.",
      );
  }
}
