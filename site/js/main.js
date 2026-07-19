/* ============ Seal Point — cinematic scroll engine ============ */
(() => {
  'use strict';
  gsap.registerPlugin(ScrollTrigger);

  const SEQ = window.SEQUENCE;
  const TOTAL = SEQ.clips.reduce((n, c) => n + c.count, 0);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- frame source mapping ---------- */
  const frameSrc = (i) => {
    let rest = i;
    for (const clip of SEQ.clips) {
      if (rest < clip.count) {
        return `${clip.dir}/f_${String(rest + 1).padStart(4, '0')}.${SEQ.ext}`;
      }
      rest -= clip.count;
    }
    return null;
  };

  /* ---------- canvas player ---------- */
  const canvas = document.getElementById('film');
  const ctx = canvas.getContext('2d');
  const frames = new Array(TOTAL).fill(null);   // ImageBitmap | 'missing' | null
  // targetFrame = the raw, instantly-computed ideal frame for the current scroll position (fractional).
  // currentFrame = what's actually drawn — eases toward targetFrame a little every tick instead of
  // jumping straight to it. Same two-value split macoyoshbuilders.com's hero uses (LERP_FACTOR 0.1,
  // snap once within 0.05 of the target): the target itself has zero lag (no smoothed-scroll creep,
  // so it's always exactly where your scroll position says it should be), but the short catch-up lerp
  // means arriving there reads as a brief, natural ease instead of either a mechanical instant cut or
  // the old multi-second drift through frames that only exists because there aren't enough of them.
  let targetFrame = 0;
  let currentFrame = 0;
  const FILM_LERP = 0.1;
  let drawnFrame = -1;
  let criticalReady = false;
  // WWD idle pan (see updateFilmFrame's own comment): the *image itself* physically drifts a few
  // pixels along one axis while paused, not a different mechanism than "which frame is showing" —
  // filmPanPx is a plain pixel offset applied directly to where drawImage places the frame, and
  // filmPanning flags when the small safety overscale below should be active.
  let filmPanPx = 0;
  let filmPanning = false;
  let lastDrawnPan = 0;
  const WWD_IDLE_PAN_OVERSCALE = 1.03;   // tiny extra scale beyond normal "cover" fit, active only while
                                          // panning — guarantees real overflow margin to pan *into* on
                                          // any viewport aspect, including ones that exactly match the
                                          // source frame's own 16:9 (zero natural overflow otherwise,
                                          // which would expose a gap at the panned edge without this)

  function sizeCanvas() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    drawnFrame = -1; // force redraw
  }
  sizeCanvas();
  addEventListener('resize', sizeCanvas);

  function nearestLoaded(i) {
    if (frames[i] && frames[i] !== 'missing') return i;
    for (let d = 1; d < TOTAL; d++) {
      const lo = i - d, hi = i + d;
      if (lo >= 0 && frames[lo] && frames[lo] !== 'missing') return lo;
      if (hi < TOTAL && frames[hi] && frames[hi] !== 'missing') return hi;
    }
    return -1;
  }

  function draw() {
    // Called every tick (not just on scroll) so the WWD idle-pan term inside it keeps animating
    // even while the visitor holds still mid-scroll — see updateFilmFrame's own comment.
    updateFilmFrame();
    const delta = targetFrame - currentFrame;
    if (Math.abs(delta) < 0.05) currentFrame = targetFrame;
    else currentFrame += delta * FILM_LERP;

    const idx = nearestLoaded(Math.round(currentFrame));
    if (idx < 0) return;
    // Skipping the redraw when neither the frame index nor the pan offset changed (the original,
    // pre-pan check) would freeze the pan mid-cycle: currentFrame is genuinely constant throughout
    // the WWD hold now (no more frame-scrubbing — see updateFilmFrame), so `idx` alone no longer
    // changes during that whole window, but filmPanPx still needs a fresh draw every tick to
    // actually move.
    if (idx === drawnFrame && filmPanPx === lastDrawnPan) return;
    const img = frames[idx];
    const cw = canvas.width, ch = canvas.height;
    const scale = Math.max(cw / img.width, ch / img.height) * (filmPanning ? WWD_IDLE_PAN_OVERSCALE : 1);
    const w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, (cw - w) / 2 + filmPanPx, (ch - h) / 2, w, h);
    drawnFrame = idx;
    lastDrawnPan = filmPanPx;
  }
  gsap.ticker.add(draw);

  /* ---------- progressive loading ---------- */
  const loaderEl = document.getElementById('loader');
  const loaderFill = loaderEl.querySelector('.loader-fill');
  const loaderPct = loaderEl.querySelector('.loader-pct');

  // `frames` holds all 282 decoded bitmaps for the page's whole lifetime (never evicted), which at
  // native 1920x1080 is ~2.2GB and was overshooting iOS Safari's per-tab memory ceiling, crashing
  // the tab. Decoding straight to 960x540 on small screens keeps each bitmap's real memory footprint
  // down (~550MB total) without touching source assets or desktop/tablet quality.
  const SMALL_SCREEN_FRAME_OPTS = Math.max(innerWidth, innerHeight) <= 1024
    ? { resizeWidth: SEQ.frameW / 2, resizeHeight: SEQ.frameH / 2, resizeQuality: 'medium' }
    : null;

  // Passes: coarse → fine. Gate the site on the first pass. Mobile stops after a coarser final
  // pass, skipping the two finest ones entirely — this changes which frame indices ever get
  // queued at all, not just their loading order, so the sparser set is genuinely never fetched
  // or held (nearestLoaded() above already falls back to the nearest loaded neighbor for any
  // index that was never queued, so this reads as slightly coarser motion on fast scrubs, never
  // a blank/broken frame). Even at the mobile-resized 960x540 decode size, holding *every* one of
  // the 282 frames forever (~550MB) was still crashing real iOS Safari on multiple physical
  // devices, immediately on load with zero scrolling — the loader has no cap and just keeps
  // fetching until all TOTAL frames are held, regardless of device. This cuts what's ever held on
  // mobile to roughly a quarter of the frames (~140MB), the next lever available short of
  // abandoning the "everything already loaded, nothing re-fetched mid-scrub" architecture.
  const passes = SMALL_SCREEN_FRAME_OPTS ? [8, 4] : [8, 4, 2, 1];
  const loadOrder = [];
  const seen = new Set();
  for (const stride of passes) {
    for (let i = 0; i < TOTAL; i += stride) {
      if (!seen.has(i)) { seen.add(i); loadOrder.push(i); }
    }
  }
  const CRITICAL = Math.ceil(TOTAL / passes[0]);
  let loadedCount = 0;

  async function loadFrame(i) {
    try {
      const res = await fetch(frameSrc(i));
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      frames[i] = SMALL_SCREEN_FRAME_OPTS
        ? await createImageBitmap(blob, SMALL_SCREEN_FRAME_OPTS)
        : await createImageBitmap(blob);
    } catch {
      frames[i] = 'missing';
    }
    loadedCount++;
    if (!criticalReady) {
      const pct = Math.min(100, Math.round((loadedCount / CRITICAL) * 100));
      loaderFill.style.width = pct + '%';
      loaderPct.textContent = pct + '%';
      if (loadedCount >= CRITICAL) criticalReady = true;
    }
  }

  async function runLoader(concurrency = 6) {
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (cursor < loadOrder.length) {
        const i = loadOrder[cursor++];
        await loadFrame(i);
      }
    });
    await Promise.all(workers);
  }

  /* ---------- kinetic type ---------- */
  function splitKinetic(el, text) {
    const source = text ?? el.textContent;
    el.textContent = '';
    const words = source.split(' ');
    words.forEach((word, wi) => {
      const w = document.createElement('span');
      w.className = 'kword';
      for (const ch of word) {
        const c = document.createElement('span');
        c.className = 'kchar';
        c.textContent = ch;
        w.appendChild(c);
      }
      el.appendChild(w);
      if (wi < words.length - 1) el.appendChild(document.createTextNode(' '));
    });
    return el.querySelectorAll('.kchar');
  }

  const heroChars = splitKinetic(document.querySelector('.hero-letters'), 'SEAL POINT');
  const headPortfolio = splitKinetic(document.querySelector('.pf-title'));
  const headWhatWeDo = splitKinetic(document.querySelector('#what-we-do .section-head'));
  const finaleChars = splitKinetic(document.querySelector('.finale-title'));

  /* ---------- portfolio — 3D ice blocks (scroll-driven; one project at a time) ---------- */
  const projects = [
    { name: 'Macoyosh Builders', pitch: 'Custom homes, built digital.', detailId: 'detail-builders', kind: 'Residential', date: '06.28.2024' },
    { name: 'Macoyosh Drafting', pitch: 'Blueprints meet clean design.', detailId: 'detail-drafting', kind: 'Drafting', date: '09.14.2024' },
    { name: 'Corshelle Realty', pitch: 'Listings that sell themselves.', detailId: 'detail-realty', kind: 'Real Estate', date: '02.03.2025' },
  ];
  const pfDots = [...document.querySelectorAll('.pf-dot')];
  const pfCardCount = projects.length;
  const cardProxy = { i: -0.5 };     // fractional project index; starts at -0.5 → chunk 0 half-hidden at the right edge

  const capTag = document.querySelector('.pf-cap-tag');
  const capTitle = document.querySelector('.pf-cap-title');
  const capPitch = document.querySelector('.pf-cap-pitch');
  const captionEl = document.querySelector('.pf-caption');
  const hudEl = document.querySelector('.pf-hud');
  const hudCode = document.querySelector('.pf-hud-code');
  const hudKind = document.querySelector('.pf-hud-kind');
  const hudDate = document.querySelector('.pf-hud-date');
  const hudExplore = document.querySelector('.pf-hud-explore');
  let captionIndex = -1;
  function setCaption(i) {
    if (i === captionIndex || !projects[i]) return;
    captionIndex = i;
    const p = projects[i];
    if (capTag) capTag.textContent = '0' + (i + 1);
    if (capTitle) capTitle.textContent = p.name;
    if (capPitch) capPitch.textContent = p.pitch;
    if (hudCode) hudCode.textContent = 'CO_0' + (i + 1);
    if (hudKind) hudKind.textContent = p.kind || '';
    if (hudDate) hudDate.textContent = p.date || '';
  }

  // caption fade+rise together (op drives both opacity and a subtle upward settle, so the
  // name reads as arriving rather than just appearing/disappearing — the section's one title
  // moment, now that it isn't duplicated by a second title over the ice)
  function renderCards() {
    if (window.__ice) window.__ice.setProgress(cardProxy.i);
    const nearest = Math.round(cardProxy.i);
    const frac = Math.abs(cardProxy.i - nearest);
    const op = Math.max(0, 1 - frac * 3.2);
    if (captionEl) { captionEl.style.opacity = op.toFixed(3); captionEl.style.transform = `translateY(${((1 - op) * 14).toFixed(2)}px)`; }
    if (hudEl) hudEl.style.opacity = op.toFixed(3);
    setCaption(nearest);
    pfDots.forEach((d, k) => d.classList.toggle('is-active', k === nearest));
  }
  addEventListener('resize', renderCards);

  // CLICK TO EXPLORE → open the centred project's detail
  if (hudExplore) hudExplore.addEventListener('click', () => {
    const p = projects[Math.round(cardProxy.i)];
    if (p) openDetail(p.detailId);
  });

  /* ---------- project detail overlays ---------- */
  // The header video + gallery photos are rendered as real 3D ice slabs (site/js/ice.js,
  // window.__iceFrame) — hero videos only start loading/playing once their own overlay opens
  // (no autoplay attribute in the markup, and ice.js only starts each canvas's render loop
  // once its panel is active) since all 3 detail panels sit in the DOM at once; an autoplaying
  // video in each would mean all 3 clips fetch/decode/render in the background from page load,
  // even for the two the visitor never opens.
  // Project-detail backdrop (.pf-detail-atmos) is pure CSS now — no JS load/activate step needed.

  // Scroll-driven content reveal, macoyoshbuilders.com-style: everything below the immediately-
  // visible kicker/title/lede fades+rises in as it's actually scrolled into view within the panel's
  // own .pf-detail-scroll, instead of all being present the instant the panel opens. Built fresh on
  // every openDetail() call (via gsap.context(), reverted on close) rather than once at boot —
  // panels stay in the DOM across multiple open/close cycles, and a persistent ScrollTrigger would
  // either need complex replay bookkeeping or risk showing already-revealed content on a second open
  // (e.g. if the visitor scrolled all the way down, then closed without scrolling back up). Rebuilding
  // it each time guarantees every open starts from a genuinely hidden state.
  const detailRevealCtx = new Map();   // panel id -> gsap.Context, so closeDetail can revert it
  function setupDetailReveal(panel, sc) {
    const ctx = gsap.context(() => {
      // Immediately-visible header block (no scroll needed to see it) — a simple staggered
      // entrance on open, not scroll-triggered.
      const headerBits = [panel.querySelector('.pf-detail-kicker'), panel.querySelector('.pf-detail-title'), panel.querySelector('.pf-detail-lede')].filter(Boolean);
      gsap.fromTo(headerBits, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .7, ease: 'power2.out', stagger: .08, delay: .05 });

      // Everything else scroll-reveals as it enters the panel's own scroll viewport.
      const revealTargets = [
        panel.querySelector('.pf-detail-hero'),
        panel.querySelector('.pf-detail-meta'),
        panel.querySelector('.pf-detail-copy'),
        ...panel.querySelectorAll('.pf-detail-shot'),
        panel.querySelector('.pf-detail-quote'),
        panel.querySelector('.pf-detail-inner > .btn.btn-solid'),
      ].filter(Boolean);
      revealTargets.forEach((el) => {
        gsap.fromTo(el, { opacity: 0, y: 36 }, {
          opacity: 1, y: 0, duration: .8, ease: 'power2.out',
          scrollTrigger: {
            trigger: el,
            scroller: sc,
            start: 'top 88%',
            toggleActions: 'play none none none',   // stays revealed once shown — no re-hiding on scroll-back within the same open
          },
        });
      });
    }, panel);
    detailRevealCtx.set(panel.id, ctx);
  }

  const openDetail = (id) => {
    const panel = document.getElementById(id);
    if (!panel) return;
    const sc = panel.querySelector('.pf-detail-scroll');
    if (sc) sc.scrollTop = 0;
    const oldCtx = detailRevealCtx.get(id);
    if (oldCtx) oldCtx.revert();
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    if (window.__iceFrame) window.__iceFrame.activatePanel(id);
    lenis.stop();                                  // freeze the background scroll
    if (sc) setupDetailReveal(panel, sc);
    requestAnimationFrame(() => ScrollTrigger.refresh());   // panel just became visible (visibility:hidden -> visible) — recalc trigger positions against real, now-laid-out geometry
  };
  // Ice-cube click → brief "swoop into the ice" transition (ice.js drives the actual camera
  // move; this just handles the page-side half: freeze scroll immediately so the block can't
  // drift mid-swoop, and fade the caption/HUD text out of the way first). Reused CSS
  // transitions (.pf-caption/.pf-hud already have their own `transition: opacity`) do the
  // actual fade — see main.css.
  let zoomOpening = false;
  function beginZoomOpen() {
    if (zoomOpening) return false;
    zoomOpening = true;
    lenis.stop();
    if (captionEl) captionEl.style.opacity = '0';
    if (hudEl) hudEl.style.opacity = '0';
    return true;
  }
  const closeDetail = () => {
    let any = false;
    document.querySelectorAll('.pf-detail.is-open').forEach(p => {
      p.classList.remove('is-open');
      p.setAttribute('aria-hidden', 'true');
      if (window.__iceFrame) window.__iceFrame.deactivatePanel(p.id);
      const ctx = detailRevealCtx.get(p.id);
      if (ctx) { ctx.revert(); detailRevealCtx.delete(p.id); }
      any = true;
    });
    if (any) {
      lenis.start();
      zoomOpening = false;
      if (window.__ice && window.__ice.resetZoom) window.__ice.resetZoom();
      renderCards();   // re-sync caption/HUD opacity to the current card position instead of leaving them forced to 0
    }
  };
  function initDetails() {
    document.querySelectorAll('.pf-detail-close').forEach(b => b.addEventListener('click', closeDetail));
    // .pf-detail-explore is a plain external <a> now (per-project real site URL, same as the "Visit
    // site" button below it) — no JS needed, the browser handles it natively. Previously scrolled to
    // .pf-detail-cols instead; that wiring is gone along with the <button> markup it applied to.
    addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
    const capLink = document.querySelector('.pf-cap-link');
    if (capLink) capLink.addEventListener('click', () => {
      const p = projects[captionIndex]; if (p) openDetail(p.detailId);
    });
  }

  /* ---------- smooth scroll ---------- */
  const lenis = new Lenis({
    lerp: reduceMotion ? 1 : 0.065,      // lower = airier, smoother glide (sliding-on-ice feel)
    smoothWheel: !reduceMotion,
  });
  lenis.on('scroll', () => { ScrollTrigger.update(); updateFilmFrame(); });
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  lenis.stop(); // locked until loaded

  /* ---------- master scrub timeline ---------- */
  // The portfolio section slides up with a diagonal edge WHILE clip 1 is still
  // playing, and clip 1 hits its last frame (79) exactly when the section fully
  // covers the screen — so the clip appears to roll straight into the section.
  const CLIP1_END = 79;                    // last frame of clip 1
  const RISE_START = 310;                  // section starts rising (after the crystal has formed on-screen)
  const COVER_FULL = 340;                  // section fully covers → film reaches frame 79 here
  const CARD_START = 364, CARD_STEP = 156, EXIT_LEAD = 126, EXIT_DUR = 50;   // CARD_START = chunk 0 centred; EXIT_LEAD = time for the last chunk to tumble off-left before exit — shortened 1/4 from the 4x-doubled 208/168
  const cardsEndU = CARD_START + Math.max(0, pfCardCount - 1) * CARD_STEP;  // last chunk centred here
  const EXIT_START = cardsEndU + EXIT_LEAD;    // last chunk has tumbled off-left; section slides away & clip 2 resumes here
  const SHIFT = EXIT_START - 281;          // clips 2-3 (and downstream sections) shift by this much
  const U = 1035 + SHIFT;                  // total timeline length in abstract units — grown from 925 to fit the WHAT WE DO section's new heading->lede->card-reveal pacing (see that block below for the new numbering)
  { const t = document.getElementById('track'); if (t) t.style.height = Math.round(U * 1.3) + 'vh'; }
  // REAL_U: placeholder until the full timeline is actually built (assigned tl.totalDuration() right
  // after the FINALE block below) — see frameForU's own comment for why this needs to be GSAP's real
  // total, not the hand-computed U estimate above.
  let REAL_U = U;

  const panels = {
    hero: document.getElementById('hero'),
    portfolio: document.getElementById('portfolio'),
    whatWeDo: document.getElementById('what-we-do'),
    finale: document.getElementById('finale'),
  };
  // pointer-events windows (unit ranges)
  const liveWindows = [
    { el: panels.portfolio, a: 308, b: EXIT_START },
    { el: panels.finale, a: 890 + SHIFT, b: U },
  ];

  // Ice scene (three.js) and aurora background (ogl) are lazy-loaded as the portfolio
  // section approaches, and only render while the section is on-screen (RISE_START → after the exit).
  const ICE_A = RISE_START - 6, ICE_B = EXIT_START + EXIT_DUR + 6;
  let iceLoaded = false, iceActive = false;
  let auroraLoaded = false;
  // "What we do"'s Dimension tile (site/js/wwd.js, a small three.js canvas) — same lazy-load +
  // on-screen-only gating discipline as ice/aurora above, just windowed to this section's own
  // visible range (465+SHIFT..875+SHIFT, matching the show()/hide() calls below) instead of the
  // portfolio's.
  const WWD_A = 465 + SHIFT - 6, WWD_B = 875 + SHIFT + 6;
  let wwdLoaded = false, wwdActive = false;

  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: '#track',
      start: 'top top',
      end: 'bottom bottom',
      scrub: true,
      onUpdate(self) {
        const u = self.progress * U;
        for (const w of liveWindows) {
          w.el.classList.toggle('is-live', u >= w.a && u <= w.b);
        }
        if (!iceLoaded && u > RISE_START - 150) {
          iceLoaded = true;
          import(new URL('js/ice.js', document.baseURI).href)
            .then(() => { if (window.__ice) { window.__ice.setActive(iceActive); window.__ice.setProgress(cardProxy.i); } })
            .catch((err) => console.error('ice load failed', err));
        }
        if (!auroraLoaded && u > RISE_START - 150) {
          auroraLoaded = true;
          import(new URL('js/aurora.js', document.baseURI).href)
            .then(() => { if (window.__auroraBg) window.__auroraBg.setActive(iceActive); })
            .catch((err) => console.error('aurora load failed', err));
        }
        const on = u >= ICE_A && u <= ICE_B;
        if (on !== iceActive) {
          iceActive = on;
          if (window.__ice) window.__ice.setActive(on);
          if (window.__auroraBg) window.__auroraBg.setActive(on);
        }
        if (!wwdLoaded && u > WWD_A - 150) {
          wwdLoaded = true;
          import(new URL('js/wwd.js', document.baseURI).href)
            .then(() => { if (window.__wwd) window.__wwd.setActive(wwdActive); })
            .catch((err) => console.error('wwd load failed', err));
        }
        const wwdOn = u >= WWD_A && u <= WWD_B;
        if (wwdOn !== wwdActive) {
          wwdActive = wwdOn;
          if (window.__wwd) window.__wwd.setActive(wwdOn);
        }
      },
    },
  });

  // Clip 1 keeps playing until the section fully covers it (frame 79 at COVER_FULL),
  // stays frozen on 79 while the carousel plays, then clips 2-3 resume as the
  // section slides away — and freeze a *second* time while the What We Do cards are on
  // screen (WWD_FREEZE_START..WWD_FREEZE_END, matching that section's own card-reveal window
  // below), per explicit request: the first card should only start appearing once the clip
  // reaches that point, hold there while all 4 cards are presented, then resume playing
  // normally as the cards exit.
  //
  // targetFrame is computed directly from lenis's raw `targetScroll` (not the smoothed
  // `scroll`/ScrollTrigger progress everything else on the page uses) — with only 80-97
  // frames per clip, riding lenis's lerp glide made the footage visibly creep/judder
  // through extra frames after you stopped scrolling instead of stopping cleanly. But
  // jumping `currentFrame` straight to that raw target every tick (no easing at all)
  // read as too mechanical/abrupt. draw()'s own short frame-index lerp (FILM_LERP)
  // smooths the last stretch of the *catch-up*, not the scroll position — same split
  // macoyoshbuilders.com's hero uses (targetFrame from raw scroll progress + LERP_FACTOR
  // easing `currentFrame` toward it every RAF tick, snapping once within 0.05).
  // Declared here (not down in the WHAT WE DO block below, where the per-card GSAP tweens also
  // read them) specifically so frameForU/effectiveU can reference them without any risk of a
  // temporal-dead-zone ordering issue — this file runs top-to-bottom synchronously and scroll
  // events can't fire until boot() finishes and lenis.start() runs, but keeping the single source
  // of truth *before* its first use here is simpler to reason about than relying on that.
  const WWD_CARD_START = 610, WWD_CARD_STEP = 55, WWD_CARD_DUR = 46;
  const WWD_FREEZE_START = WWD_CARD_START + SHIFT;                              // first card starts exactly here — clip holds the instant it arrives
  // Was WWD_CARD_START+3*WWD_CARD_STEP+WWD_CARD_DUR (the 4th card's own nominal landing point,
  // 821+SHIFT) — moved to 875+SHIFT (matching `hide(panels.whatWeDo, ...)` down in the WHAT WE DO
  // block below — hardcoded here rather than referencing that call directly since this runs before
  // it's declared, kept in sync by hand) per explicit feedback that the clip was still visibly
  // resuming while a card was mid-entrance ("prematurely, around the third card"). The 4th card's own
  // *nominal* end unit is exactly when its entrance tween finishes, but a `power3.out` ease reads as
  // visually "still finishing" for a little past its nominal end (approaches 1 asymptotically near
  // the tail), and pushing the freeze-end there also left the entire ~40-unit exit fade playing out
  // *while the clip was already moving again*. Now holds all the way through the exit fade too, so
  // the clip only starts again once every card has genuinely, fully disappeared (`hide()`'s own
  // visibility:hidden point), not merely "finished landing."
  const WWD_FREEZE_END = 875 + SHIFT;
  // WWD_FREEZE_FRAME pins the pause to one *exact*, deliberately-chosen frame — clip2's f_0080.webp
  // (absolute combined-sequence index: clip1's 80 frames [0-79] + trans's 8 [80-87] + 79 more into
  // clip2 = 167), the specific diamond-burst/coin/circuit-line composition the user pointed at
  // directly, not whatever frame the general clip2/3 ramp naturally happens to land on.
  //
  // The previous version (a single continuous linear ramp across the *entire* post-EXIT_START range,
  // with the freeze span collapsed out of it via effectiveU) had a real bug that only showed up once
  // WWD's own window was pushed later in `u` this session (WWD_CARD_START 500->610, U 925->1035):
  // that single ramp covers trans+clip2+clip3 *together* (frames 79->281 across the whole EXIT_START
  // ->U span), so pushing the freeze point later in u-space pushed the corresponding frame later too
  // — far enough, in fact, that it landed at frame ~201, which is inside *clip3's* range (185-281,
  // the Finale's own "seal stamp" footage), not clip2 at all. The section was visually showing Finale
  // footage during What We Do without anyone intending that.
  //
  // Fixed by switching to 3 explicit piecewise-linear segments instead of one ramp with a span
  // collapsed out of it — this guarantees the frozen frame is always exactly WWD_FREEZE_FRAME,
  // completely independent of wherever WWD_FREEZE_START/END happen to fall in u-space:
  //   1. EXIT_START -> WWD_FREEZE_START: ramps CLIP1_END -> WWD_FREEZE_FRAME (still covers trans +
  //      the first part of clip2, just compressed to end exactly on the target frame)
  //   2. WWD_FREEZE_START -> WWD_FREEZE_END: holds at WWD_FREEZE_FRAME (the actual pause)
  //   3. WWD_FREEZE_END -> U: ramps WWD_FREEZE_FRAME -> TOTAL-1 (the rest of clip2 + all of clip3,
  //      i.e. the Finale's own footage plays out fully after this section is done)
  const WWD_FREEZE_FRAME = 167;
  // REAL_U (not the hand-computed U) is the actual end of the frame ramp. U itself is deliberately
  // an *over*-estimate of the timeline's real content (it sizes #track's scroll height before `tl`
  // exists, and its own comment already notes a "76-unit tail runway" beyond the last real tween —
  // buffer space with nothing scheduled in it). GSAP's own `tl.totalDuration()` is only knowable
  // once every tween has actually been added to the timeline, well after this function is defined —
  // REAL_U starts as a placeholder (assigned the real value once the full timeline is built, see
  // right after the FINALE block below) rather than assumed equal to U. This isn't just cosmetic:
  // `updateFilmFrame` converts a real scroll fraction (`raw`, 0-1) into this function's "u" via
  // `raw * REAL_U` — if that scale doesn't match what ScrollTrigger itself uses internally to drive
  // `tl` (which is exactly `tl.totalDuration()`, since `scrub:true` maps scroll progress directly
  // onto the timeline's own 0..totalDuration() range), every position comparison in this function
  // runs systematically *ahead* of where the real tweens (card entrances, the WWD exit fade,
  // `hide()`) actually are at a given scroll position — a drift that grows with scroll progress
  // (proportional to `progress * (U - tl.totalDuration())`) and was large enough this session to
  // release the WWD film freeze while the section was still visibly fading out, not yet gone.
  function frameForU(u) {
    if (u <= 0) return 0;
    if (u < COVER_FULL) return (u / COVER_FULL) * CLIP1_END;
    if (u < EXIT_START) return CLIP1_END;
    if (u >= REAL_U) return TOTAL - 1;
    if (u < WWD_FREEZE_START) {
      return CLIP1_END + ((u - EXIT_START) / (WWD_FREEZE_START - EXIT_START)) * (WWD_FREEZE_FRAME - CLIP1_END);
    }
    if (u < WWD_FREEZE_END) return WWD_FREEZE_FRAME;
    return WWD_FREEZE_FRAME + ((u - WWD_FREEZE_END) / (REAL_U - WWD_FREEZE_END)) * (TOTAL - 1 - WWD_FREEZE_FRAME);
  }
  // Idle pan while the clip is frozen (WWD_FREEZE_START..WWD_FREEZE_END): the still frame itself
  // physically drifts a few pixels along one axis — a real image pan, not a different mechanism than
  // "hold on frame 167." An earlier version of this nudged the *frame index* a couple frames either
  // side instead (misreading "idly move slightly" as "scrub nearby frames") — that's a different,
  // wrong effect: it visibly cycles through *different source images*, not one image drifting. Fixed
  // by leaving `frameForU`'s frame choice completely untouched during the hold (still pinned at
  // exactly WWD_FREEZE_FRAME, no oscillation) and instead panning the *drawImage position* in draw()
  // via `filmPanPx` — same physical picture the whole time, just not glued to one exact pixel
  // position. Deliberately time-based (`performance.now()`), not scroll-based — the whole point of a
  // "pause" is that it should keep breathing even while the visitor isn't scrolling at all, which a
  // scroll-driven value never could. `updateFilmFrame` is called every tick from draw() (not just on
  // lenis scroll events) specifically so this keeps animating during an idle hold, not just at the
  // instant scroll last moved.
  const WWD_IDLE_PAN_PX = 16;        // how far the image drifts, in canvas pixels, either direction
  const WWD_IDLE_PAN_PERIOD_MS = 9000;  // one full back-and-forth cycle — slow and lazy, not jittery
  function updateFilmFrame() {
    const st = tl.scrollTrigger;
    if (!st || st.end === st.start) return;
    const raw = Math.max(0, Math.min(1, (lenis.targetScroll - st.start) / (st.end - st.start)));
    const u = raw * REAL_U;
    targetFrame = frameForU(u);
    filmPanning = u >= WWD_FREEZE_START && u < WWD_FREEZE_END;
    filmPanPx = filmPanning ? Math.sin((performance.now() / WWD_IDLE_PAN_PERIOD_MS) * Math.PI * 2) * WWD_IDLE_PAN_PX : 0;
  }

  const show = (el, at) => tl.set(el, { visibility: 'visible' }, at);
  const hide = (el, at) => tl.set(el, { visibility: 'hidden' }, at);

  /* HERO — 0 → 290 */
  show(panels.hero, 0);
  tl.set(panels.hero, { opacity: 1 }, 0);
  tl.from(heroChars, {
    opacity: 0, x: 90, filter: 'blur(6px)',
    duration: 90, stagger: { each: 11 }, ease: 'power2.out',
  }, 15);
  tl.from('.hero-sub', { opacity: 0, y: 26, duration: 50, ease: 'power1.out' }, 150);
  tl.to('.hero-scrollcue', { opacity: 0, duration: 30 }, 60);
  tl.to(panels.hero, { opacity: 0, y: -60, duration: 28, ease: 'power2.out' }, 235);
  hide(panels.hero, 265);

  /* PORTFOLIO — a solid, diagonal-edged section that slides UP while clip 1 is
     still rolling above it, fully covering the frame exactly as clip 1 ends
     (COVER_FULL). It then pins while the "What we do" cards advance one at a
     time, and finally slides up and away as clips 2-3 roll in underneath. */
  show(panels.portfolio, RISE_START);
  tl.set(panels.portfolio, { opacity: 1 }, RISE_START);
  tl.set('.portfolio-box', { yPercent: 85 }, RISE_START);   // parked fully below the fold (tall box)
  tl.to('.portfolio-box', { yPercent: 0, ease: 'none', duration: COVER_FULL - RISE_START }, RISE_START);   // rises with scroll, covering clip 1 as it plays
  // "What we've made" kinetic-types in like every other section head — it used to just be
  // permanently visible with no entrance at all
  tl.from(headPortfolio, {
    yPercent: 110, opacity: 0, duration: 34, stagger: { each: 2 }, ease: 'power3.out',
  }, RISE_START + 8);
  // chunk 0 starts rolling in from the right edge as soon as the section is visible (during the rise)
  // all cardProxy tweens are linear ('none') so the ice moves at one constant speed while scrolling —
  // the only place it eases is the idle auto-recentre below, which is deliberately non-linear
  tl.fromTo(cardProxy, { i: -0.5 }, { i: 0, ease: 'none', duration: CARD_START - RISE_START, onUpdate: renderCards }, RISE_START);
  // scroll advances the carousel one project at a time; each chunk tumbles the full width
  for (let i = 0; i < pfCardCount - 1; i++) {
    tl.to(cardProxy, { i: i + 1, duration: CARD_STEP, ease: 'none', onUpdate: renderCards }, CARD_START + i * CARD_STEP);
  }
  // the last chunk keeps tumbling all the way off the left edge before the section slides away
  tl.to(cardProxy, { i: pfCardCount - 1 + 0.65, duration: EXIT_LEAD, ease: 'none', onUpdate: renderCards }, cardsEndU);
  tl.to('.portfolio-box', { yPercent: -85, ease: 'none', duration: EXIT_DUR }, EXIT_START);   // slides up and away, revealing clip 2 diagonally
  hide(panels.portfolio, EXIT_START + EXIT_DUR + 2);

  // "What we do" cards: each tile flies in from a different direction/angle rather than a shared
  // gentle fade+rise — a deliberately more dramatic entrance per the redesign. Values are per-card
  // (not a single shared offset) so the four don't all read as the same motion repeated 4 times.
  const wwdCardSelectors = ['#wwd-design', '#wwd-development', '#wwd-motion', '#wwd-dimension'];
  const wwdCardFrom = [
    { x: -560, y: 60, rotation: -22, scale: .68 },   // Design — thrown in from the left
    { x: 560, y: -60, rotation: 22, scale: .68 },    // Development — thrown in from the right
    { x: 0, y: 320, rotation: 12, scale: .6 },       // Motion — launches up from below
    { x: 0, y: -320, rotation: -12, scale: .6 },     // Dimension — drops in from above
  ];
  // (WWD_CARD_START/STEP/DUR declared earlier, alongside WWD_FREEZE_START/END — frameForU needs
  // them too, see that block above.)

  /* WHAT WE DO — over clip 2 (base positions shifted by the portfolio hold). Widened again this
     round (465→875+SHIFT, 410 units, up from 300) to fit a real paced intro instead of the cards
     starting almost immediately: heading lands and fully settles, a genuine pause, *then* the lede
     fades in, a second pause, and only then does the film hit WWD_FREEZE_START and the first card
     begins — matching "wait a little bit" + "cards should ONLY start appearing when we get to this
     part of the clip." The clip is genuinely paused (not just visually static — frameForU/effectiveU
     above hold the actual film frame) for the entire WWD_FREEZE_START..WWD_FREEZE_END span, i.e.
     exactly while all 4 cards are being presented, and is already moving again by the time the exit
     fade below starts, so it visibly resumes "while the cards disappear," not after. */
  show(panels.whatWeDo, 465 + SHIFT);
  tl.set(panels.whatWeDo, { opacity: 1, y: 0 }, 465 + SHIFT);
  tl.from(headWhatWeDo, {
    yPercent: 110, opacity: 0, duration: 34, stagger: { each: 2 }, ease: 'power3.out',
  }, 470 + SHIFT);
  // Heading (9 real chars in "WHAT WE DO") finishes its own stagger+duration around 470+8*2+34=520
  // — lede now waits until 560 (a real ~40-unit dead pause after the heading actually lands, not
  // the ~22-unit overlap it had before) so the two reveals read as sequential, not simultaneous.
  //
  // Animates maxHeight/marginTop alongside opacity (not just opacity+y like a normal reveal) — per
  // explicit request, the shared `.wwd-header` box should start sized to fit *only* the title, then
  // visibly grow to also fit the lede once it's due, not just fade the lede in within a box that's
  // already full-sized the whole time. `.wwd-header` itself has no fixed height (see its own CSS
  // comment) — it's pure content-flow height, so as the lede's own max-height grows here, the box
  // grows with it automatically, no separate box-height tween needed. maxHeight's target (200) is
  // deliberately larger than the lede's real content height (~120px at typical widths) — max-height
  // only *caps* growth, so the box settles at the lede's actual natural height once that's reached,
  // not literally at 200px; this avoids having to hand-measure exact pixel heights per viewport.
  tl.fromTo('.wwd-lede',
    { opacity: 0, maxHeight: 0, marginTop: 0 },
    { opacity: 1, maxHeight: 200, marginTop: 18, duration: 30, ease: 'power1.out' },
    560 + SHIFT);
  wwdCardSelectors.forEach((sel, i) => {
    const at = WWD_CARD_START + SHIFT + i * WWD_CARD_STEP;
    tl.fromTo(sel,
      { opacity: 0, ...wwdCardFrom[i] },
      { opacity: 1, x: 0, y: 0, rotation: 0, scale: 1, duration: WWD_CARD_DUR, ease: 'power3.out' },
      at);
  });
  tl.to(panels.whatWeDo, { opacity: 0, y: -50, duration: 36, ease: 'power1.in' }, 835 + SHIFT);
  hide(panels.whatWeDo, 875 + SHIFT);

  /* FINALE — over clip 3, timed to the seal stamp. Re-based from 780+SHIFT to 890+SHIFT to follow
     WHAT WE DO's widened window — same *relative* internal offsets from its own show time as before
     (chars +13, ctas +69), unchanged. */
  show(panels.finale, 890 + SHIFT);
  tl.set(panels.finale, { opacity: 1 }, 890 + SHIFT);
  tl.from(finaleChars, {
    yPercent: 118, opacity: 0, duration: 48, stagger: { each: 2.2 }, ease: 'power3.out',
  }, 903 + SHIFT);
  tl.from('.finale-ctas', { opacity: 0, y: 34, duration: 40, ease: 'power2.out' }, 959 + SHIFT);

  // Every tween that will ever be added to `tl` has been added by this point — safe to read its
  // real total now. See REAL_U's own declaration/frameForU's comment for why this matters.
  REAL_U = tl.totalDuration();

  /* ---------- seal scroll progress (whole page) ---------- */
  const sealClip = document.querySelector('.seal-fill-clip');
  const sealBox = document.getElementById('seal-progress');
  ScrollTrigger.create({
    start: 0,
    end: () => document.documentElement.scrollHeight - innerHeight,
    onUpdate(self) {
      sealClip.style.clipPath = `inset(${(1 - self.progress) * 100}% 0 0 0)`;
      const stamped = self.progress >= 0.995;
      if (stamped && !sealBox.classList.contains('stamped')) sealBox.classList.add('stamped');
      if (!stamped) sealBox.classList.remove('stamped');
    },
  });

  /* ---------- auto-recentre the ice after you stop scrolling off-centre ---------- */
  // If you stop while a chunk is off to one side (between projects), slide the nearest
  // one back to the middle after a beat of inactivity.
  let recenterTimer = 0;
  function scheduleRecenter() {
    clearTimeout(recenterTimer);
    if (reduceMotion) return;
    recenterTimer = setTimeout(() => {
      const st = tl.scrollTrigger; if (!st) return;
      const u = st.progress * U;
      // Same class of bug as the EXIT_START fix above, but on the entry side: chunk 0 can be pulled
      // off-centre to the right by scrolling back up into the entrance zone (its entrance tween runs
      // from RISE_START, not CARD_START), and stopping there should still recentre it. Using
      // CARD_START here excluded that whole zone, which is why recentring only ever worked once
      // you'd fully arrived in the carousel proper.
      if (u < RISE_START || u > EXIT_START) return;
      const nearest = Math.min(pfCardCount - 1, Math.max(0, Math.round(cardProxy.i)));
      if (Math.abs(cardProxy.i - nearest) < 0.04) return;            // already centred
      // Extrapolate the target from the CURRENT known (u, cardProxy.i) pair rather than an
      // absolute `CARD_START + nearest*CARD_STEP` formula — headless testing found the scrub
      // timeline has a small persistent offset between assumed and actual cardProxy.i near a
      // tween boundary (u=364 measured at cardProxy.i=-0.08, not the assumed 0), which was
      // exactly large enough to make the entrance-zone case above land short of centre. Using
      // the current position as the anchor point sidesteps needing to know why that offset
      // exists — it only needs the LOCAL rate (u-per-i) for whichever zone we're currently in.
      const rate = u < CARD_START ? (CARD_START - RISE_START) / 0.5
        : u < cardsEndU ? CARD_STEP
        : EXIT_LEAD / 0.65;
      const targetU = u + (nearest - cardProxy.i) * rate;
      const y = st.start + (st.end - st.start) * (targetU / U);
      // slow start that snaps fast at the end — reads as being physically pulled back, not eased
      lenis.scrollTo(y, { duration: 1.1, easing: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * (t - 1))) });
    }, 1500);
  }
  // Bound to raw input, not lenis's 'scroll' event — lenis keeps emitting scroll updates for a
  // long decaying tail after you actually stop touching the wheel (its smoothing never truly
  // idles), which was resetting this timer indefinitely and made the recenter effectively never fire.
  addEventListener('wheel', scheduleRecenter, { passive: true });
  addEventListener('touchmove', scheduleRecenter, { passive: true });

  /* ---------- "See our work" → scroll back to the portfolio section ---------- */
  // Used to target 690+SHIFT, a unit offset inside the old (now-removed) Work section; the
  // portfolio ("What we've made") gallery is this site's remaining "our work" destination, and
  // CARD_START is where its first project is already centred and interactive, not mid-rise.
  document.getElementById('see-work').addEventListener('click', (e) => {
    e.preventDefault();
    const st = tl.scrollTrigger;
    const y = st.start + (st.end - st.start) * (CARD_START / U);
    lenis.scrollTo(y, { duration: 1.6 });
  });

  /* ---------- boot ---------- */
  async function boot() {
    const loading = runLoader();
    const gate = new Promise((resolve) => {
      const check = setInterval(() => {
        if (criticalReady) { clearInterval(check); resolve(); }
      }, 60);
    });
    await Promise.all([gate, document.fonts.ready]);
    renderCards();
    initDetails();
    draw();
    loaderEl.classList.add('done');
    lenis.start();
    ScrollTrigger.refresh();
    updateFilmFrame(); // correct the frame if the browser restored a non-zero scroll position
    await loading; // keep filling in fine frames in the background
  }
  boot();

  // test/debug handle + hooks for the ice module
  window.__sp = {
    lenis, tl, projects, openDetail, beginZoomOpen,
    get cardProgress() { return cardProxy.i; },
    get targetFrame() { return targetFrame; },
    get drawnFrame() { return drawnFrame; },
    get loadedCount() { return loadedCount; },
    get total() { return TOTAL; },
    get ready() { return criticalReady; },
    get u() { const st = tl.scrollTrigger; return st ? st.progress * U : null; },
    get U() { return U; },
    get WWD_FREEZE_START() { return WWD_FREEZE_START; },
    get WWD_FREEZE_END() { return WWD_FREEZE_END; },
    get filmPanPx() { return filmPanPx; },
    get filmPanning() { return filmPanning; },
  };
})();
