/* ============ Seal Point — "What we do" 3D ice chunks ============ */
/* Real-time ice chunk, one per project, that spins/rolls past on scroll (currently the same
   Blender-authored geometry, assets/models/ice-cube-2.glb, reused for all three — see
   ice-block-blender-pipeline.md). Material = pure ice/glass matched to a reference Blender
   node graph (white, ior 1.309, full transmission, roughness/bump from object-space 3D
   noise) plus our own cursor-hover frost/grid glow and fresnel rim on top. The project name
   lives in the HTML HUD (main.js), not inside the block.
   Driven by main.js via window.__ice.setProgress(). Renders on demand only (scroll)
   and pauses fully when the section is off-screen.
   Add ?frosted to the URL to force a no-transmission material (so the geometry is
   visible under software WebGL, which can't render transmission). */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const FROSTED = new URLSearchParams(location.search).has('frosted') || window.__iceFrosted === true;

const canvas = document.querySelector('.pf-ice');
const projects = (window.__sp && window.__sp.projects) || [
  { name: 'Macoyosh Builders' }, { name: 'Macoyosh Drafting' }, { name: 'Corshelle Realty' },
];
const N = projects.length;

/* ---------- renderer ---------- */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

/* cool environment → reflections / refraction tint on the ice */
const pmrem = new THREE.PMREMGenerator(renderer);
function auroraEnv() {
  const w = 1024, h = 512, c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#5f8298'); g.addColorStop(0.5, '#7fa6bd'); g.addColorStop(1, '#24404f');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  [['#eaf6ff', 0.16], ['#c4e2f5', 0.34], ['#ffffff', 0.54], ['#bfe0f2', 0.72], ['#e6cfa0', 0.9]].forEach(([col, x]) => {
    const gg = ctx.createLinearGradient(0, 0, 0, h);
    gg.addColorStop(0, 'rgba(0,0,0,0)'); gg.addColorStop(0.4, col); gg.addColorStop(0.8, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.6; ctx.fillStyle = gg; ctx.fillRect(x * w - 80, 0, 160, h);
  });
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.environment = pmrem.fromEquirectangular(auroraEnv()).texture;
const sharedEnv = scene.environment;   // reused by the detail-panel ice slabs below — same PMREM, no need to regenerate it per canvas

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
camera.position.set(0, 0, 10);
camera.lookAt(0, 0, 0);
const CAM_DEFAULT_POS = camera.position.clone();
const CAM_DEFAULT_FOV = camera.fov;

/* ---------- lights (icy + faint gold accent) ---------- */
const key = new THREE.DirectionalLight(0xeaf4ff, 2.0); key.position.set(2.5, 4, 5); scene.add(key);
const rim = new THREE.DirectionalLight(0x9fd6ff, 1.6); rim.position.set(-4, 1.5, -3); scene.add(rim);
scene.add(new THREE.AmbientLight(0x2a3844, 0.7));
const teal = new THREE.PointLight(0x66d8ff, 16, 34); teal.position.set(-3.5, 2.5, 4); scene.add(teal);
const gold = new THREE.PointLight(0xd4a24c, 10, 34); gold.position.set(3.5, -2, 4); scene.add(gold);
const glint = new THREE.PointLight(0xffffff, 22, 44); glint.position.set(-1.6, 3, 6); scene.add(glint);

/* ---------- sizing (matches the Blender-authored chunks) ---------- */
const BW = 3.4, BH = 3.6, BD = 2.8;          // chunky, roughly cubic
const TUMBLE = 3.0;                           // radians of tumble (primary axis) per project-step of travel — full right-to-left crossing (2 steps) ≈ just under 1 turn, lazy roll
const tumbleAxis = new THREE.Vector3(0.32, 0.42, 1).normalize();  // tilted axis → tumbles through space, not a flat spin
const TUMBLE2 = 2.1;                          // second, independent axis/rate — composed on top for a lifelike, two-axis tumble
const tumbleAxis2 = new THREE.Vector3(1, -0.28, 0.18).normalize();
const SPIN = Math.PI * 2;                     // intro spin (one turn) for the first block, eased to a stop
const GLOW_STR = FROSTED ? 1.8 : 0.7;         // fresnel rim (louder in frosted so edges read under software GL)

/* ---------- cursor "frost" grid reveal (igloo.inc-style) ----------
   A small per-block feedback texture (ping-ponged every frame) stores a 2-channel
   field in the mesh's UV space: R = frost intensity, G = rim (this-frame growth).
   Each frame a full-screen pass takes the max of the previous frame's 4 neighbours
   (a texel "infects" its neighbour → the lit region grows outward by 1 texel/frame,
   like a flood-fill/wave) + stamps a new line-segment splat at the raycast-hit UV
   (radius driven by recent cursor speed) + decays the whole field. rim = this frame's
   value minus last frame's, so it's only nonzero at the growing edge — that's what
   reads as a travelling ring instead of a static blob. The main ice shader samples
   this buffer: rim lights up a procedural grid pattern (emissive), and frost locally
   softens roughness (a faint "melted" polish). Mesh-local (own raycast, own buffer,
   own UVs) — nothing else on the page reacts to the cursor. */
const FROST_RES = 256;
const FROST_RADIUS = 0.05;    // max splat radius, in UV units (0-1)
const FROST_DECAY = 0.93;     // per-frame retention → ~1s to fade below ~1% (tuned empirically, see memory)
const FROST_IDLE_MS = 2000;   // keep advancing (and thus decaying) a block's buffer this long after the last hit —
                               // must comfortably outlast the visual fade, or the glow freezes mid-fade instead of finishing
const GRID_SCALE = 22;        // grid cells across the UV space
const GRID_WIDTH = 0.07;      // grid line thickness (fraction of a cell)
const FROST_COLOR_A = new THREE.Color(0x2fb8ac);  // teal
const FROST_COLOR_B = new THREE.Color(0x8a5fc9);  // purple — same duo as the aurora background, blended across the surface

const _fsGeo = new THREE.PlaneGeometry(2, 2);
const _fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
_fsCam.position.z = 1;   // plane sits at z=0; camera must not be coincident with it (degenerate/culled otherwise)
const _fsScene = new THREE.Scene();
const _fsMesh = new THREE.Mesh(_fsGeo, null);
_fsMesh.frustumCulled = false;   // the custom vertex shader ignores view/projection entirely — real-camera culling is meaningless here
_fsScene.add(_fsMesh);

