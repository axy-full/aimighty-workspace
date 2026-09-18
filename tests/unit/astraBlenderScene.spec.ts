import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { ASTRA_BLENDER_MODEL, ASTRA_SCENE_LIMITS, createAstraScene, parseAstraScene, sampleAstraObjectTransform, type AstraObject, type AstraScene } from "../../lib/astra-blender/scene";
import { compileAstraBlender, ASTRA_BLENDER_OUTPUTS, ASTRA_BLENDER_RUNTIME_LIMITS } from "../../lib/astra-blender/blender-export";

function primitive(overrides: Partial<AstraObject> = {}): AstraObject {
  return { id: "object-1", name: "Object", type: "box", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true, locked: false, material: { color: "#cc8844", metalness: 0.2, roughness: 0.6 }, keyframes: [], ...overrides };
}

function sceneWith(object: AstraObject): AstraScene {
  return { ...createAstraScene("empty"), objects: [object] };
}

function encodedPayload(script: string) {
  const encoded = script.match(/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/)?.[1];
  expect(encoded).toBeTruthy();
  return JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
}

test("templates contain independent editable scenes with deterministic primitive units", () => {
  expect(ASTRA_BLENDER_MODEL).toBe("openai/gpt-6-astra");
  for (const template of ["empty", "product", "interior", "abstract"] as const) {
    const scene = createAstraScene(template);
    expect(parseAstraScene(scene)).toEqual(scene);
    expect(scene.objects.length).toBe(template === "empty" ? 0 : template === "product" ? 4 : template === "interior" ? 7 : 3);
    expect(scene.lights.length).toBeGreaterThan(0);
    scene.lights[0].power = 0;
    expect(createAstraScene(template).lights[0].power).toBeGreaterThan(0);
  }
  expect(createAstraScene("product").objects.find(object => object.id === "product")?.position).toEqual([0, 0, 1]);
});

test("scene parsing refuses executable fields, unknown keys and prototype poison", () => {
  const scene = sceneWith(primitive());
  for (const field of ["script", "python", "__proto__", "constructor", "extra"]) {
    const candidate = JSON.parse(JSON.stringify(scene));
    Object.defineProperty(candidate, field, { value: "__import__('os').system('bad')", enumerable: true });
    expect(() => parseAstraScene(candidate)).toThrow();
  }
  expect(() => parseAstraScene({ ...scene, objects: [{ ...scene.objects[0], modifier: { type: "script" } }] })).toThrow();
  expect(() => parseAstraScene({ ...scene, render: { ...scene.render, filepath: "/tmp/injected" } })).toThrow();
  expect(() => parseAstraScene({ ...scene, camera: { ...scene.camera, driver: "execute" } })).toThrow();
});

test("scene IDs are unique across objects and lights and unsafe identifiers are rejected", () => {
  const scene = sceneWith(primitive());
  expect(() => parseAstraScene({ ...scene, objects: [scene.objects[0], scene.objects[0]] })).toThrow();
  expect(() => parseAstraScene({ ...scene, objects: [{ ...scene.objects[0], id: scene.lights[0].id }] })).toThrow();
  for (const id of ["", "../model", "__proto__", "constructor", "object name", "a".repeat(81)]) {
    expect(() => parseAstraScene(sceneWith(primitive({ id })))).toThrow();
  }
});

test("all transforms and render dimensions enforce finite bounded values", () => {
  for (const bad of [NaN, Infinity, -Infinity, 1001, -1001]) {
    expect(() => parseAstraScene(sceneWith(primitive({ position: [bad, 0, 0] })))).toThrow();
  }
  for (const bad of [0, -1, 101, NaN]) {
    expect(() => parseAstraScene(sceneWith(primitive({ scale: [bad, 1, 1] })))).toThrow();
  }
  const scene = createAstraScene();
  expect(() => parseAstraScene({ ...scene, camera: { ...scene.camera, target: scene.camera.position } })).toThrow();
  expect(() => parseAstraScene({ ...scene, render: { ...scene.render, width: 4096 } })).toThrow();
  expect(() => parseAstraScene({ ...scene, render: { ...scene.render, samples: 129 } })).toThrow();
  expect(() => parseAstraScene(sceneWith(primitive({ material: { color: "red", metalness: 0, roughness: 0.5 } })))).toThrow();
});

