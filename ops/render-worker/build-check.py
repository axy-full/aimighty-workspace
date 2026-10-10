# Build-time check (Dockerfile): Blender 5.2.2 starts offline in background
# mode, renders with Cycles on the CPU, saves a .blend and exports a GLB.
import bpy, pathlib, shutil

assert bpy.app.version == (5, 2, 2), f"Wrong Blender runtime version {bpy.app.version}"
out = pathlib.Path('/tmp/astra-build-check')
out.mkdir(parents=True, exist_ok=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1
scene.render.resolution_x = 32
scene.render.resolution_y = 32
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = str(out / 'preview.png')
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'scene.blend'), check_existing=False, compress=False)
bpy.ops.render.render(write_still=True)
bpy.ops.export_scene.gltf(filepath=str(out / 'scene.glb'), export_format='GLB')
for name in ('scene.blend', 'preview.png', 'scene.glb'):
    artifact = out / name
    assert artifact.is_file() and artifact.stat().st_size > 0, f'{name} missing'
shutil.rmtree(out)
print('ASTRA_RENDER_WORKER_BUILD_CHECK_PASSED')