function advectNoise() {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
  const ctx = c.getContext('2d'), img = ctx.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    img.data[i * 4] = Math.random() * 255; img.data[i * 4 + 1] = Math.random() * 255;
    img.data[i * 4 + 2] = 0; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
let _advect;
function advectTex() { return _advect || (_advect = advectNoise()); }

const FROST_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const FROST_FRAG = `
  varying vec2 vUv;
  uniform sampler2D tPrev;
  uniform sampler2D tAdvect;
  uniform vec2 uSplatPos;
  uniform vec2 uSplatPrevPos;
  uniform float uSplatRadius;
  uniform float uTexel;

  float lineDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    return length(pa - ba * h);
  }

  // Which packed third (0/1/2) a UV.x falls into — the mesh's 3 box-projected axis groups
  // (see computeBoxUV in ice.js) share this one buffer, packed side by side. Without this,
  // the wave-propagation below has no idea those boundaries exist and just floods straight
  // across raw texels — a few seconds of hovering is enough to spread clean across all 256
  // texels of buffer width, covering all 3 groups regardless of which one was actually hit.
  float thirdOf(float x) { return floor(clamp(x, 0.0, 0.999999) * 3.0); }

  void main() {
    float myThird = thirdOf(vUv.x);
    vec2 advect = (texture2D(tAdvect, vUv * 3.0).xy * 2.0 - 1.0) * uTexel;
    vec2 uv = vUv + advect;
    vec2 offL = vec2(-uTexel, 0.0), offR = vec2(uTexel, 0.0), offT = vec2(0.0, uTexel), offB = vec2(0.0, -uTexel);
    float l = thirdOf(uv.x + offL.x) == myThird ? texture2D(tPrev, uv + offL).r : 0.0;
    float r = thirdOf(uv.x + offR.x) == myThird ? texture2D(tPrev, uv + offR).r : 0.0;
    float t = thirdOf(uv.x + offT.x) == myThird ? texture2D(tPrev, uv + offT).r : 0.0;
    float b = thirdOf(uv.x + offB.x) == myThird ? texture2D(tPrev, uv + offB).r : 0.0;
    float next = max(max(max(l, r), t), b);

    // no radius floor: once the cursor stops (velocity, and so uSplatRadius, decays to 0) the splat
    // must shrink to nothing too, or a fixed-size splat gets re-stamped at the same spot every single
    // frame forever, perfectly cancelling the decay below and pinning that spot at full brightness.
    float radius = ${FROST_RADIUS} * clamp(uSplatRadius, 0.0, 1.0);
    float d = lineDist(vUv, uSplatPrevPos, uSplatPos);
    float splatOk = thirdOf(uSplatPos.x) == myThird ? 1.0 : 0.0;   // extra guard: never splat into a group the cursor isn't actually over
    next += (1.0 - smoothstep(0.0, max(radius, 1e-4), d)) * 0.9 * step(1e-4, radius) * splatOk;

    next *= ${FROST_DECAY};
    next = clamp(next, 0.0, 1.0);

    float prevVal = texture2D(tPrev, vUv).r;
    float rim = max(next - prevVal, 0.0);
    gl_FragColor = vec4(next, rim, 0.0, 1.0);
  }
`;

function createFrost() {
  const opts = { type: THREE.FloatType, depthBuffer: false, stencilBuffer: false };
  const a = new THREE.WebGLRenderTarget(FROST_RES, FROST_RES, opts);
  const b = new THREE.WebGLRenderTarget(FROST_RES, FROST_RES, opts);
  renderer.setRenderTarget(a); renderer.clear();
  renderer.setRenderTarget(b); renderer.clear();
  renderer.setRenderTarget(null);
  const material = new THREE.ShaderMaterial({
    vertexShader: FROST_VERT,
    fragmentShader: FROST_FRAG,
    uniforms: {
      tPrev: { value: a.texture },
      tAdvect: { value: advectTex() },
      uSplatPos: { value: new THREE.Vector2(-1, -1) },
      uSplatPrevPos: { value: new THREE.Vector2(-1, -1) },
      uSplatRadius: { value: 0 },
      uTexel: { value: 1 / FROST_RES },
    },
    depthTest: false, depthWrite: false,
  });
  return {
    front: a, back: b, material,
    splatPos: new THREE.Vector2(-1, -1), splatPrevPos: new THREE.Vector2(-1, -1),
    velocity: 0, targetVelocity: 0, lastHitTime: -1e9,
    uniforms: null,   // set once the ice material compiles (see iceMaterial)
  };
}
function advanceFrost(fr) {
  fr.targetVelocity *= 0.88;
  fr.velocity += (fr.targetVelocity - fr.velocity) * 0.35;
  fr.material.uniforms.tPrev.value = fr.front.texture;
  fr.material.uniforms.uSplatPos.value.copy(fr.splatPos);
  fr.material.uniforms.uSplatPrevPos.value.copy(fr.splatPrevPos);
  fr.material.uniforms.uSplatRadius.value = fr.velocity;
  _fsMesh.material = fr.material;
  renderer.setRenderTarget(fr.back);
  renderer.render(_fsScene, _fsCam);
  renderer.setRenderTarget(null);
  const tmp = fr.front; fr.front = fr.back; fr.back = tmp;
  if (fr.uniforms) fr.uniforms.tFrost.value = fr.front.texture;
}

/* ---------- procedural ice surface: object-space 3D noise, matching a reference Blender
   material graph exactly (two independent Noise Texture -> Color Ramp chains: one drives
   roughness, one drives a Bump). Both are true 3D noise evaluated in the mesh's own local
   space (Blender's "Object" texture coordinate) rather than a UV-space texture — see
   ice-block-blender-pipeline.md for the full node-by-node mapping. Octave count is capped
   at 5 for real-time cost (Blender's "Detail 15" is far more fractal detail than survives
   at screen resolution and would be prohibitively slow evaluated per-fragment 5x/pixel). */
const ICE_NOISE_GLSL = `
  // per-corner pseudo-random *gradient* (a direction, not a scalar) — this is what makes this
  // gradient ("Perlin-style") noise instead of the boxier value noise it replaced. Value noise
  // interpolates raw random numbers at each grid corner, which — even with quintic interpolation
  // and screen-space AA (below) — still traces the underlying lattice as faint blocky/boxy
  // regions once thresholded into roughness/bump, which is exactly the "pixelated" look being
  // fixed here. Gradient noise interpolates the *dot product* of a per-corner random direction
  // with the offset to that corner instead, which has no grid bias and reads as properly organic
  // — matching what Blender's own Noise Texture (itself Perlin-based) actually produces.
  vec3 _iceHash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }
  float _iceGradientNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    // quintic fade (Perlin's improved curve) instead of the cheaper cubic smoothstep — zero 1st
    // AND 2nd derivative at the cell edges, so no visible seam between lattice cells.
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n =
      mix(mix(mix(dot(_iceHash3(i + vec3(0.0,0.0,0.0)), f - vec3(0.0,0.0,0.0)),
                  dot(_iceHash3(i + vec3(1.0,0.0,0.0)), f - vec3(1.0,0.0,0.0)), u.x),
              mix(dot(_iceHash3(i + vec3(0.0,1.0,0.0)), f - vec3(0.0,1.0,0.0)),
                  dot(_iceHash3(i + vec3(1.0,1.0,0.0)), f - vec3(1.0,1.0,0.0)), u.x), u.y),
          mix(mix(dot(_iceHash3(i + vec3(0.0,0.0,1.0)), f - vec3(0.0,0.0,1.0)),
                  dot(_iceHash3(i + vec3(1.0,0.0,1.0)), f - vec3(1.0,0.0,1.0)), u.x),
              mix(dot(_iceHash3(i + vec3(0.0,1.0,1.0)), f - vec3(0.0,1.0,1.0)),
                  dot(_iceHash3(i + vec3(1.0,1.0,1.0)), f - vec3(1.0,1.0,1.0)), u.x), u.y),
          u.z);
    return n * 0.5 + 0.5;   // remap the ~[-0.7, 0.7] gradient-noise range to ~0-1 so it still lines
                            // up with the roughness/bump Color Ramp thresholds below (calibrated
                            // against a 0-1 signal)
  }
  // scale/persistence/lacunarity match the Blender Noise Texture's Scale/Roughness/Lacunarity;
  // "Detail" (octave count) is fixed at 5 here rather than the graph's 15 — see note above.
  //
  // Each octave is also analytically anti-aliased: once an octave's period shrinks toward the
  // size of a screen pixel (measured via fwidth on the sampled position), summing it in raw just
  // aliases into speckly "TV static" — visible as a pixelated/sandy look on the surface rather
  // than a smooth crack/blotch pattern. Fading each octave's weight (and its normalization
  // weight, so the average stays consistent) to 0 as it approaches that limit fixes that at the
  // source, instead of just lowering detail everywhere — fine detail still shows up close, it
  // just doesn't alias into noise at a distance. The fade window is deliberately generous
  // (starts fading a couple of pixels out, fully gone well before 1px) since this block only
  // ever fills a few hundred screen pixels — a tight, "just barely avoid literal aliasing"
  // window still reads as sandy/pixelated at that size even though nothing is technically
  // under-sampled.
  float _iceFbm(vec3 p, float scale, float persistence, float lacunarity) {
    float freq = scale, amp = 1.0, sum = 0.0, norm = 0.0;
    for (int i = 0; i < 5; i++) {
      vec3 pf = p * freq;
      float w = fwidth(pf.x) + fwidth(pf.y) + fwidth(pf.z);
      float aa = 1.0 - smoothstep(0.35, 1.6, w);
      float a = amp * aa;
      sum += _iceGradientNoise(pf) * a;
      norm += a;
      amp *= persistence;
      freq *= lacunarity;
    }
    return norm < 1e-4 ? 0.5 : sum / norm;
  }
`;

/* pure ice/glass material, matched node-for-node to a reference Blender graph (screenshot
   supplied by the user; see ice-block-blender-pipeline.md for the full mapping): white base
   color, 0 metalness, ior 1.309, full transmission, no clearcoat/iridescence/dispersion.
   Roughness and the surface bump both come from *object-space* 3D noise (Blender's Noise
   Texture in "Object" coordinate mode -> Color Ramp), not a UV-space texture — see
   ICE_NOISE_GLSL above. Frost-hover glow/grid, the fresnel rim glow, and the refraction
   shimmer jitter are our own additions layered on top (a static material graph has no way to
   show cursor interaction) and are unchanged from before. */
function iceMaterial(frost, seedOffset) {
  const base = {
    color: 0xffffff, metalness: 0,
    roughness: 1.0,   // overwritten per-fragment by the procedural roughness below; native value unused
    envMapIntensity: 0.91,
    transparent: true,
  };
  const m = FROSTED
    ? new THREE.MeshPhysicalMaterial({ ...base, opacity: 0.86 })
    : new THREE.MeshPhysicalMaterial({
        ...base, opacity: 1.0,
        transmission: 1.0, thickness: 2.0, ior: 1.309,
        // real absorption (Beer's law), not the neutral white used by an earlier material on this
        // same mesh — the reference render's clear patches read near-black because a path-traced
        // transmissive ray through them hits Blender's empty/unlit world; our real-time
        // transmission instead refracts whatever is actually behind the block on screen (the aurora
        // background), so without genuine attenuation those patches would show that background's
        // colour instead of reading dark. Distance is short relative to `thickness` on purpose, so
        // the darkening is visible within one pass through the block rather than only at the edges.
        attenuationColor: new THREE.Color(0x0c1218), attenuationDistance: 1.1,
      });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = { value: new THREE.Color(0xbfeaff) };
    shader.uniforms.uGlowStrength = { value: GLOW_STR };
    shader.uniforms.uGlowPow = { value: 2.6 };
    shader.uniforms.uCore = { value: FROSTED ? 0.12 : 0.08 };   // faint internal luminosity → reads as ice on black
    shader.uniforms.tFrost = { value: frost.front.texture };
    shader.uniforms.uFrostColorA = { value: FROST_COLOR_A };
    shader.uniforms.uFrostColorB = { value: FROST_COLOR_B };
    shader.uniforms.uGridScale = { value: GRID_SCALE };
    shader.uniforms.uGridWidth = { value: GRID_WIDTH };
    // igloo.inc-style refraction jitter: a generic small noise texture (reusing the frost
    // advection noise generator — no semantic link, just a cheap decorrelated RG source) sampled
    // through a uniform that's re-randomized every frame (see draw()), so the transmission has a
    // faint per-frame shimmer instead of reading like perfectly still glass.
    shader.uniforms.tIceNoise = { value: advectTex() };
    shader.uniforms.uBlueOffset = { value: new THREE.Vector2(Math.random(), Math.random()) };
    // undoes normalizeScale()'s enlargement before sampling noise, so Scale=4/Scale=1 read at the
    // same frequency-to-surface-size ratio the reference Blender render used on the original mesh
    shader.uniforms.uIceNoiseScale = { value: 1 / iceNoiseScale };
    // per-block offset into the (otherwise infinite/periodic-looking) noise field — all three
    // blocks share one authored mesh, so without this they'd show the exact same blotch/crack
    // pattern; a large per-block offset samples a totally decorrelated region of the same field,
    // so each chunk reads as genuinely different ice rather than a stamped clone.
    shader.uniforms.uSeedOffset = { value: seedOffset || new THREE.Vector3() };
    frost.uniforms = shader.uniforms;   // advanceFrost() re-points tFrost here after every ping-pong swap
    // three's built-in `vUv` is transformed by a map's own repeat/offset — no UV-space texture
    // reads roughness/normal any more, but the frost buffer still needs the raw, untransformed
    // mesh UV to match exactly what the raycast hover reports. Also pass object-space position
    // through for the procedural noise (Blender's "Object" texture-coordinate equivalent).
    shader.vertexShader = shader.vertexShader
      .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nvarying vec2 vIceUv;\nvarying vec3 vIcePos;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvIceUv = uv;\nvIcePos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform vec3 emissive;',
        'uniform vec3 emissive;\nuniform vec3 uGlow;\nuniform float uGlowStrength;\nuniform float uGlowPow;\nuniform float uCore;\n'
        + 'uniform sampler2D tFrost;\nuniform vec3 uFrostColorA;\nuniform vec3 uFrostColorB;\nuniform float uGridScale;\nuniform float uGridWidth;\n'
        + 'uniform sampler2D tIceNoise;\nuniform vec2 uBlueOffset;\n'
        // normalMatrix is only auto-declared in three's *vertex* shader — the analytic bump
        // gradient below needs it here too, to carry the object-space gradient into view space.
        + 'uniform mat3 normalMatrix;\nuniform float uIceNoiseScale;\nuniform vec3 uSeedOffset;\n'
        + 'varying vec2 vIceUv;\nvarying vec3 vIcePos;\nfloat _iceFrost = 0.0;\nfloat _iceRim = 0.0;\n'
        + ICE_NOISE_GLSL)
      .replace('#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n'
        + '{ vec2 _fd = texture2D(tFrost, vIceUv).rg; _iceFrost = _fd.r; _iceRim = _fd.g; }\n'
        + 'vec3 _iceP = vIcePos * uIceNoiseScale + uSeedOffset;')
      // roughness: Noise Texture (scale 4, persistence .5, lacunarity 2) -> Color Ramp
      // (flat black to .416, linear up to white at 1.0) -> straight into the BSDF's Roughness
      // socket, i.e. a full replacement of the scalar, not a multiplier on it.
      .replace('#include <roughnessmap_fragment>',
        'float roughnessFactor = smoothstep(0.416, 1.0, _iceFbm(_iceP, 4.0, 0.5, 2.0));\n'
        + 'roughnessFactor *= 1.0 - _iceFrost;   // cursor "melts" a smoother, glossier patch (igloo: roughnessFactor *= 1.0 - mousefrost)')
      // bump: Noise Texture (scale 1, persistence .8, lacunarity 2) -> Color Ramp (black to
      // white by .745, flat white after) -> Bump (strength .2; the graph's second, chained Bump
      // node has strength 0 and is therefore a no-op, so only this one actually contributes).
      // Object-space noise means the gradient can be taken directly by finite-differencing the
      // height function along world axes and projecting onto the tangent plane — no UV/tangent
      // attribute needed at all, unlike a conventional UV-space normal map.
      .replace('#include <normal_fragment_maps>',
        '{\n'
        + '  float _eps = 0.02;\n'
        + '  float _h0 = smoothstep(0.0, 0.745, _iceFbm(_iceP, 1.0, 0.8, 2.0));\n'
        + '  float _hx = smoothstep(0.0, 0.745, _iceFbm(_iceP + vec3(_eps,0.0,0.0), 1.0, 0.8, 2.0));\n'
        + '  float _hy = smoothstep(0.0, 0.745, _iceFbm(_iceP + vec3(0.0,_eps,0.0), 1.0, 0.8, 2.0));\n'
        + '  float _hz = smoothstep(0.0, 0.745, _iceFbm(_iceP + vec3(0.0,0.0,_eps), 1.0, 0.8, 2.0));\n'
        + '  vec3 _grad = vec3(_hx - _h0, _hy - _h0, _hz - _h0) / _eps;\n'
        + '  vec3 _gradView = normalMatrix * _grad;\n'
        + '  vec3 _tangentialGrad = _gradView - dot(_gradView, normal) * normal;\n'
        + '  float _bumpStrength = 0.5 * (1.0 - _iceFrost);   // cursor flattens the bump too (igloo: mapN.xy *= 1.0 - mousefrost)\n'
        + '  normal = normalize(normal - _bumpStrength * _tangentialGrad);\n'
        + '}')
      // igloo.inc's custom transmission jitter: perturb the sampled normal with a noise texture
      // (scaled by roughness and by our own cursor-frost value, so hovered/rougher patches refract
      // more chaotically) before the volume-refraction lookup. Reuses three's own native
      // getIBLVolumeRefraction/getTransmissionSample/dispersion machinery (already declared by
      // #include <transmission_pars_fragment>, untouched) rather than redeclaring it — igloo's
      // bundle predates three.js's native `dispersion` support and hand-rolled a 5-sample RGB-IOR
      // sweep to get the same chromatic-aberration result; native dispersion (set on the material)
      // now does that part for us. Full native chunk reproduced verbatim, jitter added to `n` only.
      .replace('#include <transmission_fragment>',
        '#ifdef USE_TRANSMISSION\n'
        // USE_DISPERSION isn't defined (we don't set material.dispersion on the JS side to
        // match the reference graph, which has none) — the native chunk only assigns
        // material.dispersion inside that ifdef, so without this it's read uninitialized below.
        + '  material.dispersion = 0.0;\n'
        + '  material.transmission = transmission;\n'
        + '  material.transmissionAlpha = 1.0;\n'
        + '  material.thickness = thickness;\n'
        + '  material.attenuationDistance = attenuationDistance;\n'
        + '  material.attenuationColor = attenuationColor;\n'
        + '  #ifdef USE_TRANSMISSIONMAP\n    material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;\n  #endif\n'
        + '  #ifdef USE_THICKNESSMAP\n    material.thickness *= texture2D( thicknessMap, vThicknessMapUv ).g;\n  #endif\n'
        + '  vec3 pos = vWorldPosition;\n'
        + '  vec3 v = normalize( cameraPosition - pos );\n'
        + '  vec3 n = inverseTransformDirection( normal, viewMatrix );\n'
        + '  vec3 _iceNoise = texture2D(tIceNoise, gl_FragCoord.xy * 0.01 + uBlueOffset).xyz * 2.0 - 1.0;\n'
        + '  vec3 _distortN = normalize(n + roughnessFactor * roughnessFactor * 0.6 * _iceNoise + _iceFrost * 0.12 * _iceNoise);\n'
        + '  vec4 transmitted = getIBLVolumeRefraction(\n'
        + '    _distortN, v, material.roughness, material.diffuseColor, material.specularColor, material.specularF90,\n'
        + '    pos, modelMatrix, viewMatrix, projectionMatrix, material.dispersion, material.ior, material.thickness,\n'
        + '    material.attenuationColor, material.attenuationDistance );\n'
        + '  material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );\n'
        + '  totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );\n'
        + '#endif')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n'
        + '{ float _f = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), uGlowPow);\n'
        + '  totalEmissiveRadiance += uGlow * (_f * uGlowStrength + uCore); }\n'
        // real-time transmission can't reproduce the multi-bounce scattering that makes frosted
        // (high-roughness) ice look bright white against clear ice reading dark/see-through in a
        // path-traced render — approximate the same read directly: frosted patches glow, driven by
        // the same roughnessFactor noise that shapes them, clear patches get none.
        + 'totalEmissiveRadiance += vec3(0.9, 0.96, 1.0) * roughnessFactor * 0.7;\n'
        // only reveal the frost/grid on surfaces that actually face the camera — without this it
        // was lighting up the whole block, including sides and faces angled away from the viewer
        + '{ float _facing = smoothstep(-0.1, 0.5, dot(normalize(normal), normalize(vViewPosition)));\n'
        // vIceUv.x is packed into one of 3 thirds (see computeBoxUV) — unpack back to a local 0-1
        // range so the grid cells read square instead of squeezed 3x tighter than the V direction
        + '  vec2 _guv = vec2(fract(vIceUv.x * 3.0), vIceUv.y);\n'
        + '  vec2 _gv = fract(_guv * uGridScale); vec2 _gd = min(_gv, 1.0 - _gv);\n'
        + '  float _grid = 1.0 - smoothstep(0.0, uGridWidth, min(_gd.x, _gd.y));\n'
        // mostly teal, with purple only as a sparse per-cell hint (not a smooth gradient) — "here and there"
        + '  vec2 _cell = floor(_guv * uGridScale);\n'
        + '  float _hash = fract(sin(dot(_cell, vec2(127.1, 311.7))) * 43758.5453);\n'
        + '  float _purpleHint = smoothstep(0.72, 1.0, _hash) * 0.55;\n'
        + '  vec3 _frostColor = mix(uFrostColorA, uFrostColorB, _purpleHint);\n'
        // igloo's exact structure: a flat colored glow only at the growing rim (no colored wash
        // across the whole settled area), plus an *uncolored* white grid/facet sparkle — bright at
        // the rim, steadier (frost^2) across the rest of the revealed patch.
        + '  totalEmissiveRadiance += _frostColor * _iceRim * _facing;\n'
        + '  totalEmissiveRadiance += _grid * _iceRim * 10.0 * _facing;\n'
        + '  totalEmissiveRadiance += _grid * pow(_iceFrost, 2.0) * _facing; }');
  };
  return m;
}