test("only imported objects bind canonical assets and only text objects carry text", () => {
  expect(() => parseAstraScene(sceneWith(primitive({ type: "model" })))).toThrow();
  expect(() => parseAstraScene(sceneWith(primitive({ type: "image" })))).toThrow();
  expect(() => parseAstraScene(sceneWith(primitive({ assetId: "upload-1" })))).toThrow();
  expect(() => parseAstraScene(sceneWith(primitive({ type: "model", assetId: "https://example.com/model.glb" })))).toThrow();
  expect(() => parseAstraScene(sceneWith(primitive({ type: "text" })))).toThrow();
  expect(() => parseAstraScene(sceneWith(primitive({ text: "Unexpected text" })))).toThrow();
  expect(() => parseAstraScene(sceneWith(primitive({ type: "text", text: "x".repeat(ASTRA_SCENE_LIMITS.textLength + 1) })))).toThrow();
  const scene = sceneWith(primitive({ type: "model", assetId: "upload-1" }));
  scene.objects.push(primitive({ id: "second", type: "image", assetId: "upload-1" }));
  expect(() => parseAstraScene(scene)).toThrow();
  expect(parseAstraScene(sceneWith(primitive({ type: "image", assetId: "asset:original-1" }))).objects[0].assetId).toBe("asset:original-1");
});

