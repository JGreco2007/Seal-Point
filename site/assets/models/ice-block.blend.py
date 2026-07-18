import bpy, bmesh, os, math, mathutils

# =====================================================================
# Organic, fractured ice chunks for the "What we've made" portfolio (igloo.inc-
# inspired surface, but each of the 3 projects gets a genuinely different silhouette).
# Pipeline per variant: chunky cube -> jitter -> shape modifier (taper/bevel/none)
#   -> heavy Voronoi/Clouds displace (sampled from a per-variant offset region of
#   the noise field, so the surfaces don't just look like the same blob rescaled)
#   -> voxel remesh (organic melted surface) -> facet + chipped-bottom detail
#   -> decimate to web budget -> normalize -> smooth -> export GLB.
# Run: blender.exe --background --python ice-block.blend.py   (ICE_OUTDIR optional)
# =====================================================================

OUTDIR = os.environ.get("ICE_OUTDIR", os.path.dirname(os.path.abspath(__file__)))

# target glTF dimensions (three.js: X=width, Y=height, Z=depth). Blender Z-up ->
# glTF Y-up, so set Blender X=width, Y=depth, Z=height.
VARIANTS = {
    # 1: classic near-cube block — the baseline chunk, balanced facets, no shape modifier.
    1: dict(
        dims=(3.4, 3.6, 2.8), jitter=0.13, noise_off=(0.0, 0.0, 0.0),
        big_scale=0.40, big_strength=0.34, facet_scale=0.30, facet_strength=0.22,
        chip_scale=0.55, taper=0.0, bevel=0.0,
    ),
    # 2: tapered spike/shard — tall and narrow, narrows toward the top like a broken iceberg point.
    2: dict(
        dims=(2.6, 4.4, 2.5), jitter=0.16, noise_off=(5.3, -3.1, 2.2),
        big_scale=0.52, big_strength=0.30, facet_scale=0.34, facet_strength=0.20,
        chip_scale=0.62, taper=-0.42, bevel=0.0,
    ),
    # 3: cleaved boulder — wide and flat, heavily bevelled corners for a faceted,
    # broken-off-a-larger-berg look, slightly overhanging (wider at the top).
    3: dict(
        dims=(4.0, 2.9, 3.3), jitter=0.15, noise_off=(-4.6, 3.8, -2.7),
        big_scale=0.32, big_strength=0.36, facet_scale=0.24, facet_strength=0.26,
        chip_scale=0.48, taper=0.16, bevel=0.34,
    ),
}


def new_tex(name, ttype, scale):
    t = bpy.data.textures.new(name, type=ttype)
    if hasattr(t, "noise_scale"):
        t.noise_scale = scale
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
    v = VARIANTS[seed]
    W, D, H = v["dims"][0], v["dims"][1], v["dims"][2]

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
    bpy.ops.transform.vertex_random(offset=v["jitter"], seed=seed)
    bpy.ops.object.mode_set(mode='OBJECT')

    # per-variant silhouette shaping, before the organic surface noise is added
    if v["taper"] != 0.0:
        m = ob.modifiers.new("Taper", 'SIMPLE_DEFORM')
        m.deform_method = 'TAPER'
        m.deform_axis = 'Z'
        m.factor = v["taper"]
        bpy.ops.object.modifier_apply(modifier=m.name)
    if v["bevel"] > 0.0:
        m = ob.modifiers.new("Bevel", 'BEVEL')
        m.width = v["bevel"]
        m.segments = 2
        m.limit_method = 'NONE'
        bpy.ops.object.modifier_apply(modifier=m.name)

    # sample the organic noise from a per-variant offset region of the (otherwise
    # shared) procedural noise field, so variants don't read as the same blob rescaled
    off = v["noise_off"]
    ob.location = off
    displace(ob, new_tex("iceBig", 'CLOUDS', v["big_scale"]), v["big_strength"], 0.5, coords='GLOBAL')
    displace(ob, new_tex("iceFacet", 'VORONOI', v["facet_scale"]), v["facet_strength"], 0.35, coords='GLOBAL')
    ob.location = (0, 0, 0)

    # voxel remesh -> even, organic, melted-ice surface
    me = ob.data
    me.remesh_voxel_size = 0.075
    me.remesh_voxel_adaptivity = 0.0
    bpy.ops.object.voxel_remesh()

    # post-remesh chip detail across the whole surface
    displace(ob, new_tex("iceChip", 'STUCCI', v["chip_scale"]), 0.06, 0.5)

    # chipped / broken bottom: jitter the lower third harder
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(ob.data)
    zs = [vt.co.z for vt in bm.verts]
    zmin, zmax = min(zs), max(zs)
    thr = zmin + (zmax - zmin) * 0.34
    bpy.ops.mesh.select_all(action='DESELECT')
    for vt in bm.verts:
        vt.select = vt.co.z < thr
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
          f"dims={tuple(round(d,2) for d in ob.dimensions)} bytes={os.path.getsize(out)}")


for s in (1, 2, 3):
    make_ice(s)