/* ---------- per-block variation ----------
   All three projects currently share one authored mesh (assets/models/ice-cube-2.glb), so
   without this every block would be an identical clone: same silhouette, same blotch/crack
   pattern. A large per-block offset into the noise field (see uSeedOffset above) gives each
   a distinct surface pattern, and a small per-axis scale gives each a slightly different
   proportion (squatter/taller/narrower) — enough that they read as three different chunks
   of ice rather than one chunk copy-pasted three times, without needing three separate GLBs. */
const ICE_VARIANTS = [
  { seed: new THREE.Vector3(0, 0, 0), scale: new THREE.Vector3(1.0, 1.0, 1.0) },
  { seed: new THREE.Vector3(41.7, -23.4, 58.2), scale: new THREE.Vector3(1.07, 0.92, 1.04) },
  { seed: new THREE.Vector3(-67.9, 31.6, -14.8), scale: new THREE.Vector3(0.93, 1.06, 0.97) },
];

/* ---------- build the blocks once geometry is ready ---------- */
const blocks = [];
function buildBlocks(geos) {
  for (let i = 0; i < N; i++) {
    const grp = new THREE.Group();
    const frost = createFrost();
    const variant = ICE_VARIANTS[i % ICE_VARIANTS.length];
    const ice = new THREE.Mesh(geos[i % geos.length], iceMaterial(frost, variant.seed));
    ice.scale.copy(variant.scale);
    ice.renderOrder = 2;
    grp.add(ice);
    grp.userData = {
      index: i, ice, frost, baseOp: FROSTED ? 0.86 : 1.0, phase: i * 0.8, phase2: i * 1.7 + 0.4,
      rand: Math.random(), swayFade: 0,   // idle sway: per-block seed + eased on/off amount (see layout())
    };
    scene.add(grp);
    blocks.push(grp);
  }
  resize();
  schedule();
}

// the base material no longer samples any UV-space texture (roughness/bump are both analytic 3D
// noise now — see iceMaterial), but the frost-hover buffer and its grid pattern still need a real
// UV set to sample/raycast against. Box-project one from the vertex normal's dominant axis — always
// overwrites whatever UV the source file shipped with (see prepGeo below), so every model behaves
// identically here regardless of how it happened to be unwrapped in Blender.
function computeBoxUV(geo) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const s = 1 / Math.max(BW, BH, BD);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v, group;
    if (nx >= ny && nx >= nz) { u = z; v = y; group = 0; } else if (ny >= nx && ny >= nz) { u = x; v = z; group = 1; } else { u = x; v = y; group = 2; }
    // Pack each axis group into its own third of U instead of letting all three share the full
    // 0-1 range — a shared range meant a cursor splat at a given UV painted identically on every
    // face group at once (reprojected at a different scale/orientation per group), which read as
    // the frost effect appearing 3x simultaneously. GRID_SCALE unpacks this back out (×3, fract)
    // for its own sampling so grid cells still look square, but the frost buffer itself stays on
    // whichever third the raycast actually hit.
    uv[i * 2] = ((u * s + 0.5) + group) / 3; uv[i * 2 + 1] = v * s + 0.5;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

const loader = new GLTFLoader();
function firstGeo(gltf) { let g = null; gltf.scene.traverse((o) => { if (o.isMesh && !g) g = o.geometry; }); return g; }
// how much normalizeScale() enlarged the mesh from its authored size — the procedural noise
// needs to divide this back out (see iceMaterial) so its frequency matches what Scale=4/Scale=1
// meant on the *original* mesh in Blender, not on our artificially-enlarged copy of it.
let iceNoiseScale = 1;
// scale the raw mesh (authored ~±1 unit, unrelated to our BW/BH/BD convention) so its largest
// dimension matches the target footprint — keeps camera framing/spacing/UV-projection scale
// consistent with the previous Blender-normalized geometry, regardless of the source file's own units.
// block radius, post-normalization — lets the click-zoom (below) know how close it can
// actually get before the camera would pass through the mesh's own surface. Defaults to a
// sane guess (roughly BW/BH/BD's own radius) so a click during the brief window before the
// GLB has loaded still has a sensible fallback rather than an undefined swoop distance.
let iceBoundingRadius = Math.max(BW, BH, BD) * 0.55;
function normalizeScale(geo) {
  geo.computeBoundingBox();
  const size = new THREE.Vector3(); geo.boundingBox.getSize(size);
  const s = Math.max(BW, BH, BD) / Math.max(size.x, size.y, size.z);
  iceNoiseScale = s;
  geo.scale(s, s, s);
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  iceBoundingRadius = geo.boundingSphere.radius;
  return geo;
}
function prepGeo(geo) {
  geo.deleteAttribute('uv');
  if (geo.attributes.tangent) geo.deleteAttribute('tangent');
  return computeBoxUV(normalizeScale(geo));
}
loader.loadAsync(new URL('assets/models/ice-cube-2.glb', document.baseURI).href)
  .then((gltf) => buildBlocks([prepGeo(firstGeo(gltf))]))
  .catch((err) => { console.error('ice GLB load failed, using fallback', err); buildBlocks([new RoundedBoxGeometry(BW, BH, BD, 5, 0.25)]); });

/* ---------- scroll-driven layout ---------- */
let progress = 0, intro = 0;   // intro: 1 = fully spun, 0 = settled (first block's entrance spin)
// "moving" tracks raw scroll input (wheel/touch), not lenis's smoothed scroll output — lenis keeps
// gliding for a while after your hand leaves the wheel, so gating on that (or on setProgress deltas,
// which follow the smoothed value) would delay the cursor-follow well past when you actually stopped.
let moving = false, movingTimer = 0;
function markMoving() {
  moving = true;
  clearTimeout(movingTimer);
  movingTimer = setTimeout(() => { moving = false; schedule(); }, 60);
}
addEventListener('wheel', markMoving, { passive: true });
addEventListener('touchmove', markMoving, { passive: true });
let SPACING = 16, CULLX = 11;             // horizontal extents (edge-to-edge traverse) — set in resize()
let mtx = 0, mty = 0, cx = 0, cy = 0;     // lazy cursor follow: target (mtx/mty) → eased (cx/cy)
const TILT = 0.17;                        // max radians the chunk leans toward the cursor
const CURSOR_EASE = 0.055;                // lower = lazier follow
// Detail-hero slab's own tilt range (see setupSlabCanvas/applySlabOrbit below), module-scoped (not
// local to setupSlabCanvas) so computeSlabFov's tilt-combo list can be built once and reused by
// every slab instance instead of each one rebuilding it.
// Was 3x the portfolio cubes' own TILT (~29°) — dialed back to 1.5x (~14.6°) per explicit feedback
// ("moving wayyy too much... a much lazier approach"). This isn't just a motion-feel change: the
// margin computeSlabFov has to reserve is driven directly by how far the box can tilt (a bigger tilt
// exposes proportionally more of its depth, i.e. a bigger worst-case silhouette to leave room for),
// so cutting the tilt range also directly raises how much of its own canvas the pane can fill at
// rest — measured via the exact fit-check: 62.4% fill at the old 3x range, 77.2% at 1.5x, a real
// ~24% relative size increase from this one change, on top of the CSS max-height bump below. 1.5x
// (not all the way back to the cubes' own 1x) keeps *some* extra tilt beyond the cubes' baseline —
// enough that the side face this was originally bumped up for ("Not seeing any of the sides when the
// cursor moves" — see [[portfolio-detail-hero-videos]]) still reads clearly, just far less dramatic.
const SLAB_TILT = TILT * 1.5;
// A separate, much slower ease than the shared CURSOR_EASE (0.055, also used by the portfolio
// cubes) — deliberately not reusing that constant, since slowing it down here shouldn't touch the
// cubes' own, already-tuned feel. Lower = lazier: takes noticeably longer to catch up to the cursor,
// per "it should be a much lazier approach."
const SLAB_CURSOR_EASE = 0.02;
const SLAB_TILT_COMBOS = [
  [0, 0],
  [SLAB_TILT * 0.7, SLAB_TILT], [SLAB_TILT * 0.7, -SLAB_TILT],
  [-SLAB_TILT * 0.7, SLAB_TILT], [-SLAB_TILT * 0.7, -SLAB_TILT],
];
// idle sway (igloo.inc-style): while the centred block is sitting still (not scroll-driven, not
// mid-transition) it should still read as alive, not frozen. Three independent slow sine waves,
// one per axis, each block's own random seed multiplied by a different constant so every block
// drifts out of phase with the others and with itself axis-to-axis — confirmed via igloo.inc's own
// bundle: same frequency/amplitude/decorrelation-constant pattern (0.3 rad/s, ~0.1 rad, phase =
// rand*12.423 / rand*42.987 / rand*2.53), ported here composed via quaternion instead of raw Euler
// since our tumble already is. Fades in/out smoothly (IDLE_FADE_EASE) rather than snapping.
const IDLE_SWAY_AMP = 0.09;
const IDLE_SWAY_FREQ = 0.3;
const IDLE_FADE_EASE = 0.025;
const IDLE_CENTER_ZONE = 0.15;            // only the block sitting within this much of dead-centre sways
const _qTumble = new THREE.Quaternion(), _qTumble2 = new THREE.Quaternion();
const _qIntro = new THREE.Quaternion(), _qCursor = new THREE.Quaternion(), _qIdle = new THREE.Quaternion();
const _eCursor = new THREE.Euler(), _eIdle = new THREE.Euler();
const _yAxis = new THREE.Vector3(0, 1, 0);
let swayActive = false;   // true while any block is swaying or still fading in/out — keeps draw()'s loop alive
function layout() {
  const t = performance.now() * 0.001;
  swayActive = false;
  for (let i = 0; i < blocks.length; i++) {
    const o = i - progress;                       // project offset from centre
    const g = blocks[i];
    const x = o * SPACING;                         // travels the whole screen width, right → left
    g.visible = Math.abs(x) < CULLX;
    if (!g.visible) continue;
    g.position.set(x, 0, 0);                       // pure horizontal travel, no vertical
    // tumble about two independent tilted axes as it crosses — a pure function of scroll position (o),
    // so it looks exactly the same scrolling up or down through a given point (no velocity-driven flourish)
    const ang1 = -o * TUMBLE + g.userData.phase;
    const ang2 = o * TUMBLE2 + g.userData.phase2;
    _qTumble.setFromAxisAngle(tumbleAxis, ang1);
    _qTumble2.setFromAxisAngle(tumbleAxis2, ang2);
    _qTumble.multiply(_qTumble2);
    if (i === 0 && intro !== 0) {
      _qIntro.setFromAxisAngle(_yAxis, intro * SPIN);
      g.quaternion.multiplyQuaternions(_qTumble, _qIntro);
    } else {
      g.quaternion.copy(_qTumble);
    }
    const swayTarget = !moving && Math.abs(o) < IDLE_CENTER_ZONE ? 1 : 0;
    g.userData.swayFade += (swayTarget - g.userData.swayFade) * IDLE_FADE_EASE;
    if (g.userData.swayFade > 0.001 || swayTarget) swayActive = true;
    const swayAmp = IDLE_SWAY_AMP * g.userData.swayFade;
    const rnd = g.userData.rand;
    _eIdle.set(
      Math.sin(t * IDLE_SWAY_FREQ + rnd * 12.423) * swayAmp,
      Math.sin(t * IDLE_SWAY_FREQ + rnd * 42.987) * swayAmp,
      Math.sin(t * IDLE_SWAY_FREQ + rnd * 2.53) * swayAmp,
    );
    _qIdle.setFromEuler(_eIdle);
    g.quaternion.multiply(_qIdle);                  // gentle ambient wobble, only once settled at centre
    _qCursor.setFromEuler(_eCursor.set(cy * TILT * 0.7, cx * TILT, 0));
    g.quaternion.premultiply(_qCursor);            // lean toward the cursor — only nonzero once at rest (see draw())
    const edge = Math.max(0, Math.min(1, (CULLX - Math.abs(x)) / 2.6));  // soft fade only at the screen edges
    g.userData.ice.material.opacity = g.userData.baseOp * edge;
  }
}

