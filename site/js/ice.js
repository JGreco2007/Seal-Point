/* ============ Seal Point — "What we do" 3D ice chunks ============ */
/* Real-time organic ice chunks (igloo.inc style), one per project, that spin/roll
   past on scroll. Geometry = Blender-authored fractured chunks (ice-block-{1,2,3}.glb,
   voxel-remeshed for the melted-ice surface). Material = refractive frosted ice with a
   soft luminous backdrop so it reads translucent over the dark section. The project
   name lives in the HTML HUD (main.js), not inside the block.
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

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
camera.position.set(0, 0, 10);
camera.lookAt(0, 0, 0);

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

  void main() {
    vec2 advect = (texture2D(tAdvect, vUv * 3.0).xy * 2.0 - 1.0) * uTexel;
    vec2 uv = vUv + advect;
    float l = texture2D(tPrev, uv - vec2(uTexel, 0.0)).r;
    float r = texture2D(tPrev, uv + vec2(uTexel, 0.0)).r;
    float t = texture2D(tPrev, uv + vec2(0.0, uTexel)).r;
    float b = texture2D(tPrev, uv - vec2(0.0, uTexel)).r;
    float next = max(max(max(l, r), t), b);

    // no radius floor: once the cursor stops (velocity, and so uSplatRadius, decays to 0) the splat
    // must shrink to nothing too, or a fixed-size splat gets re-stamped at the same spot every single
    // frame forever, perfectly cancelling the decay below and pinning that spot at full brightness.
    float radius = ${FROST_RADIUS} * clamp(uSplatRadius, 0.0, 1.0);
    float d = lineDist(vUv, uSplatPrevPos, uSplatPos);
    next += (1.0 - smoothstep(0.0, max(radius, 1e-4), d)) * 0.9 * step(1e-4, radius);

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

/* ---------- procedural surface maps ---------- */
let _frost, _rough;
function frostNormal() {
  if (_frost) return _frost;
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
  const ctx = c.getContext('2d'), img = ctx.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const n = 118 + (Math.random() * 90 - 45);
    img.data[i * 4] = n; img.data[i * 4 + 1] = n; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  _frost = new THREE.CanvasTexture(c);
  _frost.wrapS = _frost.wrapT = THREE.RepeatWrapping; _frost.repeat.set(4, 4);
  return _frost;
}
/* low-frequency blobs → clear vs. frosted patches (roughness variation) */
function roughMap() {
  if (_rough) return _rough;
  const lo = 18, c0 = document.createElement('canvas'); c0.width = c0.height = lo;
  const x0 = c0.getContext('2d'), id = x0.createImageData(lo, lo);
  for (let i = 0; i < lo * lo; i++) { const n = Math.random() * 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = n; id.data[i * 4 + 3] = 255; }
  x0.putImageData(id, 0, 0);
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.drawImage(c0, 0, 0, s, s);
  _rough = new THREE.CanvasTexture(c);
  _rough.wrapS = _rough.wrapT = THREE.RepeatWrapping; _rough.repeat.set(1.5, 1.5);
  return _rough;
}

/* frosted / lightly-refractive ice — milky white-blue, matte frost (igloo.inc look) */
function iceMaterial(frost) {
  const base = {
    color: 0xeef7ff, metalness: 0,
    roughnessMap: roughMap(),
    clearcoat: 0.6, clearcoatRoughness: 0.28,
    envMapIntensity: FROSTED ? 1.4 : 1.6,
    normalMap: frostNormal(), normalScale: new THREE.Vector2(0.32, 0.32),
    transparent: true,
  };
  const m = FROSTED
    ? new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.42, opacity: 0.86 })
    : new THREE.MeshPhysicalMaterial({
        ...base, roughness: 0.34, opacity: 1.0,
        transmission: 0.84, thickness: 3.2, ior: 1.31,          // frostier + milkier than clear glass
        attenuationColor: new THREE.Color(0xbfe2f2), attenuationDistance: 2.2,
        iridescence: 0.08, iridescenceIOR: 1.3,
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
    frost.uniforms = shader.uniforms;   // advanceFrost() re-points tFrost here after every ping-pong swap
    // three's built-in `vUv`/`vRoughnessMapUv` etc. are transformed by each map's own repeat/offset
    // (ours has repeat 1.5×1.5) — that won't line up with raycast hit.uv, which is raw mesh UV. So we
    // pass our own untransformed UV through, matching exactly what the raycast hover reports.
    shader.vertexShader = shader.vertexShader
      .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nvarying vec2 vIceUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvIceUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform vec3 emissive;',
        'uniform vec3 emissive;\nuniform vec3 uGlow;\nuniform float uGlowStrength;\nuniform float uGlowPow;\nuniform float uCore;\n'
        + 'uniform sampler2D tFrost;\nuniform vec3 uFrostColorA;\nuniform vec3 uFrostColorB;\nuniform float uGridScale;\nuniform float uGridWidth;\n'
        + 'varying vec2 vIceUv;\nfloat _iceFrost = 0.0;\nfloat _iceRim = 0.0;')
      .replace('#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n'
        + '{ vec2 _fd = texture2D(tFrost, vIceUv).rg; _iceFrost = _fd.r; _iceRim = _fd.g; }')
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n'
        + 'roughnessFactor *= 1.0 - _iceFrost * 0.6;   // cursor "melts" a smoother, glossier patch')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n'
        + '{ float _f = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), uGlowPow);\n'
        + '  totalEmissiveRadiance += uGlow * (_f * uGlowStrength + uCore); }\n'
        + '{ vec2 _gv = fract(vIceUv * uGridScale); vec2 _gd = min(_gv, 1.0 - _gv);\n'
        + '  float _grid = 1.0 - smoothstep(0.0, uGridWidth, min(_gd.x, _gd.y));\n'
        // mostly teal, with purple only as a sparse per-cell hint (not a smooth gradient) — "here and there"
        + '  vec2 _cell = floor(vIceUv * uGridScale);\n'
        + '  float _hash = fract(sin(dot(_cell, vec2(127.1, 311.7))) * 43758.5453);\n'
        + '  float _purpleHint = smoothstep(0.72, 1.0, _hash) * 0.55;\n'
        + '  vec3 _frostColor = mix(uFrostColorA, uFrostColorB, _purpleHint);\n'
        + '  totalEmissiveRadiance += _frostColor * _iceFrost * 2.0;\n'          // soft glow across the whole revealed area, fades with it (~1s)
        + '  totalEmissiveRadiance += _frostColor * _grid * _iceFrost * 8.5;\n'  // grid pattern across that same area
        + '  totalEmissiveRadiance += _frostColor * _grid * _iceRim * 24.0; }'); // extra-bright pulse right at the growing wavefront
  };
  return m;
}

