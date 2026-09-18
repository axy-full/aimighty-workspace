import type { AstraScene, AstraVector3 } from '@/lib/astra-blender/scene';

/** URLs are supplied by the authenticated project integration, never by the scene or assistant. */
export type AstraAssetPreview = { url: string; kind: 'image' | 'model'; name?: string };
export type AstraAssetPreviews = Record<string, AstraAssetPreview>;
export type AstraTransformMode = 'translate' | 'rotate' | 'scale';
export type AstraTransform = { position: AstraVector3; rotation: AstraVector3; scale: AstraVector3 };
export type AstraViewportActions = {
  resetView: () => void;
  frameSelection: () => void;
  downloadPng: () => void;
  getCamera: () => AstraScene['camera'];
};
