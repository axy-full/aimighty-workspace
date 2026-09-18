import { parseAstraScene, type AstraScene } from "./scene";

export type AstraAssetBinding = { path: string; kind: "model" | "image" };
export type AstraAssetBindings = Record<string, AstraAssetBinding>;
export const ASTRA_BLENDER_OUTPUTS = { blend: "scene.blend", preview: "preview.png", glb: "scene.glb" } as const;
export const ASTRA_BLENDER_RUNTIME_LIMITS = {
  assetBytes: 50 * 1024 * 1024,
  importedObjects: 256,
  totalObjects: 1024,
  meshVertices: 1_000_000,
  meshPolygons: 1_000_000,
  imageDimension: 8192,
  imagePixels: 16_777_216,
  texturePixels: 33_554_432,
  artifactBytes: 256 * 1024 * 1024,
  timeoutMs: 180_000,
} as const;

/**
 * Compile only validated declarative data into this fixed program. Bindings
 * must be resolved by the server from canonical project assets into downloaded
 * local files; never accept filesystem paths from the browser or model.
 *
 * Run in a disposable, credential-free sandbox with outbound network disabled,
 * a hard wall-clock limit <= timeoutMs, process memory/CPU limits, and bounded
 * artifact collection. Scene limits do not bound native decoder allocations.
 * Command arguments: blender --background --factory-startup --disable-autoexec
 * --python scene.py -- /absolute/trusted/output-directory
 *
 * Blender 5.x documented APIs used here:
 * https://docs.blender.org/api/5.2/info_quickstart.html#animation
 * https://docs.blender.org/api/5.2/bpy.ops.import_scene.html
 * https://docs.blender.org/api/5.2/bpy.ops.export_scene.html
 * https://docs.blender.org/api/5.2/bpy.ops.render.html
 * https://docs.blender.org/api/5.2/bpy.ops.wm.html
 */
