import { astraNativeSchema, type AstraNativeSource } from './native';
import { compileAstraBlender, type AstraAssetBindings } from './blender-export';
import type { AstraScene } from './scene';
export type AstraNativeBindings = Record<string, {
    path: string;
    kind: 'model' | 'image' | 'blend';
}>;
/** Executable source is intentionally unrestricted bpy Python inside the isolated VM.
 * This compiler is not a Python security sandbox. The VM, network, input and output
 * boundaries are enforced by the host independently of anything this script does. */
export function compileAstraNativeRuntime(scene: AstraScene, value: AstraNativeSource, bindings: AstraNativeBindings): string {
    const source = astraNativeSchema.parse(value);
    const sceneBindings: AstraAssetBindings = Object.create(null);
    for (const object of scene.objects)
        if (object.assetId) {
            const b = bindings[object.assetId];
            if (!b || b.kind === 'blend')
                throw new Error('Missing base scene input.');
            sceneBindings[object.assetId] = { path: b.path, kind: b.kind };
        }
    const full = compileAstraBlender(scene, sceneBindings, { exportGlb: true });
    const marker = "scene.frame_set(scene.frame_start)\nscene.render.filepath";
    const index = full.indexOf(marker);
    if (index < 0)
        throw new Error('Blender compiler construction boundary changed.');
    const payload = { program: source.program, assets: Object.fromEntries([...new Set([...source.assetIds, ...(source.baseBlendAssetId ? [source.baseBlendAssetId] : [])])].map(id => {
            const binding = bindings[id];
            if (!binding || !/^\/vercel\/sandbox\/astra\/input\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.(?:glb|png|jpg|jpeg|webp|tiff?|bmp|blend)$/i.test(binding.path))
                throw new Error('Native asset path is invalid.');
            return [id, binding.path];
        })), base: source.baseBlendAssetId ?? null };
    const native = `\nNATIVE = json.loads(base64.b64decode('${Buffer.from(JSON.stringify(payload)).toString('base64')}'))
ASSETS = NATIVE['assets']
if NATIVE['base']:
    bpy.ops.wm.open_mainfile(filepath=ASSETS[NATIVE['base']], load_ui=False, use_scripts=False)
bpy.context.preferences.filepaths.use_scripts_auto_execute = False
exec(compile(NATIVE['program'], '<reviewed-astra-program>', 'exec'), {'__name__': '__main__', 'bpy': bpy, 'ASSETS': ASSETS})
scene = bpy.context.scene
check_resources()
if not scene.camera:
    raise ValueError('The native scene needs an active camera.')
if not 64 <= scene.render.resolution_x <= 2048 or not 64 <= scene.render.resolution_y <= 2048:
    raise ValueError('Native output dimensions must be between 64 and 2048 pixels.')
if not 1 <= scene.frame_start <= scene.frame_end <= 7200 or scene.frame_end - scene.frame_start > 1800:
    raise ValueError('Native timeline exceeds runtime bounds.')
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = max(1, min(scene.cycles.samples, 128))
scene.render.threads_mode = 'FIXED'
scene.render.threads = 2
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.use_file_extension = True
scene.render.use_compositing = True
`;
    const output = full.slice(index).replace("    bpy.ops.export_scene.gltf(filepath=", "    try:\n        bpy.ops.export_scene.gltf(filepath=").replace("\nfor filename in", "\n    except Exception as error:\n        print('Portable GLB unavailable: ' + type(error).__name__)\n\nfor filename in").replace("    artifact = output / filename\n", "    artifact = output / filename\n    if filename == 'scene.glb' and not artifact.exists():\n        continue\n");
    return full.slice(0, index) + native + output;
}
