import bpy, bmesh, os, math, mathutils

# =====================================================================
# Organic, fractured ice chunks for the "What we do" portfolio (igloo.inc style).
# Produces 3 seeded variants: ice-block-1.glb .. ice-block-3.glb
# Pipeline per variant: chunky cube -> jitter -> heavy Voronoi/Clouds displace
#   -> voxel remesh (organic melted surface) -> facet + chipped-bottom detail
#   -> decimate to web budget -> normalize -> smooth -> export GLB.
# Run: blender.exe --background --python ice-block.blend.py   (ICE_OUTDIR optional)
# =====================================================================

# target glTF dimensions (three.js: X=width, Y=height, Z=depth). Blender Z-up ->
# glTF Y-up, so set Blender X=width, Y=depth, Z=height. Chunky near-cube.
W, H, D = 3.4, 3.6, 2.8

OUTDIR = os.environ.get("ICE_OUTDIR", os.path.dirname(os.path.abspath(__file__)))


def new_tex(name, ttype, seed):
    t = bpy.data.textures.new(name, type=ttype)
    if hasattr(t, "noise_scale"):
        t.noise_scale = 0.35 + (seed % 3) * 0.08
    if hasattr(t, "noise_depth"):
        t.noise_depth = 2
    return t


def displace(ob, tex, strength, mid, coords='LOCAL'):
    m = ob.modifiers.new("Disp", 'DISPLACE')
    m.texture = tex
    m.strength = strength
    m.mid_level = mid
    m.texture_coords = coords
    bpy.ops.object.modifier_apply(modifier=m.name)


def make_ice(seed):
    bpy.ops.wm.read_factory_settings(use_empty=True)

    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.name = "IceBlock"
    ob.dimensions = (W, D, H)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # a couple of subdivisions + a jitter so the base chunk is already irregular
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.subdivide(number_cuts=6, smoothness=0.0)
    bpy.ops.transform.vertex_random(offset=0.14, seed=seed)
    bpy.ops.object.mode_set(mode='OBJECT')

    # heavy organic displacement: big folds (clouds) + crystalline facets (voronoi)
    displace(ob, new_tex("iceBig", 'CLOUDS', seed), 0.34, 0.5)
    displace(ob, new_tex("iceFacet", 'VORONOI', seed + 7), 0.22, 0.35)

    # voxel remesh -> even, organic, melted-ice surface
    me = ob.data
    me.remesh_voxel_size = 0.075
    me.remesh_voxel_adaptivity = 0.0
    bpy.ops.object.voxel_remesh()

    # post-remesh chip detail across the whole surface
    displace(ob, new_tex("iceChip", 'STUCCI', seed + 3), 0.06, 0.5)

    # chipped / broken bottom: jitter the lower third harder
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(ob.data)
    zs = [v.co.z for v in bm.verts]
    zmin, zmax = min(zs), max(zs)
    thr = zmin + (zmax - zmin) * 0.34
    bpy.ops.mesh.select_all(action='DESELECT')
    for v in bm.verts:
        v.select = v.co.z < thr
    bmesh.update_edit_mesh(ob.data)
    bpy.ops.transform.vertex_random(offset=0.16, seed=seed + 11)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')

    # decimate to a web-friendly budget
    dec = ob.modifiers.new("Decimate", 'DECIMATE')
    dec.ratio = 0.14
    bpy.ops.object.modifier_apply(modifier="Decimate")

    # normalize back to the intended footprint, smooth shading
    ob.dimensions = (W, D, H)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.shade_smooth()

    out = os.path.join(OUTDIR, f"ice-block-{seed}.glb")
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_normals=True, export_texcoords=False,
    )
    print(f"WROTE seed={seed} verts={len(ob.data.vertices)} tris={len(ob.data.polygons)} "
          f"dims={tuple(round(v,2) for v in ob.dimensions)} bytes={os.path.getsize(out)}")


for s in (1, 2, 3):
    make_ice(s)
