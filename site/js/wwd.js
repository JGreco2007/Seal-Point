/* ============ Seal Point — "What we do" Dimension tile ============ */
/* A small, self-contained WebGL scene for the "Dimension" capability tile: a faceted gem leaning
   toward a *fake*, internally-animated cursor (see updateFakeCursor below) rather than the
   visitor's real one — deliberately confined to this tile's own bounds, so the demo can't be
   dragged onto a neighboring card the way a page-wide real-cursor reading would. Same family of
   ice/glass material used throughout this site (see ice.js's iceMaterial()/slabIceMaterial()) but
   deliberately much simpler — this is a tiny decorative tile, not a hero element, so it uses stock
   MeshPhysicalMaterial properties only (no onBeforeCompile/custom GLSL), matching the "reach for
   stock PBR before a custom shader" lesson learned the hard way on the detail-slab ice (see
   portfolio-detail-hero-videos memory). Lazy-loaded + activated only while the "What we do" section
   is on-screen (main.js's scroll-driven onUpdate), same on-demand-render discipline as ice.js.

   Headless-verification note (same standing limitation documented at length in
   portfolio-detail-hero-videos memory, extended by two findings here): this scene's geometry/camera/
   scene-graph/activation logic were all directly verified correct — scene.children, the mesh's
   world matrix, and an explicit frustum-intersection test all confirmed valid, and the tile renders
   correctly in headless Chrome *in isolation*. But once the real ice.js/aurora.js have been loaded
   (i.e. after actually scrolling through the portfolio section first, which is the only way to
   reach this section on a real visit), this tile's canvas stops producing visible pixels in that
   same headless/SwiftShader environment — confirmed to be unrelated to raw WebGL context count
   (reproduced fine with 11 unrelated dummy contexts open) and unrelated to this file's own
   activation path (reproduced identically whether triggered by the real scroll timeline or by
   manually forcing activation after the fact) — so it's specifically something about SwiftShader's
   software rendering state after ice.js's own much heavier shader/PMREM usage, not a code bug here.

   Second finding (same root cause, a different symptom): under that same cumulative post-ice.js
   headless load, this file's own `draw()` rAF chain can appear to fully stall during a long CDP-idle
   gap (e.g. a plain multi-second `setTimeout` in a test script with no further Puppeteer calls) —
   not just missing pixels this time, but `updateFakeCursor()`'s DOM writes (the `.wwd-fake-cursor`
   dot's `left`/`top`) freezing too, which is pure JS/CSSOM and has nothing to do with WebGL paint
   output. Verified this is a headless/CDP artifact, not a real dead-loop bug: the identical `start()`/
   `draw()` code animates the dot continuously and correctly (confirmed frame-by-frame over 1s+) when
   loaded on its own with no prior heavy WebGL contexts, and again when polled via frequent CDP
   round-trips (which apparently keep headless Chrome's on-demand compositor "pumped") even after
   ice.js has loaded — it only reproduces the freeze when both conditions hold at once: heavy prior
   SwiftShader load *and* a long stretch with zero CDP traffic. Headless Chrome's on-demand-BeginFrame
   rendering model appears to deprioritize rAF delivery for a lower-priority canvas under contention
   when nothing is actively requesting frames; a real display's vsync-driven compositor doesn't share
   that starvation mode. Real GPUs don't share software rasterizers' state/resource limits this way, so
   this is expected to render (and animate) normally there; needs the user's own GPU to confirm, same
   as every transmission-based material elsewhere in this project. */

import * as THREE from 'three';

// Same verification escape hatch as ice.js's own FROSTED flag: real-time `transmission` can't be
// rendered by headless/software WebGL (SwiftShader), a limitation hit repeatedly and documented at
// length elsewhere in this project (see portfolio-detail-hero-videos memory) — ?frosted forces an
// opaque fallback so the geometry/animation can actually be verified in that environment.
const FROSTED = new URLSearchParams(location.search).has('frosted') || window.__iceFrosted === true;

const canvas = document.querySelector('.wwd-3d-canvas');

function buildEnv(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const w = 512, h = 256;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#6f93a8'); g.addColorStop(0.5, '#8fb4c4'); g.addColorStop(1, '#2c4656');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  [['#ffffff', 0.22], ['#f2dcae', 0.55], ['#ffffff', 0.82]].forEach(([col, x]) => {
    const gg = ctx.createLinearGradient(0, 0, 0, h);
    gg.addColorStop(0, 'rgba(0,0,0,0)'); gg.addColorStop(0.45, col); gg.addColorStop(0.85, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.65; ctx.fillStyle = gg; ctx.fillRect(x * w - 46, 0, 92, h);
  });
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.SRGBColorSpace;
  return pmrem.fromEquirectangular(tex).texture;
}

