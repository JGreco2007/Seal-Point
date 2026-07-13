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
  let targetFrame = 0;
  let drawnFrame = -1;
  let criticalReady = false;

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
    const idx = nearestLoaded(targetFrame);
    if (idx < 0 || idx === drawnFrame) return;
    const img = frames[idx];
    const cw = canvas.width, ch = canvas.height;
    const scale = Math.max(cw / img.width, ch / img.height);
    const w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    drawnFrame = idx;
  }
  gsap.ticker.add(draw);

  /* ---------- progressive loading ---------- */
  const loaderEl = document.getElementById('loader');
  const loaderFill = loaderEl.querySelector('.loader-fill');
  const loaderPct = loaderEl.querySelector('.loader-pct');

  // Passes: coarse → fine. Gate the site on the first pass.
  const passes = [8, 4, 2, 1];
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
      frames[i] = await createImageBitmap(blob);
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
  const headPillars = splitKinetic(document.querySelector('#pillars .section-head'));
  const headWork = splitKinetic(document.querySelector('#work .section-head'));
  const finaleChars = splitKinetic(document.querySelector('.finale-title'));

  /* ---------- card border traces ---------- */
  function fitTraces() {
    document.querySelectorAll('.card').forEach(card => {
      const rect = card.querySelector('.card-trace rect');
      const len = 2 * (card.clientWidth + card.clientHeight);
      rect.style.strokeDasharray = len;
      rect.style.strokeDashoffset = len;
    });
  }
  addEventListener('resize', fitTraces);

  /* ---------- "What we do" — 3D ice blocks (scroll-driven; one project at a time) ---------- */
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
    if (hudCode) hudCode.textContent = 'PORTFOLIO_CO_0' + (i + 1);
    if (hudKind) hudKind.textContent = p.kind || '';
    if (hudDate) hudDate.textContent = 'D ' + (p.date || '');
  }

  function renderCards() {
    if (window.__ice) window.__ice.setProgress(cardProxy.i);
    const nearest = Math.round(cardProxy.i);
    const frac = Math.abs(cardProxy.i - nearest);
    const op = Math.max(0, 1 - frac * 3.2).toFixed(3);
    if (captionEl) captionEl.style.opacity = op;
    if (hudEl) hudEl.style.opacity = op;
    setCaption(nearest);
    pfDots.forEach((d, k) => d.classList.toggle('is-active', k === nearest));
  }
  addEventListener('resize', renderCards);

  // CLICK TO EXPLORE → open the centred project's detail
  if (hudExplore) hudExplore.addEventListener('click', () => {
    const p = projects[Math.round(cardProxy.i)];
    if (p) openDetail(p.detailId);
  });

  // faint "live" flicker on the TEMP readout (cheap, paused-safe)
  const hudT1 = document.querySelector('.pf-hud-t1');
  const hudT2 = document.querySelector('.pf-hud-t2');
  if (hudT1 && hudT2) setInterval(() => {
    hudT1.textContent = (20 + Math.random() * 2).toFixed(2);
    hudT2.textContent = '-0' + (5 + Math.random() * 2).toFixed(2);
  }, 1600);

  /* ---------- project detail overlays ---------- */
  const openDetail = (id) => {
    const panel = document.getElementById(id);
    if (!panel) return;
    const sc = panel.querySelector('.pf-detail-scroll');
    if (sc) sc.scrollTop = 0;
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    lenis.stop();                                  // freeze the background scroll
  };
  const closeDetail = () => {
    let any = false;
    document.querySelectorAll('.pf-detail.is-open').forEach(p => {
      p.classList.remove('is-open');
      p.setAttribute('aria-hidden', 'true');
      any = true;
    });
    if (any) lenis.start();
  };
  function initDetails() {
    document.querySelectorAll('.pf-detail-close').forEach(b => b.addEventListener('click', closeDetail));
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
  lenis.on('scroll', ScrollTrigger.update);
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
  const U = 1000 + SHIFT;                  // total timeline length in abstract units
  { const t = document.getElementById('track'); if (t) t.style.height = Math.round(U * 1.3) + 'vh'; }

  const panels = {
    hero: document.getElementById('hero'),
    portfolio: document.getElementById('portfolio'),
    pillars: document.getElementById('pillars'),
    work: document.getElementById('work'),
    finale: document.getElementById('finale'),
  };
  // pointer-events windows (unit ranges)
  const liveWindows = [
    { el: panels.portfolio, a: 308, b: EXIT_START },
    { el: panels.work, a: 670 + SHIFT, b: 845 + SHIFT },
    { el: panels.finale, a: 855 + SHIFT, b: U },
  ];

  // Ice scene (three.js) and aurora background (ogl) are lazy-loaded as the portfolio
  // section approaches, and only render while the section is on-screen (RISE_START → after the exit).
  const ICE_A = RISE_START - 6, ICE_B = EXIT_START + EXIT_DUR + 6;
  let iceLoaded = false, iceActive = false;
  let auroraLoaded = false;

  const film = { f: 0 };
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
      },
    },
  });

  // Clip 1 keeps playing until the section fully covers it (frame 79 at COVER_FULL),
  // stays frozen on 79 while the carousel plays, then clips 2-3 resume as the
  // section slides away.
  const setFrame = () => { targetFrame = Math.round(film.f); };
  tl.to(film, { f: CLIP1_END, duration: COVER_FULL, onUpdate: setFrame }, 0);
  // (COVER_FULL → EXIT_START: no film tween active → frame frozen at 79, hidden behind the section)
  tl.to(film, { f: TOTAL - 1, duration: U - EXIT_START, onUpdate: setFrame }, EXIT_START);

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

  /* PILLARS — over clip 2 (base positions shifted by the portfolio hold) */
  show(panels.pillars, 465 + SHIFT);
  tl.set(panels.pillars, { opacity: 1, y: 0 }, 465 + SHIFT);
  tl.from(headPillars, {
    yPercent: 110, opacity: 0, duration: 34, stagger: { each: 2 }, ease: 'power3.out',
  }, 470 + SHIFT);
  ['#pillar-design', '#pillar-dev', '#pillar-motion'].forEach((sel, i) => {
    tl.to(sel, { opacity: 1, duration: 34, ease: 'power2.out' }, 505 + SHIFT + i * 44);
    tl.from(sel, { y: 46, duration: 34, ease: 'power2.out' }, 505 + SHIFT + i * 44);
  });
  tl.to(panels.pillars, { opacity: 0, y: -50, duration: 36, ease: 'power1.in' }, 628 + SHIFT);
  hide(panels.pillars, 665 + SHIFT);

  /* WORK — over clip2 tail / clip3 */
  show(panels.work, 670 + SHIFT);
  tl.set(panels.work, { opacity: 1, y: 0 }, 670 + SHIFT);
  tl.from(headWork, {
    yPercent: 110, opacity: 0, duration: 32, stagger: { each: 2.4 }, ease: 'power3.out',
  }, 675 + SHIFT);
  tl.to('.card', {
    opacity: 1, y: 0, duration: 40, stagger: 20, ease: 'power2.out',
  }, 705 + SHIFT);
  tl.to(panels.work, { opacity: 0, y: -50, duration: 36, ease: 'power1.in' }, 808 + SHIFT);
  hide(panels.work, 845 + SHIFT);

  /* FINALE — over clip 3, timed to the seal stamp */
  show(panels.finale, 855 + SHIFT);
  tl.set(panels.finale, { opacity: 1 }, 855 + SHIFT);
  tl.from(finaleChars, {
    yPercent: 118, opacity: 0, duration: 48, stagger: { each: 2.2 }, ease: 'power3.out',
  }, 868 + SHIFT);
  tl.from('.finale-ctas', { opacity: 0, y: 34, duration: 40, ease: 'power2.out' }, 924 + SHIFT);

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
      // only within the carousel (not the section's own rise-in) or the exit-tumble (the last chunk
      // overshooting left before EXIT_START is still "in the carousel" and should recentre too — using
      // cardsEndU here excluded that whole zone, which is why recentring only ever worked to the right)
      if (u < CARD_START - 4 || u > EXIT_START) return;
      const nearest = Math.min(pfCardCount - 1, Math.max(0, Math.round(cardProxy.i)));
      if (Math.abs(cardProxy.i - nearest) < 0.04) return;            // already centred
      const targetU = CARD_START + nearest * CARD_STEP;
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

  /* ---------- "See our work" → scroll back to work section ---------- */
  document.getElementById('see-work').addEventListener('click', (e) => {
    e.preventDefault();
    const st = tl.scrollTrigger;
    const y = st.start + (st.end - st.start) * ((690 + SHIFT) / U);
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
    fitTraces();
    renderCards();
    initDetails();
    draw();
    loaderEl.classList.add('done');
    lenis.start();
    ScrollTrigger.refresh();
    await loading; // keep filling in fine frames in the background
  }
  boot();

  // test/debug handle + hooks for the ice module
  window.__sp = {
    lenis, tl, projects, openDetail,
    get cardProgress() { return cardProxy.i; },
    get targetFrame() { return targetFrame; },
    get drawnFrame() { return drawnFrame; },
    get loadedCount() { return loadedCount; },
    get total() { return TOTAL; },
    get ready() { return criticalReady; },
  };
})();
