'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { sampleAstraObjectTransform, type AstraScene, type AstraObject, type AstraVector3 } from '@/lib/astra-blender/scene';
import { ASTRA_GLB_BYTES, astraTextureDimensions, validateAstraGlb } from '@/lib/astra-blender/glb';
import type { AstraAssetPreviews, AstraTransform, AstraTransformMode, AstraViewportActions } from './types';
import styles from './astra-blender.module.css';

type Props = {
  scene: AstraScene;
  frame: number;
  selectedId: string | null;
  mode: AstraTransformMode;
  grid: boolean;
  playing: boolean;
  assetPreviews: AstraAssetPreviews;
  onSelect: (id: string | null) => void;
  onTransform: (id: string, transform: AstraTransform) => void;
  onReady: (actions: AstraViewportActions | null) => void;
};

function disposeTree(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (object instanceof THREE.DirectionalLight || object instanceof THREE.PointLight || object instanceof THREE.SpotLight) object.shadow.dispose();
    if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
  });
  for (const texture of textures) {
    const source = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
    texture.dispose();
  }
}

async function trustedAsset(url: string, signal: AbortSignal) {
  // Only the application integration can bind an asset to a scene object.
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) throw new Error('Use a project asset with an application preview URL.');
  const resolved = new URL(url, window.location.origin);
  if (resolved.origin !== window.location.origin) throw new Error('External preview URLs are not supported.');
  const response = await fetch(resolved, { signal, credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error('This project asset could not be loaded.');
  const limit = ASTRA_GLB_BYTES;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Preview assets must be smaller than 32 MB.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The asset response was empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('Preview assets must be smaller than 32 MB.'); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}

function geometry(type: AstraObject['type']) {
  switch (type) {
    case 'sphere': return new THREE.SphereGeometry(.5, 32, 24);
    case 'cylinder': return new THREE.CylinderGeometry(.5, .5, 1, 32).rotateX(Math.PI / 2);
    case 'cone': return new THREE.ConeGeometry(.5, 1, 32).rotateX(Math.PI / 2);
    case 'plane': case 'image': return new THREE.PlaneGeometry(1, 1);
    case 'torus': return new THREE.TorusGeometry(.375, .125, 16, 48);
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

function textMesh(object: AstraObject) {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (context) {
    context.font = '180px sans-serif';
    context.fillStyle = object.material.color;
    context.textBaseline = 'alphabetic';
    context.fillText(object.text || 'Text', 8, 200, 2030);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 1), material);
  mesh.position.set(3.9, .35, 0);
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

type Runtime = {
  setScene: (scene: AstraScene, previews: AstraAssetPreviews) => void;
  setFrame: (frame: number) => void;
  setSelection: (id: string | null, playing: boolean) => void;
  setMode: (mode: AstraTransformMode) => void;
  setGrid: (value: boolean) => void;
  dispose: () => void;
};

export default function AstraViewport(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const callbacks = useRef({ onSelect: props.onSelect, onTransform: props.onTransform, onReady: props.onReady });
  const [error, setError] = useState('');
  const [assetError, setAssetError] = useState('');
  useEffect(() => { callbacks.current = { onSelect: props.onSelect, onTransform: props.onTransform, onReady: props.onReady }; }, [props.onSelect, props.onTransform, props.onReady]);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let disposed = false;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); }
    catch {
      queueMicrotask(() => { if (!disposed) setError('3D preview needs WebGL. Scene controls, saving, and Blender exports remain available.'); });
      return () => { disposed = true; };
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D viewport');
    renderer.domElement.setAttribute('role', 'img');
    container.appendChild(renderer.domElement);
    RectAreaLightUniformsLib.init();

    const stage = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, .01, 4000);
    camera.up.set(0, 0, 1);
    camera.position.set(5, -7, 4);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.minDistance = .1;
    orbit.maxDistance = 2000;
    orbit.target.set(0, 0, .5);
    orbit.update();
    const transform = new TransformControls(camera, renderer.domElement);
    transform.setSize(.8);
    const gizmo = transform.getHelper();
    stage.add(gizmo);
    const grid = new THREE.GridHelper(40, 40, 0x4b4d56, 0x2e3038);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -.002;
    stage.add(grid);
    const axes = new THREE.AxesHelper(1.5);
    stage.add(axes);
    const box = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color('#6eb4ff'));
    box.visible = false;
    stage.add(box);
    const content = new THREE.Group();
    const lights = new THREE.Group();
    stage.add(content, lights);
    const objects = new Map<string, THREE.Object3D>();
    const objectSignatures = new Map<string, string>();
    const assetLoads = new Map<string, AbortController>();
    const assetProblems = new Map<string, string>();
    const reportAssetProblems = () => setAssetError(assetProblems.values().next().value ?? '');
    let current: AstraScene | null = null;
    let selected: string | null = null;
    let currentFrame = 1;
    let playing = false;
    let visible = true;
    let cameraSignature = '';
    let pointerStart: { x: number; y: number; transforming: boolean } | null = null;
    let changed = false;
    let pendingFrame: number | null = null;
    let needsRender = true;
    let updatingOrbit = false;
    let dampingFrames = 0;
    let contextLost = false;
    const canRender = () => !disposed && visible && !document.hidden && !contextLost;
    const cancelFrame = () => {
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    };
    const invalidate = () => {
      needsRender = true;
      if (canRender() && pendingFrame === null) pendingFrame = requestAnimationFrame(drawFrame);
    };
    const drawFrame = () => {
      pendingFrame = null;
      if (!canRender()) return;
      const requested = needsRender;
      needsRender = false;
      updatingOrbit = true;
      let moving = orbit.update();
      if ((moving && ++dampingFrames >= 180) || (!moving && dampingFrames > 0)) {
        // Finish any residual inertia without leaving an unbounded RAF loop.
        // Clear sub-pixel residuals at rest too, so later scene invalidations
        // cannot make the camera drift after the orbit gesture has settled.
        orbit.enableDamping = false;
        orbit.update();
        orbit.enableDamping = true;
        moving = false;
      }
      updatingOrbit = false;
      if (requested || moving) renderer.render(stage, camera);
      if (moving) invalidate(); else dampingFrames = 0;
    };
    const onOrbitChange = () => {
      // update() dispatches change synchronously. Schedule its next damping
      // frame above, so that event cannot keep an otherwise idle loop alive.
      if (!updatingOrbit) { dampingFrames = 0; invalidate(); }
    };
    orbit.addEventListener('change', onOrbitChange);

    const updateSelection = () => {
      const object = selected ? objects.get(selected) : null;
      const source = current?.objects.find((item) => item.id === selected);
      if (object && source?.visible) {
        box.box.setFromObject(object);
        box.visible = !box.box.isEmpty();
        if (!source.locked && !playing) transform.attach(object); else transform.detach();
      } else { box.visible = false; transform.detach(); }
      invalidate();
    };
    const applyFrame = () => {
      for (const source of current?.objects ?? []) {
        const object = objects.get(source.id);
        if (!object || transform.dragging && object === transform.object) continue;
        const sampled = sampleAstraObjectTransform(source, currentFrame);
        object.position.fromArray(sampled.position);
        object.rotation.set(...sampled.rotation.map(THREE.MathUtils.degToRad) as AstraVector3, 'XYZ');
        object.scale.fromArray(sampled.scale);
        object.visible = source.visible;
      }
      content.updateMatrixWorld(true);
      updateSelection();
    };
    const restoreCamera = () => {
      if (!current) return;
      camera.position.fromArray(current.camera.position);
      camera.setFocalLength(current.camera.focalLength);
      orbit.target.fromArray(current.camera.target);
      orbit.update();
      invalidate();
    };
    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      // Mobile panel switching hides, but does not destroy, the viewport. Keep
      // its last real resolution so exports from the Output tab remain useful.
      visible = width >= 2 && height >= 2;
      if (!visible) { cancelFrame(); return; }
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      invalidate();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();
    const onVisibilityChange = () => { if (document.hidden) cancelFrame(); else resize(); };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const onPointerDown = (event: PointerEvent) => { pointerStart = { x: event.clientX, y: event.clientY, transforming: transform.dragging || !!transform.axis }; };
    const onPointerUp = (event: PointerEvent) => {
      if (!pointerStart || pointerStart.transforming || event.button !== 0 || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1), camera);
      const hit = raycaster.intersectObjects([...objects.values()].filter((object) => object.visible), true)[0];
      let object: THREE.Object3D | null | undefined = hit?.object;
      while (object && !object.userData.astraId) object = object.parent;
      callbacks.current.onSelect(object?.userData.astraId ?? null);
    };
    const onDrag = (event: { value?: unknown }) => { orbit.enabled = !event.value; };
    const onChange = () => { changed = true; if (transform.object) box.box.setFromObject(transform.object); invalidate(); };
    const onTransformEnd = () => {
      const object = transform.object;
      if (object && changed) callbacks.current.onTransform(object.userData.astraId, {
        position: object.position.toArray() as AstraVector3,
        rotation: [object.rotation.x, object.rotation.y, object.rotation.z].map(THREE.MathUtils.radToDeg) as AstraVector3,
        scale: object.scale.toArray().map((value) => Math.max(.001, value)) as AstraVector3,
      });
      changed = false;
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    transform.addEventListener('dragging-changed', onDrag);
    transform.addEventListener('objectChange', onChange);
    transform.addEventListener('change', invalidate);
    transform.addEventListener('mouseUp', onTransformEnd);
    const onContextLost = (event: Event) => { event.preventDefault(); contextLost = true; cancelFrame(); setError('The browser lost its graphics connection. Reload the workspace to restore the viewport. Your scene is saved.'); };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    runtime.current = {
      setScene: (scene, previews) => {
        current = scene;
        transform.detach();
        const ids = new Set(scene.objects.map((object) => object.id));
        for (const [id, object] of objects) {
          if (ids.has(id)) continue;
          assetLoads.get(id)?.abort();
          assetLoads.delete(id);
          assetProblems.delete(id);
          objectSignatures.delete(id);
          content.remove(object);
          disposeTree(object);
          objects.delete(id);
        }
        disposeTree(lights);
        lights.clear();
        stage.background = new THREE.Color(scene.world.color);
        lights.add(new THREE.AmbientLight(scene.world.color, scene.world.strength));
        for (const source of scene.lights) {
          const light = source.type === 'sun'
            ? new THREE.DirectionalLight(source.color, source.power)
            : source.type === 'area'
              ? new THREE.RectAreaLight(source.color, source.power / Math.max(Math.PI * source.size ** 2, .001), source.size, source.size)
              : new THREE.PointLight(source.color, source.power / (4 * Math.PI), 0, 2);
          light.position.fromArray(source.position);
          light.rotation.set(...source.rotation.map(THREE.MathUtils.degToRad) as AstraVector3, 'XYZ');
          if (light instanceof THREE.DirectionalLight) {
            light.target.position.copy(light.position).add(new THREE.Vector3(0, 0, -1).applyEuler(light.rotation));
            lights.add(light.target);
            light.castShadow = true;
          }
          if (light instanceof THREE.PointLight) light.castShadow = true;
          lights.add(light);
        }
        for (const source of scene.objects) {
          const preview = source.assetId ? previews[source.assetId] : undefined;
          const objectSignature = JSON.stringify([source.type, source.material, source.text, source.assetId, preview?.url, preview?.kind]);
          if (objectSignatures.get(source.id) === objectSignature) continue;
          const previous = objects.get(source.id);
          assetLoads.get(source.id)?.abort();
          assetLoads.delete(source.id);
          assetProblems.delete(source.id);
          if (previous) { content.remove(previous); disposeTree(previous); }
          objectSignatures.set(source.id, objectSignature);
          const material = new THREE.MeshStandardMaterial({ ...source.material, side: THREE.DoubleSide });
          const object = source.type === 'text' ? textMesh(source) : new THREE.Mesh(geometry(source.type), material);
          if (source.type === 'text') material.dispose();
          object.userData.astraId = source.id;
          object.name = source.name;
          object.castShadow = true;
          object.receiveShadow = true;
          content.add(object);
          objects.set(source.id, object);
          if (source.type === 'model' || source.type === 'image') {
            if (!preview || preview.kind !== source.type) { assetProblems.set(source.id, 'Some scene assets are unbound. Choose a project asset in Object properties.'); continue; }
            const load = new AbortController();
            assetLoads.set(source.id, load);
            const signal = load.signal;
            trustedAsset(preview.url, signal).then(async (bytes) => {
              if (signal.aborted || disposed) return;
              if (source.type === 'image') {
                const imageBytes = new Uint8Array(bytes);
                const header = new TextDecoder('ascii').decode(imageBytes.subarray(0, 12));
                const mime = imageBytes[0] === 0x89 && header.slice(1, 4) === 'PNG' ? 'image/png'
                  : imageBytes[0] === 0xff && imageBytes[1] === 0xd8 ? 'image/jpeg'
                    : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP' ? 'image/webp' : null;
                if (!mime) throw new Error('Use a PNG, JPEG or WebP image for the browser preview.');
                astraTextureDimensions(imageBytes, mime);
                const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'flipY' });
                if (disposed || signal.aborted) { bitmap.close(); return; }
                if (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 16_777_216) {
                  bitmap.close();
                  throw new Error('Use an image up to 8192 pixels per side and 16 megapixels for the 3D preview.');
                }
                const texture = new THREE.Texture(bitmap);
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.needsUpdate = true;
                material.map = texture;
                material.color.set('#ffffff');
                material.needsUpdate = true;
                invalidate();
                return;
              }
              validateAstraGlb(new Uint8Array(bytes));
              const manager = new THREE.LoadingManager();
              manager.setURLModifier((url) => {
                if (url.startsWith('blob:')) return url;
                throw new Error('External GLB resources are blocked.');
              });
              const gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
              if (disposed || signal.aborted) { disposeTree(gltf.scene); return; }
              const wrapper = new THREE.Group();
              gltf.scene.rotation.x = Math.PI / 2; // glTF is Y-up; the workspace and Blender are Z-up.
              gltf.scene.traverse((child) => { if (child instanceof THREE.Mesh) { child.castShadow = true; child.receiveShadow = true; } });
              wrapper.add(gltf.scene);
              wrapper.userData.astraId = source.id;
              wrapper.name = source.name;
              content.remove(object);
              disposeTree(object);
              content.add(wrapper);
              objects.set(source.id, wrapper);
              applyFrame();
            }).catch((problem: unknown) => {
              if (signal.aborted || disposed) return;
              assetProblems.set(source.id, problem instanceof Error ? problem.message : 'The asset could not be previewed.');
              reportAssetProblems();
            });
          }
        }
        reportAssetProblems();
        const nextSignature = JSON.stringify(scene.camera);
        if (cameraSignature !== nextSignature) { cameraSignature = nextSignature; restoreCamera(); }
        applyFrame();
      },
      setFrame: (frame) => { currentFrame = frame; applyFrame(); },
      setSelection: (id, isPlaying) => { selected = id; playing = isPlaying; updateSelection(); },
      setMode: (mode) => { transform.setMode(mode); invalidate(); },
      setGrid: (value) => { grid.visible = value; axes.visible = value; invalidate(); },
      dispose: () => {
        disposed = true;
        for (const controller of assetLoads.values()) controller.abort();
        cancelFrame();
        resizeObserver.disconnect();
        document.removeEventListener('visibilitychange', onVisibilityChange);
        renderer.domElement.removeEventListener('pointerdown', onPointerDown);
        renderer.domElement.removeEventListener('pointerup', onPointerUp);
        renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
        transform.removeEventListener('dragging-changed', onDrag);
        transform.removeEventListener('objectChange', onChange);
        transform.removeEventListener('change', invalidate);
        transform.removeEventListener('mouseUp', onTransformEnd);
        orbit.removeEventListener('change', onOrbitChange);
        transform.dispose();
        orbit.dispose();
        disposeTree(content);
        disposeTree(lights);
        grid.dispose();
        axes.dispose();
        box.geometry.dispose();
        (box.material as THREE.Material).dispose();
        renderer.dispose();
        renderer.domElement.remove();
      },
    };
    callbacks.current.onReady({
      resetView: restoreCamera,
      frameSelection: () => {
        const object = selected ? objects.get(selected) : content;
        if (!object) return;
        const bounds = new THREE.Box3().setFromObject(object);
        if (bounds.isEmpty()) return;
        const center = bounds.getCenter(new THREE.Vector3());
        const distance = Math.max(bounds.getSize(new THREE.Vector3()).length() * 1.8, 2);
        const direction = camera.position.clone().sub(orbit.target).normalize();
        orbit.target.copy(center);
        camera.position.copy(center).addScaledVector(direction, distance);
        orbit.update();
        invalidate();
      },
      getCamera: () => ({ position: camera.position.toArray() as AstraVector3, target: orbit.target.toArray() as AstraVector3, focalLength: camera.getFocalLength() }),
      downloadPng: () => {
        const shown = [grid.visible, axes.visible, box.visible, gizmo.visible];
        grid.visible = axes.visible = box.visible = gizmo.visible = false;
        try {
          renderer.render(stage, camera);
          const link = document.createElement('a');
          link.href = renderer.domElement.toDataURL('image/png');
          link.download = `astra-viewport-frame-${currentFrame}.png`;
          link.click();
        } catch { setAssetError('The browser could not export this preview. Use the Blender render export.'); }
        finally {
          [grid.visible, axes.visible, box.visible, gizmo.visible] = shown;
          invalidate();
        }
      },
    });
    return () => { runtime.current?.dispose(); runtime.current = null; callbacks.current.onReady(null); };
  }, []);
  useEffect(() => { runtime.current?.setScene(props.scene, props.assetPreviews); }, [props.scene, props.assetPreviews]);
  useEffect(() => { runtime.current?.setFrame(props.frame); }, [props.frame]);
  useEffect(() => { runtime.current?.setSelection(props.selectedId, props.playing); }, [props.selectedId, props.playing]);
  useEffect(() => { runtime.current?.setMode(props.mode); }, [props.mode]);
  useEffect(() => { runtime.current?.setGrid(props.grid); }, [props.grid]);
  return <div className={styles.viewportRoot}>
    <div className={styles.canvasHost} ref={host} />
    {error && <div className={styles.viewportError} role="status">{error}</div>}
    {assetError && <div className={styles.assetNotice} role="status">{assetError}</div>}
    <div className={styles.viewportLabel}><span className={styles.liveDot} />Interactive preview <span>Perspective · Z up · meters</span></div>
    <div className={styles.viewportHelp}>Drag to orbit · Scroll to zoom · Shift-drag to pan</div>
  </div>;
}