let inst = null;
function init() {
  if (inst || !canvas) return;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.environment = buildEnv(renderer);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
  camera.position.set(0, 0, 4.4);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.DirectionalLight(0xeaf4ff, 1.4).translateX(2).translateY(2).translateZ(3));
  scene.add(new THREE.AmbientLight(0x2a3844, 0.9));

  // Low-poly (detail 0) icosahedron — flat, faceted normals read clearly at this tile's small size,
  // the same "cut gem" look established for the detail-slab reference asset, but here generated
  // directly (no GLB needed for a shape this simple).
  const geo = new THREE.IcosahedronGeometry(1.05, 0);
  const material = FROSTED
    ? new THREE.MeshPhysicalMaterial({
        color: 0xd9ecf5, metalness: 0, roughness: 0.25,
        clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 1.05,
        transparent: true, opacity: 0.9,
      })
    : new THREE.MeshPhysicalMaterial({
        color: 0xd9ecf5, metalness: 0, roughness: 0.12,
        transmission: 1.0, thickness: 1.3, ior: 1.32,
        attenuationColor: new THREE.Color(0x5f92ac), attenuationDistance: 1.4,
        clearcoat: 0.5, clearcoatRoughness: 0.2,
        envMapIntensity: 1.05,
      });
  const mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  // A *fake* cursor, not the visitor's real one: an internally-animated point that wanders around
  // on its own (a Lissajous-style path — two out-of-phase sine waves, so it drifts in loops and
  // figure-eights rather than a predictable circle), permanently confined to this tile's own
  // canvas bounds by construction (nx/ny below never leave [-1,1]) — it can't wander onto a
  // neighboring card the way a page-wide real-cursor reading (like the ice cubes/detail-slab tilt
  // use) could. The mesh leans toward this fake point exactly the way it would toward a real one;
  // a real cursor-arrow-shaped DOM element (`cursorEl`, an actual pointer silhouette via clip-path,
  // not just an abstract glowing dot) renders *where* that fake cursor currently is, so the "the
  // mesh is following a cursor" read is unambiguous — it looks like a cursor, not a decoration.
  const cursorEl = document.createElement('span');
  cursorEl.className = 'wwd-fake-cursor';
  cursorEl.setAttribute('aria-hidden', 'true');
  canvas.parentElement.appendChild(cursorEl);

  let mtx = 0, mty = 0, fakeT = Math.random() * 1000;
  function updateFakeCursor(dtMs) {
    fakeT += dtMs * 0.00042;
    const nx = Math.sin(fakeT * 1.3) * Math.cos(fakeT * 0.47);           // wanders within [-1, 1]
    const ny = Math.sin(fakeT * 0.9 + 1.7) * Math.cos(fakeT * 0.31) * 0.9;
    mtx = nx;
    mty = ny;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w && h) {
      cursorEl.style.left = `${(nx * 0.5 + 0.5) * w}px`;
      cursorEl.style.top = `${(ny * 0.5 + 0.5) * h}px`;
    }
  }

  let active = false, raf = 0, lastT = 0;
  // Rotation is now a direct, eased function of the fake cursor's own position — no separate
  // constant auto-spin added on top. The earlier version accumulated a continuous `spin` and only
  // *offset* it by the cursor position, so the cursor's influence was a minor wobble on top of
  // rotation that kept going regardless of where the cursor was — which read as "spinning on its
  // own, vaguely nudged by the cursor," not "following" it. Same lean-toward-cursor eased-target
  // pattern used for the portfolio ice cubes/detail-slab tilt elsewhere in this project (see
  // ice.js's own `mtx`/`mty` + `CURSOR_EASE`), just applied as the mesh's *entire* rotation instead
  // of a small additive lean, so the connection between "cursor moves here" and "mesh turns to face
  // it" is unambiguous. The cursor itself never stops wandering (Lissajous path), so the mesh never
  // reads as static either — same sense of life, now legibly tied to the thing it's supposed to be
  // reacting to.
  let rotX = 0, rotY = 0;
  const FOLLOW_EASE = 0.06;
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  function draw(t) {
    if (!active) return;
    const dt = lastT ? Math.min(64, t - lastT) : 16;
    lastT = t;
    updateFakeCursor(dt);
    rotY += (mtx * 0.9 - rotY) * FOLLOW_EASE;
    rotX += (-mty * 0.7 - rotX) * FOLLOW_EASE;
    mesh.rotation.y = rotY;
    mesh.rotation.x = rotX;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(draw);
  }
  addEventListener('resize', resize);

  inst = {
    start() {
      if (active) return;
      active = true;
      lastT = 0;   // avoids one huge dt jump (fake-cursor teleport) resuming after a pause
      resize();
      if (!raf) raf = requestAnimationFrame(draw);
    },
    stop() {
      active = false;
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

window.__wwd = {
  setActive(on) {
    if (on) { init(); if (inst) inst.start(); }
    else if (inst) { inst.stop(); }
  },
};