/* ---------- click → "swoop into the ice" transition ----------
   The lead-in to opening a project: on click main.js (window.__sp.beginZoomOpen) freezes
   scroll and fades the caption/HUD text out immediately; once that's had time to actually
   finish (CLICK_TEXT_HIDE_MS) plus a beat of stillness (CLICK_PAUSE_MS), the camera dollies
   toward the clicked block's centre and widens its FOV alongside — eased in on a quintic
   curve (barely moves at first, rushes hard at the very end) rather than a constant speed, so
   it reads as a deliberate "swoop" rather than a mechanical zoom. openDetail() and its own
   panel fade run after, unchanged.

   The dolly target is deliberately clamped to just *outside* the clicked block's own bounding
   sphere (iceBoundingRadius, from normalizeScale) rather than flying to/through its centre —
   going further used to plough the camera straight through the mesh's surface in the last few
   frames (near-plane clipping into the geometry, polygons slicing through view). Instead, once
   the dolly reaches that safe distance a screen-space white "flash" overlay (a plain DOM div,
   .pf-zoom-flash, layered over the canvas) ramps in over the final stretch of the swoop — so
   arriving at the surface reads as "swallowed by the ice's own light" rather than an abrupt
   stop, and the moment the camera *would* have clipped is already hidden under solid white by
   the time it happens. openDetail()'s own panel then fades in over that white, in-continuity
   with the rest of the beat. */
const CLICK_TEXT_HIDE_MS = 300;    // matches .pf-caption's own CSS opacity transition (main.css) — don't start the swoop before the text has actually finished disappearing
const CLICK_PAUSE_MS = 130;        // the requested beat of stillness once the text is gone
const CLICK_ZOOM_MS = 920;         // the swoop itself — lengthened ~500ms past the original 420 per feedback, still quintic ease-in so the extra time reads as a longer glide-then-rush, not just a slower flat zoom
const CLICK_ZOOM_SAFE_MARGIN = 1.25;  // dolly stops this many times the block's own bounding radius away from its centre — always outside the surface, whatever the per-block scale variant (see ICE_VARIANTS)
const CLICK_FLASH_START = 0.72;    // flash begins ramping in once the eased dolly progress passes this fraction — i.e. only over the final approach, not the whole swoop
let zoomActive = false;
const _zoomCamStart = new THREE.Vector3();
const _zoomPosTarget = new THREE.Vector3();
const _zoomDir = new THREE.Vector3();
const _zoomLookStart = new THREE.Vector3(0, 0, 0);   // the camera's resting look-at point (see camera.lookAt(0,0,0) above/resetZoom)
const _zoomLookNow = new THREE.Vector3();
const flashEl = document.createElement('div');
flashEl.className = 'pf-zoom-flash';
flashEl.setAttribute('aria-hidden', 'true');
// Appended to <body>, NOT canvas.parentElement (.pf-stage) — .pf-stage sits inside
// .portfolio-box, which has `will-change: transform`, and that creates a containing block for
// any `position:fixed` descendant (per spec: transform/will-change:transform ancestors capture
// fixed descendants same as they would absolute ones). A flash nested in there could never
// actually cover the true viewport no matter what its own CSS said — it'd always be bounded by
// .pf-stage's own partial-height box, reading as a hard-edged white band/rectangle instead of a
// full-screen whiteout. Appending straight to <body> sidesteps every transformed ancestor.
document.body.appendChild(flashEl);
function zoomIntoBlock(grp, onDone) {
  zoomActive = true;
  _zoomCamStart.copy(camera.position);
  const startFov = camera.fov;
  const lookTarget = grp.position;                                       // always look at the block's true centre
  _zoomDir.subVectors(_zoomCamStart, lookTarget).normalize();
  const safeDist = iceBoundingRadius * CLICK_ZOOM_SAFE_MARGIN + camera.near * 4;
  _zoomPosTarget.copy(lookTarget).addScaledVector(_zoomDir, safeDist);    // stop just outside the block's surface, never inside it
  const targetFov = startFov * 1.8;                                      // widening alongside the dolly sells the "rushing forward" swoop
  const t0 = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - t0) / CLICK_ZOOM_MS);
    const e = t * t * t * t * t;                                         // quintic ease-in: slow start, fast finish
    camera.position.lerpVectors(_zoomCamStart, _zoomPosTarget, e);
    camera.fov = startFov + (targetFov - startFov) * e;
    camera.updateProjectionMatrix();
    // Eased along with everything else, not snapped straight to the block's centre on frame one.
    // The camera's resting orientation always looks at the scene origin (0,0,0); if the clicked
    // block isn't sitting there yet (still mid roll/settle when clicked), jumping camera.lookAt
    // straight to the block's true position instantly re-aimed the view before the camera had
    // moved at all — the block would appear to teleport to frame-centre on the very first frame,
    // then the dolly/zoom played out after. Interpolating the look-at point itself from the
    // origin to the block's centre over the same eased progress makes it visibly slide toward
    // centre as part of the same swoop instead.
    _zoomLookNow.lerpVectors(_zoomLookStart, lookTarget, e);
    camera.lookAt(_zoomLookNow);
    flashEl.style.opacity = Math.max(0, (e - CLICK_FLASH_START) / (1 - CLICK_FLASH_START)).toFixed(3);
    renderer.render(scene, camera);
    if (t < 1) { requestAnimationFrame(tick); return; }
    zoomActive = false;
    onDone();
  }
  requestAnimationFrame(tick);
}

/* ---------- render loop ---------- */
let active = false, raf = 0;
function draw() {
  raf = 0;
  if (!active || !blocks.length || zoomActive) return;   // the click-zoom above owns the camera/render calls while it runs
  // cursor lean only applies once scrolling has stopped — a scroll-driven tumble should look
  // identical whether you're scrolling up or down, and the cursor position (unrelated to
  // scroll) would otherwise break that symmetry. Ease toward 0 while moving, toward the
  // cursor once settled — both directions use the same lazy ease, so it never pops.
  const towardX = moving ? 0 : mtx;
  const towardY = moving ? 0 : mty;
  cx += (towardX - cx) * CURSOR_EASE;
  cy += (towardY - cy) * CURSOR_EASE;
  layout();
  let frostActive = false;
  const now = performance.now();
  for (const g of blocks) {
    if (!g.visible) continue;
    const fr = g.userData.frost;
    if (now - fr.lastHitTime > FROST_IDLE_MS) continue;   // long enough for the buffer to have fully decayed — skip the pass
    advanceFrost(fr);
    frostActive = true;
  }
  // re-randomize the transmission noise offset every frame (igloo.inc-style) — a static offset
  // would sample the same distortion texel every frame, reading as a fixed warp instead of shimmer
  for (const g of blocks) {
    if (!g.visible) continue;
    const u = g.userData.frost.uniforms;
    if (u && u.uBlueOffset) u.uBlueOffset.value.set(Math.random(), Math.random());
  }
  renderer.render(scene, camera);
  const cursorEasing = Math.abs(towardX - cx) > 0.0008 || Math.abs(towardY - cy) > 0.0008;
  if (moving || cursorEasing || frostActive || swayActive) { raf = requestAnimationFrame(draw); }   // keep going until settled
}
function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

/* lazy cursor follow — the chunk leans toward the pointer */
addEventListener('pointermove', (e) => {
  if (!active) return;
  mtx = (e.clientX / innerWidth) * 2 - 1;
  mty = (e.clientY / innerHeight) * 2 - 1;
  updateFrostHover(e);
  schedule();
});

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const halfW = Math.tan(camera.fov * Math.PI / 360) * camera.position.z * camera.aspect;
  SPACING = 2 * halfW;         // one project-step spans the full screen width (edge to edge)
  CULLX = halfW + 2.8;         // keep the chunk until it's fully off-screen
  schedule();
}
addEventListener('resize', resize);

/* ---------- click → open project detail (raycast) ---------- */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downX = 0, downY = 0;
canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
canvas.addEventListener('pointerup', (e) => {
  if (!active || zoomActive) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;   // ignore drags
  const r = canvas.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  // filter to only the currently-visible (non-culled) blocks before raycasting — three.js's
  // Raycaster does NOT skip object.visible=false by default, so an off-screen block that's
  // fully tumbled away (culled via layout()'s `g.visible = false`, still sitting in `blocks`)
  // could still register a hit if its geometry happens to cross the click ray, opening a
  // completely different project than the one actually visible under the cursor. Same fix
  // updateFrostHover() already applies below — this path was missing it.
  const hit = ray.intersectObjects(blocks.filter((g) => g.visible), true)[0];
  if (!hit) return;
  let g = hit.object; while (g && g.userData.index === undefined) g = g.parent;
  const p = g && projects[g.userData.index];
  const sp = window.__sp;
  if (!p || !p.detailId || !sp || !sp.openDetail) return;
  if (sp.beginZoomOpen && !sp.beginZoomOpen()) return;   // already mid-transition (e.g. a double click) — ignore
  setTimeout(() => zoomIntoBlock(g, () => sp.openDetail(p.detailId)), CLICK_TEXT_HIDE_MS + CLICK_PAUSE_MS);
});

/* ---------- cursor "frost" hover tracking (raycast → per-block splat) ---------- */
function updateFrostHover(e) {
  const r = canvas.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(blocks.filter((g) => g.visible), true)[0];
  if (!hit || !hit.uv) return;
  let g = hit.object; while (g && g.userData.index === undefined) g = g.parent;
  if (!g) return;
  const fr = g.userData.frost;
  const now = performance.now();
  const freshEntry = now - fr.lastHitTime > 200;   // just arrived (or first ever hover) — don't draw a stroke in from a stale/off-mesh position
  if (freshEntry) fr.splatPrevPos.set(hit.uv.x, hit.uv.y); else fr.splatPrevPos.copy(fr.splatPos);
  fr.splatPos.set(hit.uv.x, hit.uv.y);
  const d = fr.splatPrevPos.distanceTo(fr.splatPos);
  fr.targetVelocity = Math.min(1, fr.targetVelocity + d * 6);
  fr.lastHitTime = now;
}

/* ---------- public hook for main.js ---------- */
window.__ice = {
  setProgress(p) {
    progress = p;
    schedule();
  },
  setIntro(v) { intro = v; schedule(); },
  setActive(b) { active = b; if (b) { resize(); schedule(); } else { moving = false; clearTimeout(movingTimer); } },
  resize,
  // undoes zoomIntoBlock()'s camera dolly/FOV/flash — called once the opened detail panel
  // closes, so the portfolio section looks normal again if/when it's scrolled back into view
  resetZoom() {
    zoomActive = false;
    camera.position.copy(CAM_DEFAULT_POS);
    camera.fov = CAM_DEFAULT_FOV;
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);
    flashEl.style.opacity = '0';
    schedule();
  },
  _debug: () => ({
    moving, cx, cy, active, progress, quats: blocks.map((b) => b.quaternion.toArray()),
    frost: blocks.map((b) => ({ visible: b.visible, lastHitTime: b.userData.frost.lastHitTime, velocity: b.userData.frost.velocity })),
  }),
};

// Re-enabled specifically to evaluate opacity/clarity — hard to judge a transmissive material
// with nothing behind it to actually transmit. Caption text (.pf-dhero-text, main.css) stays
// hidden; this is video-only, on purpose.
const SLAB_SHOW_CONTENT = true;

// Temporary A/B toggle: hides the ice slab mesh itself so the panels can be evaluated with just
// video/text/cursor-tilt and no ice, without touching any of that other machinery. Content plane,
// brighten overlay, caption text, and the camera-orbit cursor lean are all untouched by this flag
// — only `slabMesh.visible` below reads it. Flip back to `true` to bring the ice back.
const SLAB_SHOW_ICE = false;

/* ============ detail-panel "ice slabs" ============
   A real 3D pane of ice per header video / gallery photo — thin, clean, and clear (close to
   glass), NOT the chunky frosted blocks used for the portfolio cards. The video/photo sits on
   a plane embedded in the middle of the pane's thin depth and is seen *through* the ice's own
   front-face transmission, rather than composited in front of it. One small scene + renderer
   per <canvas class="pf-dhero-canvas"|"pf-shot-canvas">, all found in the DOM up front but only
   ever *rendering* while their panel is open (main.js calls
   window.__iceFrame.activatePanel(id)/deactivatePanel(id) from openDetail()/closeDetail()).
   Reuses this file's ice noise (ICE_NOISE_GLSL) at a much lower intensity than the portfolio
   blocks' frosted material, and drops the cursor-hover frost/grid system entirely — there's no
   cursor interaction on a static pane. */

// Plain rectangular slab — no bevel, no facets, just a solid box. Replaces an earlier, much more
// involved system (a hand-authored faceted "cut gem" GLB, 9-slice-remapped per instance to keep
// its bevel width even) per explicit request to drop the bevel entirely. Sized so its own aspect
// ratio always matches whatever real content (video/photo) it's holding — passed in, not derived
// from the canvas element's own arbitrary CSS box shape — so the content is never stretched to
// fit a mismatched rectangle. `BoxGeometry`'s default per-face UVs and flat (unsmoothed) normals
// are already exactly right for this — no reprojection or facet-normal handling needed the way
// the old GLB-based version required.
const SLAB_TARGET_SIZE = 2.05;
const SLAB_DEPTH_RATIO = 0.4;   // depth as a fraction of height — real slab thickness, not a flat card
function buildSlabGeometry(aspect, sizeMult = 1) {
  const height = SLAB_TARGET_SIZE * sizeMult;
  const width = height * aspect;
  const depth = height * SLAB_DEPTH_RATIO;
  const geo = new THREE.BoxGeometry(width, height, depth);
  geo.computeBoundingBox();
  return { geometry: geo, flatHalfX: width / 2, flatHalfY: height / 2 };
}