export function compileAstraBlender(
  value: AstraScene,
  bindings: AstraAssetBindings = {},
  options: { exportGlb?: boolean; portableAssets?: boolean } = {},
): string {
  const scene = parseAstraScene(value);
  if (options.exportGlb !== undefined && typeof options.exportGlb !== "boolean") throw new Error("Use a boolean GLB export option.");
  if (options.portableAssets !== undefined && typeof options.portableAssets !== "boolean") throw new Error("Use a boolean portable-assets option.");
  const resolved: AstraAssetBindings = Object.create(null);
  const portableNames = new Map<string, string>();
  for (const object of scene.objects) {
    if (!object.assetId) continue;
    const binding = Object.prototype.hasOwnProperty.call(bindings, object.assetId) ? bindings[object.assetId] : undefined;
    if (!binding || binding.kind !== object.type) throw new Error(`Resolve the ${object.type} asset ${object.assetId} before rendering.`);
    const path = binding.path;
    if (typeof path !== "string" || path.length > 4096 || !path.startsWith("/") || path.startsWith("//") || /[\u0000-\u001f]/.test(path) || path.split("/").some(part => part === ".." || part === "."))
      throw new Error("Renderer assets require trusted absolute local paths.");
    if (binding.kind === "model" ? !/\.glb$/i.test(path) : !/\.(png|jpe?g|webp|tiff?|bmp)$/i.test(path))
      throw new Error("Use embedded GLB models or supported raster images.");
    if (options.portableAssets) {
      const basename = path.split("/").at(-1)!;
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(basename) || (portableNames.has(basename) && portableNames.get(basename) !== path))
        throw new Error("Portable renderer assets require distinct safe filenames.");
      portableNames.set(basename, path);
    }
    resolved[object.assetId] = { path, kind: binding.kind };
  }
  // This is the only dynamic insertion. Base64's alphabet cannot terminate a
  // Python string, and its decoded contents are passed exclusively to JSON.
  const payload = Buffer.from(JSON.stringify({ scene, bindings: resolved, exportGlb: options.exportGlb ?? false, portableAssets: options.portableAssets ?? false, limits: ASTRA_BLENDER_RUNTIME_LIMITS }), "utf8").toString("base64");
  return `# Astra blender: generated from a bounded scene document, never model code.
import base64
import json
import math
import pathlib
import struct
import sys

import bpy
from mathutils import Vector

PAYLOAD = json.loads(base64.b64decode("${payload}").decode("utf-8"))
SPEC = PAYLOAD["scene"]
BINDINGS = PAYLOAD["bindings"]
LIMITS = PAYLOAD["limits"]
args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(args) != 1 or not pathlib.Path(args[0]).is_absolute():
    raise ValueError("Supply exactly one trusted absolute output directory.")
output = pathlib.Path(args[0]).resolve()
output.mkdir(parents=True, exist_ok=True)
if bpy.app.version < (5, 0, 0):
    raise RuntimeError("Astra blender requires Blender 5 or newer.")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.use_scripts_auto_execute = False
scene = bpy.context.scene
scene.name = SPEC["name"]
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = SPEC["render"]["samples"]
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 6
scene.render.resolution_x = SPEC["render"]["width"]
scene.render.resolution_y = SPEC["render"]["height"]
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = SPEC["render"]["transparent"]
scene.render.fps = SPEC["timeline"]["fps"]
scene.frame_start = SPEC["timeline"]["start"]
scene.frame_end = SPEC["timeline"]["end"]
scene.render.threads_mode = 'FIXED'
scene.render.threads = 2
scene.view_settings.view_transform = 'AgX'

def linear_color(value):
    rgb = [int(value[i:i + 2], 16) / 255.0 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in rgb)

def radians(values):
    return tuple(math.radians(value) for value in values)

def assign_transform(obj, spec):
    obj.rotation_mode = 'XYZ'
    obj.location = spec["position"]
    obj.rotation_euler = radians(spec["rotation"])
    obj.scale = spec["scale"]

def make_material(spec):
    material = bpy.data.materials.new(spec["name"] + " material")
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    rgba = (*linear_color(spec["material"]["color"]), 1.0)
    shader.inputs['Base Color'].default_value = rgba
    shader.inputs['Metallic'].default_value = spec["material"]["metalness"]
    shader.inputs['Roughness'].default_value = spec["material"]["roughness"]
    material.diffuse_color = rgba
    return material

def asset_path(spec):
    binding = BINDINGS[spec["assetId"]]
    if binding["kind"] != spec["type"]:
        raise ValueError("Asset kind changed.")
    if PAYLOAD['portableAssets']:
        root = (pathlib.Path(__file__).resolve().parent / 'assets').resolve(strict=True)
        path = (root / pathlib.Path(binding['path']).name).resolve(strict=True)
        if path.parent != root:
            raise ValueError("Portable asset escaped its assets directory.")
    else:
        path = pathlib.Path(binding["path"]).resolve(strict=True)
    if not path.is_file() or path.stat().st_size > LIMITS["assetBytes"]:
        raise ValueError("Asset exceeds the bounded input size.")
    return path

def validate_glb(path):
    # The native importer must never resolve a GLB URI into another local file
    # or the network. Only binary GLB with fully embedded resources is allowed.
    with path.open('rb') as source:
        header = source.read(12)
        if len(header) != 12:
            raise ValueError("Invalid GLB header.")
        magic, version, length = struct.unpack('<4sII', header)
        if magic != b'glTF' or version != 2 or length != path.stat().st_size:
            raise ValueError("Use a valid GLB 2 model.")
        chunk_header = source.read(8)
        if len(chunk_header) != 8:
            raise ValueError("Missing GLB JSON chunk.")
        count, chunk_type = struct.unpack('<II', chunk_header)
        if chunk_type != 0x4E4F534A or count > 4 * 1024 * 1024 or count > length - 20:
            raise ValueError("GLB metadata exceeds the input limit.")
        data = json.loads(source.read(count))
    for kind in ('buffers', 'images'):
        if any('uri' in item for item in data.get(kind, [])):
            raise ValueError("GLB resources must be embedded, with no external URI.")
    if len(data.get('nodes', [])) > LIMITS['importedObjects'] or len(data.get('images', [])) > 32:
        raise ValueError("GLB contains too many objects or textures.")
    if sum(int(item.get('count', 0)) for item in data.get('accessors', [])) > LIMITS['meshVertices'] * 8:
        raise ValueError("GLB accessor data exceeds the scene limit.")
    if any(extension in data.get('extensionsUsed', []) for extension in ('KHR_draco_mesh_compression', 'EXT_meshopt_compression')):
        raise ValueError("Upload an uncompressed GLB for bounded import.")

def check_resources():
    if len(bpy.data.objects) > LIMITS['totalObjects']:
        raise ValueError("Imported scene contains too many objects.")
    if sum(len(mesh.vertices) for mesh in bpy.data.meshes) > LIMITS['meshVertices']:
        raise ValueError("Imported geometry exceeds the vertex limit.")
    if sum(len(mesh.polygons) for mesh in bpy.data.meshes) > LIMITS['meshPolygons']:
        raise ValueError("Imported geometry exceeds the polygon limit.")
    total_pixels = 0
    for image in bpy.data.images:
        if image.type == 'RENDER_RESULT':
            continue
        width, height = image.size
        if max(width, height) > LIMITS['imageDimension'] or width * height > LIMITS['imagePixels']:
            raise ValueError("An image exceeds the texture limit.")
        total_pixels += width * height
    if total_pixels > LIMITS['texturePixels']:
        raise ValueError("Scene textures exceed the total pixel limit.")

def add_animation(obj, keys):
    if not keys:
        return
    # Blender 5's layered actions: assign an explicit slot and channel bag.
    action = bpy.data.actions.new(name=obj.name + " movement")
    slot = action.slots.new(obj.id_type, obj.name)
    strip = action.layers.new("Astra transforms").strips.new(type='KEYFRAME')
    channels = strip.channelbag(slot, ensure=True)
    for property_name, source_name in (("location", "position"), ("rotation_euler", "rotation"), ("scale", "scale")):
        for axis in range(3):
            curve = channels.fcurves.new(data_path=property_name, index=axis)
            curve.extrapolation = 'CONSTANT'
            curve.keyframe_points.add(len(keys))
            for index, key in enumerate(keys):
                value = key[source_name][axis]
                if source_name == 'rotation':
                    value = math.radians(value)
                point = curve.keyframe_points[index]
                point.co = (key['frame'], value)
                point.interpolation = 'LINEAR'
            curve.update()
    animation = obj.animation_data_create()
    animation.action = action
    animation.action_slot = slot

for spec in SPEC['objects']:
    kind = spec['type']
    children = []
    if kind == 'model':
        path = asset_path(spec)
        validate_glb(path)
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True)
        imported = [obj for obj in bpy.data.objects if obj not in before]
        if len(imported) > LIMITS['importedObjects']:
            raise ValueError("GLB contains too many imported objects.")
        for child in imported:
            child.animation_data_clear()
            if child.type in {'CAMERA', 'LIGHT'}:
                bpy.data.objects.remove(child, do_unlink=True)
            else:
                children.append(child)
        obj = bpy.data.objects.new(spec['name'], None)
        scene.collection.objects.link(obj)
        for child in children:
            if child.parent not in children:
                matrix = child.matrix_world.copy()
                child.parent = obj
                child.matrix_world = matrix
    elif kind == 'text':
        data = bpy.data.curves.new(spec['name'], type='FONT')
        data.body = spec['text']
        data.align_x = 'CENTER'
        data.align_y = 'CENTER'
        data.size = 1.0
        data.extrude = 0.02
        data.resolution_u = 8
        obj = bpy.data.objects.new(spec['name'], data)
        scene.collection.objects.link(obj)
    else:
        if kind == 'box':
            bpy.ops.mesh.primitive_cube_add(size=1)
        elif kind == 'sphere':
            bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=0.5)
        elif kind == 'cylinder':
            bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.5, depth=1)
        elif kind == 'cone':
            bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=0.5, radius2=0, depth=1)
        elif kind == 'torus':
            bpy.ops.mesh.primitive_torus_add(major_radius=0.375, minor_radius=0.125, major_segments=48, minor_segments=12)
        elif kind in {'plane', 'image'}:
            bpy.ops.mesh.primitive_plane_add(size=1)
        else:
            raise ValueError("Unknown primitive.")
        obj = bpy.context.object
        if kind in {'sphere', 'cylinder', 'cone', 'torus'}:
            for face in obj.data.polygons:
                face.use_smooth = True
    obj.name = spec['name']
    obj['astra_id'] = spec['id']
    assign_transform(obj, spec)
    for item in [obj, *children]:
        item.hide_render = not spec['visible']
        item.hide_set(not spec['visible'])
        item.hide_select = spec['locked']
    if kind != 'model':
        material = make_material(spec)
        obj.data.materials.clear()
        obj.data.materials.append(material)
        if kind == 'image':
            path = asset_path(spec)
            image = bpy.data.images.load(str(path), check_existing=True)
            check_resources()
            image.pack()
            texture = material.node_tree.nodes.new('ShaderNodeTexImage')
            texture.image = image
            shader = material.node_tree.nodes.get('Principled BSDF')
            material.node_tree.links.new(texture.outputs['Color'], shader.inputs['Base Color'])
            material.node_tree.links.new(texture.outputs['Alpha'], shader.inputs['Alpha'])
    add_animation(obj, spec['keyframes'])
    check_resources()

for spec in SPEC['lights']:
    light = bpy.data.lights.new(spec['name'], type=spec['type'].upper())
    light.color = linear_color(spec['color'])
    light.energy = spec['power']
    if spec['type'] == 'area':
        light.shape = 'SQUARE'
        light.size = spec['size']
    elif spec['type'] == 'point':
        light.shadow_soft_size = spec['size']
    else:
        light.angle = math.radians(0.526)
    obj = bpy.data.objects.new(spec['name'], light)
    obj['astra_id'] = spec['id']
    scene.collection.objects.link(obj)
    obj.location = spec['position']
    obj.rotation_euler = radians(spec['rotation'])

world = bpy.data.worlds.new("Astra world")
world.use_nodes = True
background = world.node_tree.nodes.get('Background')
background.inputs['Color'].default_value = (*linear_color(SPEC['world']['color']), 1.0)
background.inputs['Strength'].default_value = SPEC['world']['strength']
scene.world = world

camera_data = bpy.data.cameras.new("Astra camera")
camera_data.lens = SPEC['camera']['focalLength']
camera_data.sensor_width = 36
camera_data.sensor_fit = 'HORIZONTAL'
camera_data.clip_start = 0.01
camera_data.clip_end = 10000
camera = bpy.data.objects.new("Astra camera", camera_data)
scene.collection.objects.link(camera)
camera.location = SPEC['camera']['position']
direction = Vector(SPEC['camera']['target']) - camera.location
camera.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
scene.camera = camera
scene.frame_set(scene.frame_start)
scene.render.filepath = str(output / 'preview.png')
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(output / 'scene.blend'), check_existing=False, compress=False)
bpy.ops.render.render(write_still=True)

if PAYLOAD['exportGlb']:
    # Keep native text editable in the saved .blend; convert only for GLB.
    bpy.ops.object.select_all(action='DESELECT')
    text_objects = [obj for obj in scene.objects if obj.type == 'FONT' and not obj.hide_render]
    for obj in text_objects:
        obj.hide_select = False
        obj.select_set(True)
    if text_objects:
        bpy.context.view_layer.objects.active = text_objects[0]
        bpy.ops.object.convert(target='MESH')
    bpy.ops.export_scene.gltf(filepath=str(output / 'scene.glb'), export_format='GLB', use_renderable=True, export_cameras=True, export_lights=True, export_animations=True, export_frame_range=True, export_yup=True)

for filename in ('scene.blend', 'preview.png') + (('scene.glb',) if PAYLOAD['exportGlb'] else ()):
    artifact = output / filename
    if not artifact.is_file() or artifact.stat().st_size > LIMITS['artifactBytes']:
        raise ValueError("Output artifact exceeds its size limit.")
print(json.dumps({'ok': True, 'files': ['scene.blend', 'preview.png'] + (['scene.glb'] if PAYLOAD['exportGlb'] else [])}))
`;
}