test("animation requires distinct ordered frames inside a bounded timeline", () => {
  const key = { frame: 1, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  for (const frames of [[1, 1], [2, 1], [0, 10], [1, 121], [1.5]]) {
    expect(() => parseAstraScene(sceneWith(primitive({ keyframes: frames.map(frame => ({ ...key, frame })) })))).toThrow();
  }
  const scene = sceneWith(primitive({ keyframes: Array.from({ length: 33 }, (_, index) => ({ ...key, frame: index + 1 })) }));
  expect(() => parseAstraScene(scene)).toThrow();
  scene.objects = Array.from({ length: 17 }, (_, index) => primitive({ id: `object-${index}`, keyframes: Array.from({ length: 32 }, (_, frame) => ({ ...key, frame: frame + 1 })) }));
  expect(() => parseAstraScene(scene)).toThrow();
  expect(() => parseAstraScene({ ...createAstraScene(), timeline: { start: 1, end: 1801, fps: 24 } })).toThrow();
  expect(() => parseAstraScene({ ...createAstraScene(), timeline: { start: 20, end: 10, fps: 24 } })).toThrow();
  expect(() => parseAstraScene({ ...createAstraScene(), timeline: { start: 1, end: 120, fps: 61 } })).toThrow();
});

test("preview sampling matches held endpoints and linear Blender Euler transforms", () => {
  const object = primitive({ keyframes: [
    { frame: 10, position: [0, 1, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { frame: 30, position: [4, 3, 0], rotation: [0, 180, 360], scale: [3, 2, 1] },
  ] });
  expect(sampleAstraObjectTransform(object, 1).position).toEqual([0, 1, 2]);
  expect(sampleAstraObjectTransform(object, 40).rotation).toEqual([0, 180, 360]);
  expect(sampleAstraObjectTransform(object, 20)).toEqual({ position: [2, 2, 1], rotation: [0, 90, 180], scale: [2, 1.5, 1] });
  expect(sampleAstraObjectTransform(primitive({ position: [1, 2, 3] }), 20).position).toEqual([1, 2, 3]);
  const sampled = sampleAstraObjectTransform(object, 10);
  sampled.position[0] = 100;
  expect(object.keyframes[0].position[0]).toBe(0);
  expect(() => sampleAstraObjectTransform(object, NaN)).toThrow();
});

test("object/light count ceilings prevent large declarative scenes", () => {
  const scene = createAstraScene();
  expect(() => parseAstraScene({ ...scene, objects: Array.from({ length: 65 }, (_, index) => primitive({ id: `object-${index}` })) })).toThrow();
  expect(() => parseAstraScene({ ...scene, lights: Array.from({ length: 13 }, (_, index) => ({ ...scene.lights[0], id: `light-${index}` })) })).toThrow();
  expect(() => parseAstraScene({ ...scene, lights: [{ ...scene.lights[0], type: "sun", power: 21 }] })).toThrow();
});

test("compiler requires real typed local bindings and rejects remote or traversal paths", () => {
  const scene = sceneWith(primitive({ type: "model", assetId: "model-1" }));
  expect(() => compileAstraBlender(scene)).toThrow(/Resolve/);
  expect(() => compileAstraBlender(scene, { "model-1": { path: "/assets/model.glb", kind: "image" } })).toThrow(/Resolve/);
  expect(() => compileAstraBlender(scene, Object.create({ "model-1": { path: "/assets/model.glb", kind: "model" } }))).toThrow(/Resolve/);
  for (const path of ["https://example.com/model.glb", "assets/model.glb", "/assets/../secret.glb", "/assets/./model.glb", "//host/model.glb", "/assets/model\n.glb", "/assets/model.blend", "/assets/model.gltf"]) {
    expect(() => compileAstraBlender(scene, { "model-1": { path, kind: "model" } })).toThrow();
  }
  const payload = encodedPayload(compileAstraBlender(scene, { "model-1": { path: "/sandbox/assets/model.glb", kind: "model" }, unused: { path: "/ignored.glb", kind: "model" } }));
  expect(payload.bindings).toEqual({ "model-1": { path: "/sandbox/assets/model.glb", kind: "model" } });
  expect(() => compileAstraBlender(sceneWith(primitive({ type: "image", assetId: "image-1" })), { "image-1": { path: "/sandbox/assets/image.svg", kind: "image" } })).toThrow();
});

test("compiler embeds all user strings as JSON data and produces one fixed program", () => {
  const payloadText = "'); __import__('os').system('never-execute'); #\\n🌌";
  const scene = sceneWith(primitive({ name: payloadText, type: "text", text: payloadText }));
  const code = compileAstraBlender(scene, {}, { exportGlb: true });
  expect(code).not.toContain(payloadText);
  expect(code).not.toMatch(/\b(?:eval|exec)\s*\(/);
  expect(code).not.toContain("subprocess");
  expect(encodedPayload(code).scene.objects[0].text).toBe(payloadText);
  expect(encodedPayload(code).exportGlb).toBe(true);
  const staticProgram = (source: string) => source.replace(/base64\.b64decode\("[A-Za-z0-9+/=]+"\)/, 'base64.b64decode("DATA")');
  expect(staticProgram(code)).toBe(staticProgram(compileAstraBlender(createAstraScene("abstract"))));
  const syntax = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<astra-blender>', 'exec')"], { input: code, encoding: "utf8", timeout: 10000 });
  expect(syntax.error, syntax.error?.message).toBeUndefined();
  expect(syntax.status, syntax.stderr).toBe(0);
});

test("compiler keeps native output, single-frame render and import resource limits explicit", () => {
  const code = compileAstraBlender(createAstraScene("abstract"), {}, { exportGlb: true });
  expect(ASTRA_BLENDER_OUTPUTS).toEqual({ blend: "scene.blend", preview: "preview.png", glb: "scene.glb" });
  expect(encodedPayload(code).limits).toEqual(ASTRA_BLENDER_RUNTIME_LIMITS);
  expect(code).toContain("scene.cycles.device = 'CPU'");
  expect(code).toContain("scene.frame_set(scene.frame_start)");
  expect(code).toContain("bpy.ops.render.render(write_still=True)");
  expect(code).toContain("point.interpolation = 'LINEAR'");
  expect(code).toContain("GLB resources must be embedded, with no external URI.");
  expect(code).toContain("check_existing=False, compress=False");
  expect(code.indexOf("bpy.ops.wm.save_as_mainfile")).toBeLessThan(code.indexOf("bpy.ops.object.convert"));
  expect(code).not.toContain("bpy.ops.wm.open_mainfile");
  expect(code).not.toContain("animation=True");
});

test("portable compiler resolves bundled assets without permitting unsafe or colliding basenames", () => {
  const scene = sceneWith(primitive({ type: "model", assetId: "model-1" }));
  const bindings = { "model-1": { path: "/sandbox/assets/model.glb", kind: "model" as const } };
  const code = compileAstraBlender(scene, bindings, { portableAssets: true, exportGlb: true });
  expect(encodedPayload(code).portableAssets).toBe(true);
  expect(code).toContain("pathlib.Path(__file__).resolve().parent / 'assets'");
  expect(code).toContain("if path.parent != root:");
  expect(encodedPayload(compileAstraBlender(scene, bindings)).portableAssets).toBe(false);
  expect(() => compileAstraBlender(scene, { "model-1": { path: "/sandbox/assets/bad name.glb", kind: "model" } }, { portableAssets: true })).toThrow();
  scene.objects.push(primitive({ id: "second", type: "model", assetId: "model-2" }));
  expect(() => compileAstraBlender(scene, { ...bindings, "model-2": { path: "/other/model.glb", kind: "model" } }, { portableAssets: true })).toThrow(/distinct/);
});