// Exact per-aspect minimum vertical FOV, recomputed on every resize rather than shipped as one
// blanket constant. The previous fixed 50deg (sized for a generously-padded worst case) turned out
// to be the actual "you made it tiny" bug: this canvas's *real on-page aspect ratio measurably
// varies a lot by viewport* (measured 1.2-2.55 across real widths, since .pf-detail-hero/-shot's
// CSS height is vh-clamped independently of its column-driven width — nothing like a fixed 16:9),
// and one FOV wide enough for the narrowest measured case left enormous unused margin at every
// wider one — the exact minimum ranged 24.5-44.75deg across real measured viewports, nowhere near
// the shipped 50. A single blanket constant can only ever be tuned for the single worst case; an
// object's fraction-of-frame fill (i.e. how "big" it visually reads inside its own canvas) is
// capped by the *tightest* FOV that still avoids clipping — so computing that exactly, per instance,
// per resize, is what actually maximizes apparent size while still guaranteeing zero clipping at
// whatever aspect the browser happens to be, not just eyeballed on one dev viewport. Same corner-
// projection + binary-search technique already established for the portfolio ice cubes' own margin
// fix (see [[portfolio-detail-hero-videos]] memory) — reused here as a live per-resize computation
// instead of a one-off script, since aspect isn't knowable until the canvas is actually laid out.
const _slabFovCorners = [];
for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) _slabFovCorners.push(new THREE.Vector3(sx, sy, sz));
const _slabFovCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 20);
const _slabFovEuler = new THREE.Euler();
const _slabFovQuat = new THREE.Quaternion();
const _slabFovVpMatrix = new THREE.Matrix4();
const _slabFovPt = new THREE.Vector3();
const SLAB_FOV_SAFETY = 1.1;   // 10% pad on top of the exact computed minimum — real headroom, not a guess
function _slabFovFits(hw, hh, hd, distance, fovDeg, aspect, tiltX, tiltY) {
  _slabFovCamera.fov = fovDeg;
  _slabFovCamera.aspect = aspect;
  _slabFovEuler.set(-tiltX, -tiltY, 0);
  _slabFovQuat.setFromEuler(_slabFovEuler);
  _slabFovCamera.position.set(0, 0, distance).applyQuaternion(_slabFovQuat);
  _slabFovCamera.lookAt(0, 0, 0);
  _slabFovCamera.updateMatrixWorld(true);
  _slabFovCamera.updateProjectionMatrix();
  _slabFovVpMatrix.multiplyMatrices(_slabFovCamera.projectionMatrix, _slabFovCamera.matrixWorldInverse);
  for (const c of _slabFovCorners) {
    _slabFovPt.set(c.x * hw, c.y * hh, c.z * hd).applyMatrix4(_slabFovVpMatrix);
    if (Math.abs(_slabFovPt.x) > 1 || Math.abs(_slabFovPt.y) > 1) return false;
  }
  return true;
}
function computeSlabFov(width, height, depth, distance, aspect, tiltCombos) {
  const hw = width / 2, hh = height / 2, hd = depth / 2;
  let lo = 5, hi = 140;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    let allFit = true;
    for (const [tx, ty] of tiltCombos) {
      if (!_slabFovFits(hw, hh, hd, distance, mid, aspect, tx, ty)) { allFit = false; break; }
    }
    if (allFit) hi = mid; else lo = mid;
  }
  return Math.min(120, hi * SLAB_FOV_SAFETY);
}

// Real ice/glass shading, now that the geometry itself is confirmed correct (verified via the
// MeshNormalMaterial check above — distinct colours per facet, proving the facets are real).
// Physically-based transmission (the same technique as the portfolio blocks, just without their
// procedural frosted noise — this model's own facets provide the visual structure instead).
// attenuationColor sampled directly from the site's own hero clip 1 crystal
// (site/assets/frames/clip1/f_0079.webp) rather than eyeballed — pulled real RGB values from a
// grid of points across the crystal (via a canvas getImageData pass) and picked from the
// medium-deep cluster (~40-90, 90-140, 130-170), skipping both the darkest shadow-facet extremes
// (near-navy, ~20,50,85) and the palest highlight facets (near-white, ~190,210,230) as
// unrepresentative of the material's own core colour. attenuationDistance kept short so that
// tint actually reads instead of washing out — a longer distance was the earlier "flat white
// card" problem, since with nothing behind the ice to refract (content plane still deliberately
// hidden) the material has to carry its own visible colour through attenuation alone.
// Deterministic seeded PRNG (mulberry32) + wrap-around box blur — plain typed-array/canvas work,
// no GLSL. Used to build the grain textures below.
function _mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function _boxBlurWrap(src, size, radius) {
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  const norm = 1 / (radius * 2 + 1);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[y * size + ((x + k + size) % size)];
    tmp[y * size + x] = sum * norm;
  }
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[((y + k + size) % size) * size + x];
    out[y * size + x] = sum * norm;
  }
  return out;
}
// Real ice is never a perfectly flat, mirror-smooth sheet — it's the *lack* of any surface grain
// that made the pane read as "a clear layer floating in front of the video" instead of "a solid
// block you're looking through." This builds one shared height field (a soft, large-scale
// undulation layered with a near-per-pixel fine speckle — the "grainy raw" feel) once, then
// derives a roughnessMap (clarity varies slightly across the surface, patch to patch) and a
// normalMap (so the transmitted image itself refracts/wobbles a little passing through, the way
// a real chunk of ice bends light) from that *same* field, so the two stay visually coherent.
// Tileable (RepeatWrapping) and independent of the slab's own UVs — it's surface detail, not a
// decal — and shared by reference across all 9 slab materials, built lazily on first use.
let _slabGrain = null;
function slabGrainTextures() {
  if (_slabGrain) return _slabGrain;
  const size = 192;
  const rand = _mulberry32(0xC5EA11);
  const raw = new Float32Array(size * size);
  for (let i = 0; i < raw.length; i++) raw[i] = rand();
  const mottle = _boxBlurWrap(raw, size, 10);   // large soft undulation — uneven internal clarity
  const fine = _boxBlurWrap(raw, size, 1);      // near-per-pixel — the grainy speckle itself
  const height = new Float32Array(size * size);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < height.length; i++) {
    const h = mottle[i] * 0.6 + fine[i] * 0.4;
    height[i] = h; if (h < min) min = h; if (h > max) max = h;
  }
  const range = max - min || 1;
  for (let i = 0; i < height.length; i++) height[i] = (height[i] - min) / range;

  const roughCanvas = document.createElement('canvas'); roughCanvas.width = roughCanvas.height = size;
  const roughCtx = roughCanvas.getContext('2d');
  const roughImg = roughCtx.createImageData(size, size);
  const normCanvas = document.createElement('canvas'); normCanvas.width = normCanvas.height = size;
  const normCtx = normCanvas.getContext('2d');
  const normImg = normCtx.createImageData(size, size);
  const normalStrength = 1.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const h = height[idx];
      const p = idx * 4;
      roughImg.data[p] = roughImg.data[p + 1] = roughImg.data[p + 2] = h * 255;
      roughImg.data[p + 3] = 255;

      const hl = height[y * size + ((x - 1 + size) % size)];
      const hr = height[y * size + ((x + 1) % size)];
      const hu = height[((y - 1 + size) % size) * size + x];
      const hd = height[((y + 1) % size) * size + x];
      let nx = (hl - hr) * normalStrength;
      let ny = (hu - hd) * normalStrength;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      nx /= len; ny /= len; const nz = 1 / len;
      normImg.data[p] = (nx * 0.5 + 0.5) * 255;
      normImg.data[p + 1] = (ny * 0.5 + 0.5) * 255;
      normImg.data[p + 2] = (nz * 0.5 + 0.5) * 255;
      normImg.data[p + 3] = 255;
    }
  }
  roughCtx.putImageData(roughImg, 0, 0);
  normCtx.putImageData(normImg, 0, 0);

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  const normalMap = new THREE.CanvasTexture(normCanvas);
  [roughnessMap, normalMap].forEach((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(6, 6);
    t.needsUpdate = true;
  });
  _slabGrain = { roughnessMap, normalMap };
  return _slabGrain;
}

// The box's side faces (±X/±Y — the ones cursor-tilt is supposed to reveal) have been through
// several attempts: the exact same glossy, high-transmission material as the front (nearly
// invisible at real tilt angles — just a grazing Fresnel reflection of the same cool-toned
// environment as the page background); a flat hand-picked dark navy (read as an unnaturally dark,
// different material glued onto the same box); a fresnel-driven emissive rim on the literal same
// material as the front (still read as "clear"/transmissive at most angles, since away from the
// rim it was still the same transmission:1 material underneath). Settled on the simplest version,
// per explicit instruction: sides are a *separate* material, but its `color` is copied verbatim
// from the front material's own `color` (not re-picked/re-tuned), and it's fully opaque
// (`transmission: 0`, no clearcoat) — same hue as the visible front, just solid instead of
// see-through, so it never blends into the background regardless of viewing angle and never reads
// as "a different, clear/glass material." See `slabEdgeMaterial()` below and its use in the
// per-face materials array where the mesh is built.
const SLAB_ICE_COLOR = 0xb9c9d2;

function slabIceMaterial() {
  const grain = slabGrainTextures();
  // Lightened back up from the previous dark-gray pass (0x94a7b1) toward a light icy blue-gray —
  // still cool/grayed rather than the original near-white 0xdcefff, but with more of a sheen to
  // it: envMapIntensity raised to match so the reflective highlight actually reads as a "sheen"
  // rather than a flat matte gray.
  const base = { color: SLAB_ICE_COLOR, metalness: 0, envMapIntensity: 0.92 };
  // clearcoat roughness tightened slightly (0.35 -> 0.28) alongside the lighter base — a bit more
  // of a defined sheen highlight without going back to the earlier sharp/mirror-like 0.1.
  const glossy = { clearcoat: 0.42, clearcoatRoughness: 0.28 };
  // roughnessMap/normalMap (see slabGrainTextures above) carry the actual grainy-raw surface read;
  // normalScale kept modest so the video stays legible through it rather than turning to frost.
  const grainMaps = {
    roughnessMap: grain.roughnessMap,
    normalMap: grain.normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
  };
  const m = FROSTED
    ? new THREE.MeshPhysicalMaterial({ ...base, ...glossy, ...grainMaps, roughness: 0.26, transparent: true, opacity: 0.62 })
    : new THREE.MeshPhysicalMaterial({
        ...base, ...glossy, ...grainMaps, roughness: 0.28,
        transmission: 1.0, thickness: 0.6, ior: 1.31,
        // Attenuation lightened to match (0x3b4a54 -> 0x6a8b9c, a clearer icy blue) and eased
        // back (0.78 -> 1.15) so less of the pane's own depth gets absorbed into shadow — reads
        // lighter overall while staying a visibly blue-tinted ice, not clear glass.
        attenuationColor: new THREE.Color(0x6a8b9c), attenuationDistance: 1.15,
      });
  m.envMap = sharedEnv;
  return m;
}

// Sides: same color as the front (`SLAB_ICE_COLOR`, copied verbatim, not re-picked), but opaque —
// no transmission — so it reads as a solid version of the same ice rather than a window that
// happens to blend into whatever's behind it. Every other shading property (roughness, clearcoat,
// envMapIntensity, grain maps) is copied from the front material too, not re-tuned. That alone
// still weren't enough: the box's two directional lights (skey/srim, both positioned with a
// positive-Z bias so they mainly illuminate the *front*) leave the side faces genuinely, physically
// darker whenever tilt exposes them, regardless of what the material's own base color is — real
// lighting angle, not a leftover color mismatch. Fixed with a matching `emissive` term at a modest
// intensity: gives the edge material a baseline "self-lit" floor in the *exact same* color, so it
// reads close to the target hue regardless of which face is exposed or which direction the tilt
// goes, while the same roughness/clearcoat/envMap as the front still layer real specular/reflection
// detail on top rather than looking like a flat, unlit swatch.
function slabEdgeMaterial() {
  const grain = slabGrainTextures();
  const m = new THREE.MeshPhysicalMaterial({
    color: SLAB_ICE_COLOR, metalness: 0, envMapIntensity: 0.92,
    roughness: 0.28,
    clearcoat: 0.42, clearcoatRoughness: 0.28,
    roughnessMap: grain.roughnessMap,
    normalMap: grain.normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    transmission: 0,
    emissive: new THREE.Color(SLAB_ICE_COLOR), emissiveIntensity: 0.55,
  });
  m.envMap = sharedEnv;
  return m;
}

function placeholderTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 8;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 8, 8);
  g.addColorStop(0, '#1b2a2e'); g.addColorStop(1, '#34454a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 8, 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// The video/photo behind the ice reads noticeably darker than the source once seen through the
// ice's own transmission/attenuation (that absorption is what makes it look like ice at all, so it
// can't just be removed) — this is a deliberate visual trick to compensate, brightening the content
// itself so the *combined* result (content seen through the ice's own darkening) reads close to
// how bright the source actually is.
//
// Tried first as a per-frame Canvas 2D `filter` + `drawImage(videoEl)` relay into a CanvasTexture,
// in place of a raw THREE.VideoTexture — reverted. Confirmed empirically that this specific pattern
// (redrawing a real video frame through a 2D canvas into a WebGL texture, every frame, at real
// video resolution) throws real `GL_INVALID_VALUE: glCopySubTextureCHROMIUM: Offset overflows
// texture dimensions` errors and renders as a flat gray plane instead of the video, in this
// environment — happened identically with or without the filter itself applied, so it's the
// relay-through-canvas step that's broken here, not the brightening math. Since this project's
// entire testing setup runs on software WebGL (SwiftShader) and that failure could plausibly be a
// software-GL-specific gap in a fast-path GPU copy extension rather than something that would also
// break on the user's real hardware-accelerated browser — the risk of shipping it and silently
// breaking the video for real visitors outweighs a brightness nicety. Reaching for a stock material
// property instead: `envMap` + `combine: THREE.AddOperation` on the content's own
// MeshBasicMaterial additively lifts its color by a flat amount, using the *original*, proven-
// reliable THREE.VideoTexture/TextureLoader pipeline untouched — no shader code, no per-frame
// canvas relay, so none of the above risk applies.
function brightenEnvTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const _slabBrightenEnv = brightenEnvTexture();   // one shared static texture, reused everywhere — never redrawn, so none of the per-frame relay risk applies

// Real photos pulled from each client's own site (their hero frame sequence — site/js/ice.js's
// sibling doc on hero videos has the full provenance) for the two gallery shots per project,
// replacing the flat placeholder gradient. Mapped by panel id, in the same order as each panel's
// `.pf-shot-canvas` elements appear in the DOM. `aspect` is each file's *real*, measured pixel
// aspect (checked directly via ffprobe, not assumed) — these are the client's own real project
// photos, each a different shape, so the ice rectangle built for each shot matches its own
// actual photo rather than a one-size-fits-all guess.
const SLAB_SHOT_IMAGES = {
  'detail-builders': [
    { url: 'assets/images/builders-shot-1.webp', aspect: 1255 / 841 },
    { url: 'assets/images/builders-shot-2.webp', aspect: 1057 / 874 },
  ],
  'detail-drafting': [
    { url: 'assets/images/drafting-shot-1.webp', aspect: 870 / 811 },
    { url: 'assets/images/drafting-shot-2.webp', aspect: 820 / 806 },
  ],
  'detail-realty': [
    { url: 'assets/images/realty-shot-1.webp', aspect: 1055 / 912 },
    { url: 'assets/images/realty-shot-2.webp', aspect: 823 / 802 },
  ],
};

// Cursor position, tracked globally (window, not any one element) so the slab leans toward the
// cursor no matter where on the page it is — exactly the same window-scoped `mtx`/`mty` pattern
// the portfolio ice cubes already use for their own cursor lean (see `TILT`/`CURSOR_EASE` near the
// top of this file), not scoped to hovering any particular canvas.
let slabMtx = 0, slabMty = 0;
addEventListener('pointermove', (e) => {
  slabMtx = (e.clientX / innerWidth) * 2 - 1;
  slabMty = (e.clientY / innerHeight) * 2 - 1;
});

// Greedy word-wrap for the sub/pitch line — canvas has no built-in text wrapping.
function _wrapCanvasText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Pulls the hero caption (kicker/title/pitch) straight off each panel's existing
// `.pf-dhero-text` DOM block — real computed styles (color, font-family, weight, letter-spacing,
// text-transform), not a second hand-typed copy of the per-brand CSS in JS. Works even while the
// block is `display:none` (confirmed: font/color/size — none of them layout-dependent — resolve
// correctly on a display:none element; only actual box-layout properties wouldn't). This is the
// single source of truth for "what does this project's hero caption say and look like" — the DOM
// stays the authoring surface, JS just reads it to build the in-scene version.
function extractDheroTextData(panel) {
  const wrap = panel.querySelector('.pf-dhero-text');
  const preEl = wrap && wrap.querySelector('.pf-dhero-pre');
  const titleEl = wrap && wrap.querySelector('.pf-dhero-title');
  const subEl = wrap && wrap.querySelector('.pf-dhero-sub');
  const heroCanvas = panel.querySelector('.pf-dhero-canvas');
  if (!wrap || !preEl || !titleEl || !subEl || !heroCanvas) return null;

  const titleLines = [];
  titleEl.childNodes.forEach((node) => {
    if (node.nodeName === 'BR') { titleLines.push(''); return; }
    const t = node.textContent || '';
    if (titleLines.length === 0) titleLines.push(t); else titleLines[titleLines.length - 1] += t;
  });

  const csWrap = getComputedStyle(wrap), csPre = getComputedStyle(preEl), csTitle = getComputedStyle(titleEl), csSub = getComputedStyle(subEl);
  return {
    refWidth: heroCanvas.clientWidth || 900,
    padding: parseFloat(csWrap.paddingLeft) || 24,
    pre: {
      text: preEl.textContent.trim(), color: csPre.color, font: csPre.fontFamily,
      size: parseFloat(csPre.fontSize), weight: csPre.fontWeight,
      spacing: parseFloat(csPre.letterSpacing) || 0, transform: csPre.textTransform,
      opacity: parseFloat(csPre.opacity),
    },
    title: {
      lines: titleLines.map((l) => l.trim()).filter(Boolean), color: csTitle.color,
      font: csTitle.fontFamily, size: parseFloat(csTitle.fontSize), weight: csTitle.fontWeight,
      transform: csTitle.textTransform,
    },
    sub: {
      text: subEl.textContent.trim(), color: csSub.color, font: csSub.fontFamily,
      size: parseFloat(csSub.fontSize), style: csSub.fontStyle, opacity: parseFloat(csSub.opacity),
    },
  };
}

// Renders the caption directly into the 3D scene (a transparent-background canvas texture on its
// own plane) instead of a DOM overlay — per explicit request: it needs to sit *behind* the ice
// (seen through its transmission, same as the video) with no scrim/gradient behind it, just the
// glyphs themselves. Sized to `contentAspect` (the video's own aspect, not the ice's larger
// silhouette) — "form to fit the video, not the ice." Font sizes/padding are the *real* computed
// CSS values from extractDheroTextData, rescaled by `refWidth` (the real hero box's own width)
// against this canvas's chosen resolution, so the typography keeps the same real-world proportions
// it was tuned at instead of an arbitrarily re-guessed scale.
function slabTextTexture(data, contentAspect) {
  const CANVAS_W = 1600;
  const CANVAS_H = Math.round(CANVAS_W / contentAspect);
  const scale = CANVAS_W / data.refWidth;

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  const padX = Math.max(20, data.padding * scale);
  const padB = Math.max(20, data.padding * scale);
  const maxTextWidth = CANVAS_W - padX * 2;

  const preSize = data.pre.size * scale;
  const titleSize = data.title.size * scale;
  const subSize = data.sub.size * scale;
  const titleLineHeight = titleSize * 1.08;
  const subLineHeight = subSize * 1.4;

  ctx.font = `${data.sub.style === 'italic' ? 'italic ' : ''}${subSize}px ${data.sub.font}`;
  const subLines = _wrapCanvasText(ctx, data.sub.text, maxTextWidth);

  const preBlockH = data.pre.text ? preSize * 1.9 : 0;
  const titleBlockH = data.title.lines.length * titleLineHeight + titleSize * 0.5;
  const subBlockH = subLines.length * subLineHeight;
  let cursorY = CANVAS_H - padB - (preBlockH + titleBlockH + subBlockH);

  if (data.pre.text) {
    const preLine = data.pre.transform === 'uppercase' ? data.pre.text.toUpperCase() : data.pre.text;
    ctx.globalAlpha = data.pre.opacity;
    ctx.fillStyle = data.pre.color;
    ctx.font = `${data.pre.weight} ${preSize}px ${data.pre.font}`;
    ctx.letterSpacing = `${data.pre.spacing * scale}px`;
    cursorY += preSize;
    ctx.fillText(preLine, padX, cursorY);
    ctx.letterSpacing = '0px';
    cursorY += preSize * 0.9;
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = data.title.color;
  ctx.font = `${data.title.weight} ${titleSize}px ${data.title.font}`;
  for (const line of data.title.lines) {
    const text = data.title.transform === 'uppercase' ? line.toUpperCase() : line;
    cursorY += titleLineHeight;
    ctx.fillText(text, padX, cursorY);
  }
  cursorY += titleSize * 0.5;

  ctx.globalAlpha = data.sub.opacity;
  ctx.fillStyle = data.sub.color;
  ctx.font = `${data.sub.style === 'italic' ? 'italic ' : ''}${subSize}px ${data.sub.font}`;
  for (const line of subLines) {
    cursorY += subLineHeight;
    ctx.fillText(line, padX, cursorY);
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const _slabInstances = new Map();   // canvas element -> instance
function setupSlabCanvas(canvasEl, { aspect, videoEl, textData, imageUrl, siteUrl, sizeMult, brightenOpacity = 0 }) {
  // Keep the *CSS box's own shape* in sync with the real content aspect, from the same single
  // source of truth (`aspect`, from HERO_ASPECT / SLAB_SHOT_IMAGES) computeSlabFov below already
  // uses to size the geometry — real client-photo aspects (measured via ffprobe) vary from ~1.02
  // to ~1.49, nowhere near the CSS's static `aspect-ratio: 16/9` fallback (site/css/main.css
  // `.pf-detail-hero, .pf-detail-shot` — left in place only as a pre-JS/no-JS default). Mismatched
  // box vs. content aspect was a previously-diagnosed, previously-fixed bug (see this function's own
  // FOV-history comment below) that quietly reappeared once real, non-16:9 gallery photos replaced
  // the old ~16:9 placeholders: `computeSlabFov()` has to widen the camera enough to cover the
  // *canvas's own* (CSS-driven) aspect, not just the content's, so a squarer photo in a still-16:9
  // box left large unused margin on both sides — exactly "the image is small, the border looks
  // massive." Setting the box's real aspect-ratio here, before layout/resize ever runs, removes that
  // mismatch at the root rather than re-tuning FOV/margin numbers to paper over it.
  canvasEl.parentElement.style.aspectRatio = String(aspect);
  const slabRenderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true, powerPreference: 'low-power' });
  slabRenderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  slabRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  slabRenderer.toneMappingExposure = 1.2;
  slabRenderer.outputColorSpace = THREE.SRGBColorSpace;

  const slabScene = new THREE.Scene();
  slabScene.environment = sharedEnv;
  // History of this margin system (kept because the reasoning matters for anyone touching it
  // again): started as a single fixed distance at a narrow 28° FOV (4.0, zero margin, clipped under
  // any tilt) → pulled back to 5.5, then 6.5, tuning *distance* each time margin ran out — solving
  // the wrong variable, since apparent size is size/distance alone, and pulling the camera back to
  // gain margin necessarily shrank the box every time ("the size SHOULD NOT CHANGE"). Fixed that by
  // holding distance fixed and widening FOV instead — but then shipped that fix as one blanket 50°
  // constant "for every aspect," reasoning the excess margin at wider aspects was harmless. That
  // reasoning was the *next* bug: how much of its own canvas an object visually fills is
  // FOV-dependent (fraction-of-frame = object's true angular size ÷ camera FOV), so a FOV padded for
  // the narrowest measured aspect leaves *enormous* unused margin at every wider one — this canvas's
  // real on-page aspect measurably ranges ~1.2-2.55 across ordinary viewport widths (`.pf-detail-
  // hero`/`-shot`'s CSS height is vh-clamped independently of its column-driven width, nothing like
  // a fixed 16:9), and the exact tight-fit minimum across that real range turned out to be
  // 24.5-44.75°, nowhere near the shipped 50 — i.e. "you made it tiny" was correct, and distance was
  // never actually the culprit a second time; a fixed FOV blind to the real aspect range was.
  // Fixed for real via `computeSlabFov()` (declared above, module-scope): the *exact* per-aspect
  // minimum, recomputed on every resize since aspect isn't knowable before layout — this is the only
  // way to maximize fraction-of-frame fill (i.e. actual apparent size) at every real viewport while
  // still guaranteeing zero clipping at whatever aspect currently applies, not just the one aspect a
  // dev viewport happened to be tested at.
  const SLAB_CAM_Z = 6.5;          // fixed distance — apparent size is size/distance; FOV never touches this
  const slabCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 20);   // fov is a placeholder, set for real in slabResize()
  const camZ = SLAB_CAM_Z;
  slabCamera.position.set(0, 0, camZ);
  slabCamera.lookAt(0, 0, 0);

  const skey = new THREE.DirectionalLight(0xeaf4ff, 1.8); skey.position.set(2, 3, 4); slabScene.add(skey);
  const srim = new THREE.DirectionalLight(0x9fd6ff, 1.3); srim.position.set(-3, 1, -2); slabScene.add(srim);
  slabScene.add(new THREE.AmbientLight(0x2a3844, 0.85));

  // Video gets the per-frame brighten treatment; a static gallery photo gets the same one-shot;
  // anything else (no real asset yet) keeps the flat placeholder gradient, unbrightened (there's
  // nothing there to compensate for).
  let texture;
  if (videoEl) {
    texture = new THREE.VideoTexture(videoEl);
    texture.colorSpace = THREE.SRGBColorSpace;
  } else if (imageUrl) {
    texture = new THREE.TextureLoader().load(new URL(imageUrl, document.baseURI).href);
    texture.colorSpace = THREE.SRGBColorSpace;
  } else {
    texture = placeholderTexture();
  }

  // flatHalfX/flatHalfY are the exact real-world half-dimensions of this instance's flat front
  // face — now literally the whole box's own front face, no bevel to account for. Still a small
  // SLAB_FACE_CLEARANCE inset (tighter now than when there was a bevel to refract through — just
  // enough that the content's edge never sits exactly flush with the ice's own silhouette edge).
  const SLAB_FACE_CLEARANCE = 0.94;
  const { geometry: slabGeo, flatHalfX, flatHalfY } = buildSlabGeometry(aspect, sizeMult);
  const geoBox = slabGeo.boundingBox;
  const frontFaceZ = geoBox.max.z;   // nearest the camera — already baked into world units, no scale multiply needed
  const backFaceZ = geoBox.min.z;    // farthest from the camera
  // Content sits genuinely *inside* the ice's own depth range, not in clear air behind it — but only
  // just inside, near the FRONT face now, not deep toward the back (an earlier version of this used
  // 25% in from the back face, i.e. ~75% of the ice's own depth away from the front). That deep
  // placement caused a real bug once SLAB_TILT increased (see the "not seeing the sides" fix above):
  // a flat plane sitting at a meaningfully different Z than the ice's own front face parallax-shifts
  // at a different *rate* than the front face's silhouette as the camera orbits off-axis — two
  // objects at different distances from an orbiting camera sweep different screen-space arcs per
  // degree of rotation, purely from perspective, even though neither object itself moves. At the
  // small original tilt angle this was invisible; at the larger angle needed to actually see the
  // ice's sides, the content visibly poked out past the ice's own edge when viewed off-axis — the
  // exact "text/image clips outside the ice" bug reported live. The only fix that holds at *any*
  // tilt angle (not just a re-tuned margin that happens to survive the current SLAB_TILT value) is
  // keeping content close enough to the front face that the differential parallax stays negligible
  // — CONTENT_FRONT_INSET_FRACTION is a small fraction of the ice's own depth, measured in from the
  // front face rather than the back, so content still reads as "inside the ice, not flush on the
  // glass" without reintroducing the mismatch.
  const CONTENT_FRONT_INSET_FRACTION = 0.06;
  const contentZ = frontFaceZ - (frontFaceZ - backFaceZ) * CONTENT_FRONT_INSET_FRACTION;
  // Content sitting at a different depth than the ice's own front face subtends a different visual
  // angle from the camera (basic perspective) — without correcting for that, the "fills the face"
  // sizing would drift off as soon as contentZ isn't exactly at frontFaceZ. Scale the plane by the
  // ratio of its actual distance from the camera to the ice's own front-face distance, so it still
  // fills that face's outline from the camera's viewpoint regardless of exactly how deep inside
  // the ice it sits.
  const perspectiveComp = (slabCamera.position.z - contentZ) / (slabCamera.position.z - frontFaceZ);

  const contentPlaneW = 2 * flatHalfX * SLAB_FACE_CLEARANCE * perspectiveComp;
  const contentPlaneH = 2 * flatHalfY * SLAB_FACE_CLEARANCE * perspectiveComp;
  const contentMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(contentPlaneW, contentPlaneH),
    // envMap+combine (see _slabBrightenEnv above) was the original brighten trick — `reflectivity`
    // left at 0 (was 0.3) per an explicit user request to drop all artificial brightening and show
    // the actual source video/photo at its own real exposure, unmodified. Kept wired (not deleted)
    // in case a future request needs it again; `reflectivity: 0` makes this term a no-op.
    new THREE.MeshBasicMaterial({
      map: texture, toneMapped: false,
      envMap: _slabBrightenEnv, combine: THREE.AddOperation, reflectivity: 0,
    }),
  );
  contentMesh.position.z = contentZ;
  contentMesh.renderOrder = 0;
  contentMesh.visible = SLAB_SHOW_CONTENT;
  slabScene.add(contentMesh);

  // Brighten mechanism (kept, not deleted, for a future request): a plain white plane, same
  // size/position as the content, rendered with THREE.AdditiveBlending — a directly additive GPU
  // blend (`result = dst + src*opacity`). Previously used at a shared 0.5, with a Drafting-specific
  // override tried up to 0.95 — all of that was reverted per an explicit user request to stop
  // artificially brightening the panels and show the real source video/photos (several of which are
  // full screenshots of genuinely dark-themed client sites, not just video) at their true exposure.
  // `brightenOpacity` now defaults to 0 (see setupSlabCanvas's own signature) — this mesh still
  // exists and renders, it's just fully transparent at opacity 0, i.e. a no-op.
  const brightenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(contentPlaneW, contentPlaneH),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: brightenOpacity,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  brightenMesh.position.z = contentZ + 0.001;
  brightenMesh.renderOrder = 0.2;
  brightenMesh.visible = SLAB_SHOW_CONTENT;
  slabScene.add(brightenMesh);

  // Gold frame — replaces the old flat CSS `border` on `.pf-detail-hero`/`.pf-detail-shot`
  // (site/css/main.css) per an explicit user request: a DOM-level CSS border can't track a
  // WebGL scene's own camera-orbit tilt, so it necessarily either clips the content when set
  // tight, or (the state before this fix) has to sit way outside the content to guarantee no
  // clipping — reading as "a huge border around a tiny image." Rendering the frame as thin
  // gold bars *inside this same scene*, at content's own Z depth, makes it subject to the exact
  // same camera projection as the content plane — it perspective-shifts together with the image
  // under tilt by construction, not by a separately-tuned margin, so it can sit right at the
  // content's edge with only a hairline gap instead of the old large safety margin.
  // `0xD4A24C` matches `--gold` in main.css exactly (same accent, not a separate guess).
  //
  // Style directly copied from the real macoyoshdrafting.com CSS (MacoyoshDrafting Video/css/
  // style.css, read directly rather than guessed) — an earlier corner-diamond version was
  // dropped per explicit request in favor of this. That stylesheet uses one consistent double-
  // border technique everywhere it frames an image (`.portfolio-card`, `.gallery-item`,
  // `.testi-card`, hero/about photos, all found via the same `border:` + `outline:` pair):
  // a solid 2px border directly on the element, plus a fainter, semi-transparent 1px outline
  // sitting outside it with `outline-offset` — e.g. `border: 2px solid var(--brass); outline:
  // 1px solid rgba(184,154,106,.2); outline-offset: 6px;`. Reproduced here as two concentric
  // rings of bars (a solid inner frame, a thinner/fainter outer one with a gap between them) —
  // colored with Seal Point's own `--gold`, not Drafting's `--brass`, since this frame wraps
  // all three clients' panels, not just Drafting's.
  const SLAB_BORDER_GAP = 0.02;        // hairline breathing room, not a safety margin — see above
  const SLAB_BORDER_THICKNESS = 0.055;
  const borderInnerW = contentPlaneW + SLAB_BORDER_GAP * 2;
  const borderInnerH = contentPlaneH + SLAB_BORDER_GAP * 2;
  const borderOuterW = borderInnerW + SLAB_BORDER_THICKNESS * 2;
  const borderOuterH = borderInnerH + SLAB_BORDER_THICKNESS * 2;
  const borderMat = new THREE.MeshBasicMaterial({ color: 0xD4A24C, toneMapped: false });
  const borderGroup = new THREE.Group();
  const barH = new THREE.PlaneGeometry(borderInnerW, SLAB_BORDER_THICKNESS);   // top/bottom
  const barV = new THREE.PlaneGeometry(SLAB_BORDER_THICKNESS, borderOuterH);   // left/right, spans full outer height so corners are covered
  const borderTop = new THREE.Mesh(barH, borderMat);
  borderTop.position.y = borderInnerH / 2 + SLAB_BORDER_THICKNESS / 2;
  const borderBottom = new THREE.Mesh(barH, borderMat);
  borderBottom.position.y = -(borderInnerH / 2 + SLAB_BORDER_THICKNESS / 2);
  const borderLeft = new THREE.Mesh(barV, borderMat);
  borderLeft.position.x = -(borderInnerW / 2 + SLAB_BORDER_THICKNESS / 2);
  const borderRight = new THREE.Mesh(barV, borderMat);
  borderRight.position.x = borderInnerW / 2 + SLAB_BORDER_THICKNESS / 2;
  // Outer "outline" ring — the `outline` half of Drafting's own border+outline pair: thinner
  // (~half the inner border's thickness, matching that CSS's 1px-vs-2px ratio), lower opacity
  // (matching that CSS's rgba(...,.2) — closer to that literal value than the first pass, which
  // had bumped it up to stay visible and ended up reading too solid/opaque), and offset outward
  // by a real gap (`outline-offset`'s exact role) rather than touching the inner frame — pulled
  // tighter than the first pass per explicit feedback ("closer").
  const SLAB_OUTLINE_GAP = SLAB_BORDER_THICKNESS * 1.3;
  const SLAB_OUTLINE_THICKNESS = SLAB_BORDER_THICKNESS * 0.5;
  const outlineInnerW = borderOuterW + SLAB_OUTLINE_GAP * 2;
  const outlineInnerH = borderOuterH + SLAB_OUTLINE_GAP * 2;
  const outlineOuterW = outlineInnerW + SLAB_OUTLINE_THICKNESS * 2;
  const outlineOuterH = outlineInnerH + SLAB_OUTLINE_THICKNESS * 2;
  const outlineMat = new THREE.MeshBasicMaterial({
    color: 0xD4A24C, transparent: true, opacity: 0.22, toneMapped: false,
  });
  const outlineBarH = new THREE.PlaneGeometry(outlineInnerW, SLAB_OUTLINE_THICKNESS);
  const outlineBarV = new THREE.PlaneGeometry(SLAB_OUTLINE_THICKNESS, outlineOuterH);
  const outlineTop = new THREE.Mesh(outlineBarH, outlineMat);
  outlineTop.position.y = outlineInnerH / 2 + SLAB_OUTLINE_THICKNESS / 2;
  const outlineBottom = new THREE.Mesh(outlineBarH, outlineMat);
  outlineBottom.position.y = -(outlineInnerH / 2 + SLAB_OUTLINE_THICKNESS / 2);
  const outlineLeft = new THREE.Mesh(outlineBarV, outlineMat);
  outlineLeft.position.x = -(outlineInnerW / 2 + SLAB_OUTLINE_THICKNESS / 2);
  const outlineRight = new THREE.Mesh(outlineBarV, outlineMat);
  outlineRight.position.x = outlineInnerW / 2 + SLAB_OUTLINE_THICKNESS / 2;
  borderGroup.add(
    borderTop, borderBottom, borderLeft, borderRight,
    outlineTop, outlineBottom, outlineLeft, outlineRight,
  );
  borderGroup.position.z = contentZ + 0.0015;
  borderGroup.renderOrder = 0.3;
  borderGroup.visible = SLAB_SHOW_CONTENT;
  slabScene.add(borderGroup);

  // Caption text, when this instance has any (hero canvases only — gallery shots have no
  // `.pf-dhero-text`): its own plane, same footprint as the content plane (not the ice's larger
  // one — "fit the video, not the ice"), sitting just in front of the video (renderOrder between
  // content and ice) so it reads as *on* the video, both still seen through the ice's own
  // transmission. No backing quad/gradient — the material has no `map` until the text texture
  // itself (transparent background, glyphs only) is ready.
  //
  // Deliberately NOT `transparent: true`. Three.js's transmission capture (what lets the ice see
  // "through" to whatever's behind it) reliably includes genuinely *opaque* objects — the video
  // plane already proves that — but alpha-blended transparent objects are a known weak spot: they
  // don't reliably composite into that same capture, which is why this read as invisible through
  // real transmission despite rendering fine in the no-transmission `?frosted` fallback. `alphaTest`
  // instead keeps the material in the *opaque* render bucket (each fragment is either fully drawn
  // or fully discarded, never blended) while the canvas's transparent background between glyphs
  // still lets the video show through untouched. Trade-off: slightly harder-edged glyph
  // antialiasing than true alpha blending — worth it for actually being visible.
  if (textData) {
    const textMat = new THREE.MeshBasicMaterial({ toneMapped: false, alphaTest: 0.5 });
    const textMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(
        2 * flatHalfX * SLAB_FACE_CLEARANCE * perspectiveComp,
        2 * flatHalfY * SLAB_FACE_CLEARANCE * perspectiveComp,
      ),
      textMat,
    );
    textMesh.position.z = contentZ + 0.02;
    textMesh.renderOrder = 0.5;
    textMesh.visible = SLAB_SHOW_CONTENT;
    slabScene.add(textMesh);
    // `document.fonts.ready` alone isn't reliable here: it only resolves for fonts the browser has
    // *already decided to fetch*, and since `.pf-dhero-title`/`-sub` are `display:none`, the browser
    // may never trigger a fetch for Cormorant Garamond/Fraunces through them at all — `.ready`
    // could resolve before those font files are actually in hand, and canvas text silently
    // substitutes a fallback rather than waiting. `document.fonts.load(...)` actively requests each
    // specific font/weight/style this caption needs, so the texture only gets drawn once they're
    // genuinely available.
    const fontSpecs = new Set([
      `${textData.pre.weight} ${textData.pre.size}px ${textData.pre.font}`,
      `${textData.title.weight} ${textData.title.size}px ${textData.title.font}`,
      `${textData.sub.style === 'italic' ? 'italic ' : ''}${textData.sub.size}px ${textData.sub.font}`,
    ]);
    Promise.all([...fontSpecs].map((spec) => document.fonts.load(spec).catch(() => {}))).then(() => {
      textMat.map = slabTextTexture(textData, flatHalfX / flatHalfY);
      textMat.needsUpdate = true;
    });
  }

  // Content added to the scene *before* the ice mesh, and the ice given an explicit higher
  // renderOrder, so the opaque video is guaranteed to be in the transmission source before the
  // ice's own transmissive pass samples it — not left to implicit default ordering.
  // Per-face materials (BoxGeometry's 6 auto-groups, confirmed order [px, nx, py, ny, pz, nz] by
  // direct inspection — see portfolio-detail-hero-videos memory): index 4 (pz) is the camera-facing
  // front, showing the content through the glossy/transmissive material; the other 5 (the 4 sides
  // plus the never-really-seen back face) get the opaque, same-color edge material.
  const slabFrontMat = slabIceMaterial();
  const slabEdgeMat = slabEdgeMaterial();
  const slabMesh = new THREE.Mesh(slabGeo, [slabEdgeMat, slabEdgeMat, slabEdgeMat, slabEdgeMat, slabFrontMat, slabEdgeMat]);
  slabMesh.renderOrder = 1;
  slabMesh.visible = SLAB_SHOW_ICE;
  slabScene.add(slabMesh);

  // Cursor lean — orbits the *camera* around the scene, never rotates the ice/content/text
  // themselves. Rotating the objects (an earlier version of this) caused a real bug: the content
  // plane sits at a meaningfully different Z depth than the ice mesh's own centre (behind it, per
  // the "must sit behind the ice" fix earlier in this file), so spinning both around one shared
  // pivot swings the farther-back content through a wider screen-space arc than the ice per
  // degree of rotation — basic perspective, things farther from a rotation pivot foreshorten at a
  // different apparent rate — which showed up as the video visibly stretching/sliding relative to
  // the ice's own frame edges as it tilted, even though the two were perfectly rigidly linked in
  // 3D. Orbiting the camera instead means the ice, content and text *never move relative to each
  // other at all* — only the vantage point changes — so that whole class of mismatch is
  // structurally impossible, not just tuned smaller.
  //
  // A second, separate bug got missed the first time round: `lookAt` guarantees the camera always
  // *points at* the scene origin, but that is not the same thing as guaranteeing the object stays
  // fully inside the camera's frustum — a wrongly-confident claim in an earlier version of this
  // comment. The ice was originally tuned to fill ~100% of its canvas edge-to-edge *at rest*, zero
  // margin by design, which meant there was never any headroom for a tilted object's on-screen
  // silhouette (generically larger than its head-on one — you're seeing a mix of front face and
  // side depth at once) to grow into, so it clipped against the canvas's own rectangular edge.
  //
  // First fix attempt made it *worse*: pulling the camera back proportionally to the live tilt
  // amount (extra margin exactly while tilting) technically stopped the clipping, but it added a
  // zoom motion that doesn't exist in the reference behaviour at all — the portfolio ice cubes
  // never change distance, ever, they only rotate — and that extra, tilt-coupled zoom was read as
  // a "bounce." Fixed for real this time by separating the two concerns instead of coupling them:
  // margin is now a fixed, permanent camera distance (`camZ` = `SLAB_CAM_Z`, see its declaration
  // above — constant at rest, mid-tilt, and full-tilt, no dynamic component at all) so there's
  // nothing left to bounce. `applySlabOrbit` is pure rotation, full stop — same as the cubes' own
  // quaternion tilt.
  //
  // SLAB_TILT (module-scoped now, see its declaration near TILT above — computeSlabFov's tilt-combo
  // list needs it too) was originally set to match the portfolio cubes' own TILT exactly, for
  // identical motion. Bumped to 3x that afterward: at the cubes' own TILT (0.17 rad, ~9.7°), the
  // camera orbit barely grazes the box's depth — verified headlessly (a raw RGB scanline across the
  // revealed edge, an exaggerated-multiplier A/B render, and 2x/3x comparison renders) that the side
  // face genuinely renders (the fresnel-glow material above does show up), it's just too thin a
  // sliver at the cubes' own angle to read as "seeing the side of the ice." 3x was the smallest
  // multiplier that gave a clearly, unmistakably visible edge at every tilt extreme (left/right/top/
  // bottom, both hero and gallery-shot sizes) with zero clipping — the direct fix for "not enough of
  // the box's own depth is exposed," without touching material or depth ratio.
  const _slabOrbitQuat = new THREE.Quaternion();
  const _slabOrbitEuler = new THREE.Euler();
  let tiltX = 0, tiltY = 0;
  function applySlabOrbit(distance) {
    _slabOrbitEuler.set(-tiltX, -tiltY, 0);
    _slabOrbitQuat.setFromEuler(_slabOrbitEuler);
    slabCamera.position.set(0, 0, distance).applyQuaternion(_slabOrbitQuat);
    slabCamera.lookAt(0, 0, 0);
  }

  // Hero-only: click the slab to swoop in (re-centring the parallax offset as part of the same
  // motion, then dollying/widening FOV like the portfolio ice-cube's own click swoop) and open the
  // real client site. `siteUrl` comes from that panel's own "Visit site" link — one source of truth,
  // not a second hand-typed URL list.
  let heroZoomActive = false;
  if (textData && siteUrl) {
    canvasEl.style.cursor = 'pointer';
    const flashEl = document.createElement('div');
    flashEl.className = 'pf-zoom-flash';
    flashEl.setAttribute('aria-hidden', 'true');
    canvasEl.parentElement.appendChild(flashEl);
    const HERO_ZOOM_MS = 700;
    const HERO_ZOOM_FLASH_START = 0.7;
    const heroZoomTargetZ = frontFaceZ + 0.35;   // stop just short of the ice's own front face — never inside it
    let downX = 0, downY = 0;
    canvasEl.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
    canvasEl.addEventListener('click', (e) => {
      if (heroZoomActive) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;   // ignore drag-to-scroll releases
      heroZoomActive = true;
      const startDist = camZ;
      const startFov = slabCamera.fov;
      const targetFov = startFov * 1.7;
      const startTiltX = tiltX, startTiltY = tiltY;
      const t0 = performance.now();
      function tick(now) {
        const t = Math.min(1, (now - t0) / HERO_ZOOM_MS);
        const eased = t * t * t * t * t;   // quintic ease-in, matching the portfolio ice-cube swoop
        tiltX = startTiltX * (1 - eased);
        tiltY = startTiltY * (1 - eased);
        applySlabOrbit(startDist + (heroZoomTargetZ - startDist) * eased);
        slabCamera.fov = startFov + (targetFov - startFov) * eased;
        slabCamera.updateProjectionMatrix();
        flashEl.style.opacity = Math.max(0, (eased - HERO_ZOOM_FLASH_START) / (1 - HERO_ZOOM_FLASH_START)).toFixed(3);
        slabRenderer.render(slabScene, slabCamera);
        if (t < 1) { requestAnimationFrame(tick); return; }
        window.open(siteUrl, '_blank', 'noopener,noreferrer');
        // Reset so the panel looks normal again if the visitor stays on this tab/returns to it.
        // tiltX/tiltY already eased to 0 above, so this lands back exactly on the resting axis.
        applySlabOrbit(startDist);
        slabCamera.fov = startFov;
        slabCamera.updateProjectionMatrix();
        flashEl.style.opacity = '0';
        heroZoomActive = false;
        if (!inst.raf) inst.raf = requestAnimationFrame(slabDraw);
      }
      requestAnimationFrame(tick);
    });
  }

  const inst = { active: false, raf: 0, videoEl, canvasEl };
  const slabHeight = flatHalfY * 2, slabWidth0 = flatHalfX * 2, slabDepth = slabHeight * SLAB_DEPTH_RATIO;
  // The FOV-fit target is whichever object is actually the visible outer silhouette right now —
  // the ice slab when SLAB_SHOW_ICE is on (its real depth needs real margin to avoid clipping
  // under tilt), or just the gold frame when it's off (near-zero depth, and now the frame — not
  // the larger invisible ice geometry — is what "not clipping" actually means). Fitting to
  // whichever is bigger/actually-shown keeps this correct either way this toggle is set, and is
  // what lets the frame sit tight to the content instead of carrying the ice slab's own leftover
  // tilt margin now that the ice itself is hidden.
  // The outer outline ring (see borderGroup above) is now the true outer silhouette when the ice
  // is hidden, not the inner solid frame — the fit target has to cover its full extent
  // (outlineOuterW/H) or the outline itself would be the thing that clips under tilt.
  const fitW = SLAB_SHOW_ICE ? slabWidth0 : outlineOuterW;
  const fitH = SLAB_SHOW_ICE ? slabHeight : outlineOuterH;
  const fitD = SLAB_SHOW_ICE ? slabDepth : 0.01;
  function slabResize() {
    const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
    if (!w || !h) return;
    slabRenderer.setSize(w, h, false);
    const canvasAspect = w / h;
    slabCamera.aspect = canvasAspect;
    // Geometry's own width (slabWidth0) was built to match the *content's* aspect, which is close
    // to but not always identical to the canvas's real on-page aspect (canvasAspect) — feed the
    // fit-check the geometry's real dimensions at the camera's real aspect, not an assumption they
    // match, so the computed FOV is correct even if they've drifted apart slightly.
    slabCamera.fov = computeSlabFov(fitW, fitH, fitD, camZ, canvasAspect, SLAB_TILT_COMBOS);
    slabCamera.updateProjectionMatrix();
  }
  function slabDraw() {
    inst.raf = 0;
    if (!inst.active) return;
    if (heroZoomActive) return;   // the click-swoop above owns rendering (and the camera orbit) while it runs
    tiltX += (slabMty * SLAB_TILT * 0.7 - tiltX) * SLAB_CURSOR_EASE;
    tiltY += (slabMtx * SLAB_TILT - tiltY) * SLAB_CURSOR_EASE;
    applySlabOrbit(camZ);
    slabRenderer.render(slabScene, slabCamera);
    inst.raf = requestAnimationFrame(slabDraw);   // must keep looping while active — content texture only updates on render
  }
  inst.resize = slabResize;
  inst.start = () => {
    inst.active = true;
    slabResize();
    if (videoEl) videoEl.play().catch(() => {});
    if (!inst.raf) inst.raf = requestAnimationFrame(slabDraw);
  };
  inst.stop = () => {
    inst.active = false;
    if (videoEl) videoEl.pause();
    cancelAnimationFrame(inst.raf);
    inst.raf = 0;
  };
  _slabInstances.set(canvasEl, inst);
}