/* ---------- build the blocks once geometry is ready ---------- */
const blocks = [];
function buildBlocks(geos) {
  for (let i = 0; i < N; i++) {
    const grp = new THREE.Group();
    const frost = createFrost();
    const ice = new THREE.Mesh(geos[i % geos.length], iceMaterial(frost));
    ice.renderOrder = 2;
    grp.add(ice);
    grp.userData = { index: i, ice, frost, baseOp: FROSTED ? 0.86 : 1.0, phase: i * 0.8, phase2: i * 1.7 + 0.4 };
    scene.add(grp);
    blocks.push(grp);
  }
  resize();
  schedule();
}

// the Blender voxel-remesh export has no UV set at all (only position/normal) — needed both for the
// roughness/normal maps (which is why they've likely never actually been sampling right) and now for
// the frost effect's raycast hit.uv. Box-project one from the vertex normal's dominant axis.
function computeBoxUV(geo) {
  if (geo.attributes.uv) return geo;
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const s = 1 / Math.max(BW, BH, BD);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (nx >= ny && nx >= nz) { u = z; v = y; } else if (ny >= nx && ny >= nz) { u = x; v = z; } else { u = x; v = y; }
    uv[i * 2] = u * s + 0.5; uv[i * 2 + 1] = v * s + 0.5;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

const loader = new GLTFLoader();
function firstGeo(gltf) { let g = null; gltf.scene.traverse((o) => { if (o.isMesh && !g) g = o.geometry; }); return g; }
Promise.all([1, 2, 3].map((n) => loader.loadAsync(new URL(`assets/models/ice-block-${n}.glb`, document.baseURI).href)))
  .then((gltfs) => buildBlocks(gltfs.map(firstGeo).filter(Boolean).map(computeBoxUV)))
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
const _qTumble = new THREE.Quaternion(), _qTumble2 = new THREE.Quaternion();
const _qIntro = new THREE.Quaternion(), _qCursor = new THREE.Quaternion();
const _eCursor = new THREE.Euler();
const _yAxis = new THREE.Vector3(0, 1, 0);
function layout() {
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
    _qCursor.setFromEuler(_eCursor.set(cy * TILT * 0.7, cx * TILT, 0));
    g.quaternion.premultiply(_qCursor);            // lean toward the cursor — only nonzero once at rest (see draw())
    const edge = Math.max(0, Math.min(1, (CULLX - Math.abs(x)) / 2.6));  // soft fade only at the screen edges
    g.userData.ice.material.opacity = g.userData.baseOp * edge;
  }
}

/* ---------- render loop ---------- */
let active = false, raf = 0;
function draw() {
  raf = 0;
  if (!active || !blocks.length) return;
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
  renderer.render(scene, camera);
  const cursorEasing = Math.abs(towardX - cx) > 0.0008 || Math.abs(towardY - cy) > 0.0008;
  if (moving || cursorEasing || frostActive) { raf = requestAnimationFrame(draw); }   // keep going until settled
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
  if (!active) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;   // ignore drags
  const r = canvas.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(blocks, true)[0];
  if (!hit) return;
  let g = hit.object; while (g && g.userData.index === undefined) g = g.parent;
  const p = g && projects[g.userData.index];
  if (p && p.detailId && window.__sp && window.__sp.openDetail) window.__sp.openDetail(p.detailId);
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
  _debug: () => ({
    moving, cx, cy, active, progress, quats: blocks.map((b) => b.quaternion.toArray()),
    frost: blocks.map((b) => ({ visible: b.visible, lastHitTime: b.userData.frost.lastHitTime, velocity: b.userData.frost.velocity })),
  }),
};

resize();