// Real aspect ratio of a canvas's own CSS box, not a hardcoded guess. `.pf-detail` is hidden via
// `visibility:hidden` (not `display:none`), so its children have real, measurable layout
// dimensions even before the panel opens — confirmed empirically (clientWidth/clientHeight report
// correctly pre-open). This matters: `.pf-detail-hero`'s height is `clamp(280px, 46vh, 560px)`
// while its width tracks a max-width content column — i.e. a genuinely responsive aspect that
// varies with viewport, not a fixed ratio. A hardcoded `aspect` (previously 1.9/1.25, guessed once
// and left stale as the CSS evolved) measurably diverged from the real thing (real hero ~2.03,
// real gallery shot ~1.33 at one tested viewport) — building the geometry for the wrong aspect
// means it doesn't actually match its own container, compounding with perspective into a
// distorted-looking bevel. Falls back to the old guess only if layout genuinely isn't available.
function realAspect(canvasEl, fallback) {
  const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
  return w > 0 && h > 0 ? w / h : fallback;
}
// Hero video is always framed 16:9 — a fixed constant, not the canvas element's own real CSS
// aspect (realAspect(), still used below as the shot fallback) — explicit request: the video's
// own proportions must never stretch to fit whatever shape the surrounding page layout happens to
// give the canvas. SLAB_HERO_SIZE_MULT makes the hero specifically bigger (not the gallery shots).
const HERO_ASPECT = 16 / 9;
const SLAB_HERO_SIZE_MULT = 1.32;
// Per-canvas setupSlabCanvas() args, captured up front (real layout is measurable pre-open — see
// realAspect() above, and `.pf-detail` only toggles opacity/visibility, never display — so nothing
// is lost by waiting) but not *invoked* until that panel's first openDetail(). Each call builds its
// own WebGLRenderer + decodes a full-res texture; doing that for all 3 panels' hero+shot canvases
// (9 total) unconditionally at page load was a real, previously-unaddressed cost sitting on top of
// the scroll-sequence frame memory — 9 extra WebGL contexts and their textures held for the whole
// page lifetime whether or not the visitor ever opens that panel, compounding with iOS Safari's low
// per-page cap on simultaneous WebGL contexts. Deferring to first-open cuts the eager count from 10
// contexts (1 portfolio scene + 9 detail) down to 1, and even then only builds the 3 contexts for
// whichever single panel was actually opened. Once built, an instance is kept (not torn down on
// close) so reopening the same panel doesn't pay the WebGLRenderer/texture cost again.
const _slabPending = new Map();     // canvas element -> setupSlabCanvas() opts, not yet called
const _slabInitedPanels = new Set();
function initDetailSlabs() {
  document.querySelectorAll('.pf-detail').forEach((panel) => {
    const heroCanvas = panel.querySelector('.pf-dhero-canvas');
    if (heroCanvas) {
      _slabPending.set(heroCanvas, {
        aspect: HERO_ASPECT,
        sizeMult: SLAB_HERO_SIZE_MULT,
        videoEl: panel.querySelector('.pf-dhero-video'),
        textData: extractDheroTextData(panel),
        siteUrl: panel.querySelector('.btn-solid')?.href,
      });
    }
    const shotImages = SLAB_SHOT_IMAGES[panel.id] || [];
    panel.querySelectorAll('.pf-shot-canvas').forEach((c, i) => {
      const shot = shotImages[i];
      _slabPending.set(c, { aspect: shot ? shot.aspect : realAspect(c, 1.25), imageUrl: shot && shot.url });
    });
  });
}
function ensurePanelSlabsBuilt(id) {
  if (_slabInitedPanels.has(id)) return;
  _slabInitedPanels.add(id);
  const panel = document.getElementById(id);
  if (!panel) return;
  panel.querySelectorAll('.pf-dhero-canvas, .pf-shot-canvas').forEach((c) => {
    const opts = _slabPending.get(c);
    if (opts) setupSlabCanvas(c, opts);
  });
}
// No GLB to wait for any more (plain BoxGeometry, built synchronously) — build immediately.
initDetailSlabs();
addEventListener('resize', () => { _slabInstances.forEach((inst) => { if (inst.active) inst.resize(); }); });

window.__iceFrame = {
  activatePanel(id) {
    ensurePanelSlabsBuilt(id);
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.querySelectorAll('.pf-dhero-canvas, .pf-shot-canvas').forEach((c) => {
      const inst = _slabInstances.get(c);
      if (inst) inst.start();
    });
  },
  deactivatePanel(id) {
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.querySelectorAll('.pf-dhero-canvas, .pf-shot-canvas').forEach((c) => {
      const inst = _slabInstances.get(c);
      if (inst) inst.stop();
    });
  },
};

resize();
