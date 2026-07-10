/* Processing-steps viewer: three synchronised panels + shift plot + trace plot.
 *
 * One time index and one plane index drive everything. `make_assets.py` averages the
 * motion-corrected movie over `mov_sub`'s bins, so time index `t` is the same instant,
 * and the same exposure, in both movies. The correlation map does not vary in t.
 *
 * Three things make the sliders feel instant:
 *
 *  1. Frames are <img> swaps, and a frame is only swapped in once it has decoded. Until
 *     then the previous frame stays on screen. Scrubbing therefore degrades to "a bit
 *     behind" rather than "flashes white", which is what a naive `el.src = url` does.
 *  2. Prefetch is ordered by what the user is about to need: the whole current plane
 *     (time scrubbing), then the whole current z column (plane scrubbing), then
 *     neighbouring planes outward. All of it via the browser's own image cache.
 *  3. The ROI overlay is derived once per plane and cached as a bitmap. Repainting is a
 *     drawImage, not a per-ROI walk.
 *
 * The overlay comes from `rois/labels_zNN.png`, which packs `roiIndex + 1` into RGB. The
 * page decodes it, finds the outline, and hit-tests clicks against it -- so the outline
 * and the click target are the same pixels by construction. This works because the site
 * is served over HTTP; getImageData on a file:// image taints the canvas, which is why
 * the portable viewer in `suite3d/viewer/` has to do something else entirely.
 */
"use strict";
(function () {
  const S = window.STEPS;
  const $ = (id) => document.getElementById(id);
  const panels = Array.from(document.querySelectorAll(".panel"));

  const state = {
    t: 0,
    z: Math.floor(S.nz / 2),
    sel: -1,
    overlay: {},           // movie -> bool
    gen: 0,                // bumped on every change; stale decodes drop themselves
  };
  panels.forEach((p) => {
    const b = p.querySelector(".roi-toggle");
    state.overlay[p.dataset.movie] = !!b && b.getAttribute("aria-pressed") === "true";
  });

  // ---------------------------------------------------------------- frame urls + cache
  const pad = (n, w) => String(n).padStart(w, "0");
  const frameURL = (movie, z, t) =>
    movie === "corrmap"
      ? `frames/corrmap/z${pad(z, 2)}.${S.ext}`
      : `frames/${movie}/z${pad(z, 2)}_t${pad(t, 4)}.${S.ext}`;

  const imgs = new Map();
  function img(url) {
    let im = imgs.get(url);
    if (!im) {
      im = new Image();
      im.src = url;
      imgs.set(url, im);
    }
    return im;
  }
  const ready = (im) => im.complete && im.naturalWidth > 0;

  /* Swap only once decoded, so a miss holds the last good frame instead of blanking.
   *
   * That is why the panel must SAY it is loading: holding the previous frame makes a slow
   * first load look exactly like a movie that does not change (@ali read SS004 as "just a
   * constant" when in fact it had not finished caching). */
  function showFrame(el, url, gen, panel) {
    const im = img(url);
    if (ready(im)) { el.src = url; loading(panel, false); return; }
    loading(panel, true);
    im.decode().then(() => {
      if (gen !== state.gen) return;
      el.src = url;
      loading(panel, false);
    }).catch(() => {});
  }
  const loading = (panel, on) => panel && panel.classList.toggle("loading", on);

  // Prefetch, a few at a time, in the order the user is about to need things. Never the
  // whole export: SS004 is 1100 frames / 30 MB, and a visitor who only watches one plane
  // should not pay for the other 21.
  //
  // The queue holds URL STRINGS, and `img()` -- which sets .src, i.e. starts the download
  // -- is only called when one is dequeued. An earlier version called img() to test
  // readiness while filling the queue, which started all 1100 requests at once: the
  // priority order was then fiction, the browser's 6-connection limit did the scheduling,
  // and a label PNG asked for on a plane change queued behind hundreds of JPEGs. That is
  // why the ROI overlay took seconds to appear.
  const queue = [];
  const queued = new Set();
  let inflight = 0;
  const cached = (url) => imgs.has(url) && ready(imgs.get(url));
  function pump() {
    while (inflight < 6 && queue.length) {
      const url = queue.shift();
      queued.delete(url);
      if (cached(url)) continue;
      inflight++;
      const done = () => { inflight--; report(); pump(); };
      img(url).decode().then(done, done);      // img() starts the request, here and only here
    }
    report();
  }
  function want(urls, first) {
    const fresh = urls.filter((u) => !queued.has(u) && !cached(u));
    if (!fresh.length) return;
    fresh.forEach((u) => queued.add(u));
    if (first) queue.unshift(...fresh); else queue.push(...fresh);
    pump();
  }
  const labelURL = (z) => `rois/labels_z${pad(z, 2)}.png`;
  function report() {
    const el = $("preload");
    if (!el) return;
    const left = queue.length + inflight;
    el.textContent = left ? `caching ${left} frames…` : "";
  }

  const planeSeries = (z) => {
    const u = [];
    for (let t = 0; t < S.n_frames; t++)
      for (const m of ["registered", "mov_sub"]) u.push(frameURL(m, z, t));
    return u;
  };
  /* Every plane at one instant: 2*nz images. This is what makes the z slider instant. */
  const zColumn = (t) => {
    const u = [];
    for (let z = 0; z < S.nz; z++)
      for (const m of ["registered", "mov_sub"]) u.push(frameURL(m, z, t));
    return u;
  };

  // ---------------------------------------------------------------- ROI label overlays
  // Per plane: an Int32 label image (for hit-testing and for painting a selection) and a
  // pre-rendered outline bitmap. Both are big -- 22 planes of SS004 would be ~120 MB --
  // so they are built on demand and evicted LRU.
  const LRU = 8;
  const planes = new Map();          // z -> {labels, outline, sel:-1, selCanvas}
  const NX = S.nx, NY = S.ny;

  /* hsl(golden-angle hue, 85%, 62%) -> rgb. The golden angle keeps neighbouring ids far
     apart in hue; the fixed S/L keeps every outline legible on both the grey movies and
     the magma correlation map. */
  const SAT = 0.85, LUM = 0.62;
  const roiRGB = (id) => {
    const h = ((id * 137.508) % 360) / 60;
    const c = (1 - Math.abs(2 * LUM - 1)) * SAT;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
    const m = LUM - c / 2;
    return [Math.round((t[0] + m) * 255), Math.round((t[1] + m) * 255), Math.round((t[2] + m) * 255)];
  };

  const pending = new Map();
  function loadPlane(z) {
    if (planes.has(z)) return Promise.resolve(planes.get(z));
    if (pending.has(z)) return pending.get(z);
    const im = img(labelURL(z));            // usually already in the prefetch cache
    const p = im.decode().then(() => {
      const c = document.createElement("canvas");
      c.width = NX; c.height = NY;
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.drawImage(im, 0, 0);
      const px = cx.getImageData(0, 0, NX, NY).data;

      const labels = new Int32Array(NX * NY);
      for (let i = 0, p = 0; i < labels.length; i++, p += 4)
        labels[i] = px[p] | (px[p + 1] << 8) | (px[p + 2] << 16);

      // outline = labelled pixel with a differently-labelled (or empty) 4-neighbour
      const out = new ImageData(NX, NY);
      const o = out.data;
      for (let y = 0; y < NY; y++) {
        for (let x = 0; x < NX; x++) {
          const i = y * NX + x, v = labels[i];
          if (!v) continue;
          const edge =
            x === 0 || labels[i - 1] !== v ||
            x === NX - 1 || labels[i + 1] !== v ||
            y === 0 || labels[i - NX] !== v ||
            y === NY - 1 || labels[i + NX] !== v;
          if (!edge) continue;
          const [r, g, b] = roiRGB(v - 1);
          const p = i * 4;
          o[p] = r; o[p + 1] = g; o[p + 2] = b;
          // ids sort traced-first, so alpha also says "clicking me shows a trace"
          o[p + 3] = (v - 1) < S.n_traced ? 235 : 80;
        }
      }
      return createImageBitmap(out).then((outline) => {
        const rec = { labels, outline, sel: -1, selCanvas: null };
        planes.set(z, rec);
        // Each record is ~5.5 MB for SS004 (a 735x928 Int32 label image plus its RGBA
        // bitmap), so all 22 planes would be 120 MB. Evict the least recently touched.
        while (planes.size > LRU) {
          for (const k of planes.keys()) {
            if (k === state.z) continue;
            const gone = planes.get(k);
            if (gone.outline.close) gone.outline.close();
            planes.delete(k);
            break;
          }
        }
        return rec;
      });
    }).finally(() => pending.delete(z));
    pending.set(z, p);
    return p;
  }

  /* Pixels of the selected ROI, on its own canvas, so repainting the selection is a blit. */
  function selectionCanvas(rec, id) {
    if (rec.sel === id) return rec.selCanvas;
    rec.sel = id;
    rec.selCanvas = null;
    if (id < 0) return null;
    const want = id + 1;
    const d = new ImageData(NX, NY), o = d.data;
    let hit = 0;
    for (let i = 0; i < rec.labels.length; i++) {
      if (rec.labels[i] !== want) continue;
      const p = i * 4;
      o[p] = 255; o[p + 1] = 255; o[p + 2] = 255; o[p + 3] = 120;
      hit++;
    }
    if (!hit) return null;
    const c = document.createElement("canvas");
    c.width = NX; c.height = NY;
    c.getContext("2d").putImageData(d, 0, 0);
    rec.selCanvas = c;
    return c;
  }

  const clearOverlays = () => {
    for (const p of panels) p.querySelector(".overlay").getContext("2d").clearRect(0, 0, NX, NY);
  };
  function paintOverlays() {
    const z = state.z;
    if (!S.rois) return clearOverlays();
    const on = panels.some((p) => state.overlay[p.dataset.movie]);
    if (!on && state.sel < 0) return clearOverlays();
    // Repaint only once the new plane is ready. Clearing first makes the ROIs vanish and
    // then pop back on every plane step, which is what "takes forever to load" looks like.
    if (!planes.has(z)) want([labelURL(z)], true);
    loadPlane(z).then((rec) => {
      if (state.z !== z) return;
      const sel = selectionCanvas(rec, state.sel);
      for (const p of panels) {
        const cv = p.querySelector(".overlay");
        const cx = cv.getContext("2d");
        cx.clearRect(0, 0, NX, NY);
        if (state.overlay[p.dataset.movie]) cx.drawImage(rec.outline, 0, 0);
        if (sel) cx.drawImage(sel, 0, 0);
      }
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- panels
  function render() {
    const gen = ++state.gen;
    const secs = (state.t * S.stride) / S.fs_vol;
    for (const p of panels) {
      const m = p.dataset.movie;
      showFrame(p.querySelector(".movie"), frameURL(m, state.z, state.t), gen, p);
      const cap = p.querySelector('[data-role="caption"]');
      if (cap) {
        cap.textContent = m === "corrmap"
          ? `z = ${state.z}`
          : `z = ${state.z} · ${secs.toFixed(1)} s`;
      }
    }
    $("fout").textContent = `${state.t + 1} / ${S.n_frames}`;
    $("zout").textContent = `${state.z} / ${S.nz - 1}`;
    $("frame").value = state.t;
    $("plane").value = state.z;
    paintOverlays();
    drawShifts();
    drawTraces();
  }

  // ---------------------------------------------------------------- plots
  const CSS = getComputedStyle(document.documentElement);
  const col = (n, d) => (CSS.getPropertyValue(n) || d).trim();
  const INK = col("--text", "#ddd"), DIM = col("--dim", "#8a90a0");
  const LINE = col("--line", "#3a4150"), ACC = col("--accent", "#6cf");

  function fitCanvas(cv) {
    const w = cv.clientWidth, dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(cv.clientHeight * dpr);
    }
    const cx = cv.getContext("2d");
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [cx, w, cv.clientHeight];
  }

  /* One stacked strip per series. `rows` is [{name, data, zero}]. */
  function strips(cv, rows, cursorFrac) {
    const [cx, W, H] = fitCanvas(cv);
    cx.clearRect(0, 0, W, H);
    const padL = 46, padR = 8, padT = 6, padB = 16;
    const h = (H - padT - padB) / rows.length;
    const iw = W - padL - padR;

    rows.forEach((row, k) => {
      const y0 = padT + k * h, y1 = y0 + h - 6;
      const d = row.data;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < d.length; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
      if (row.zero) lo = Math.min(lo, 0);
      if (!(hi > lo)) { hi = lo + 1; }
      const yOf = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);

      cx.strokeStyle = LINE;
      cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(padL, y1 + 0.5); cx.lineTo(W - padR, y1 + 0.5); cx.stroke();

      cx.fillStyle = DIM;
      cx.font = "11px Helvetica, Arial, sans-serif";
      cx.textAlign = "right";
      cx.fillText(row.name, padL - 8, y0 + 11);
      cx.fillText(hi.toFixed(row.dp ?? 1), padL - 8, y0 + 24);
      cx.fillText(lo.toFixed(row.dp ?? 1), padL - 8, y1);

      cx.strokeStyle = row.color || ACC;
      cx.lineWidth = 1;
      cx.beginPath();
      // more samples than pixels: draw the min/max envelope, not every 30th point
      const per = d.length / iw;
      if (per > 2) {
        for (let px = 0; px < iw; px++) {
          const a = Math.floor(px * per), b = Math.min(d.length, Math.floor((px + 1) * per));
          let mn = Infinity, mx = -Infinity;
          for (let i = a; i < b; i++) { if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
          if (mn === Infinity) continue;
          cx.moveTo(padL + px + 0.5, yOf(mn));
          cx.lineTo(padL + px + 0.5, yOf(mx));
        }
      } else {
        for (let i = 0; i < d.length; i++) {
          const x = padL + (i / (d.length - 1)) * iw;
          i ? cx.lineTo(x, yOf(d[i])) : cx.moveTo(x, yOf(d[i]));
        }
      }
      cx.stroke();
    });

    const x = padL + cursorFrac * iw;
    cx.strokeStyle = "#fff";
    cx.globalAlpha = 0.75;
    cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(x, padT); cx.lineTo(x, H - padB); cx.stroke();
    cx.globalAlpha = 1;
    cx.fillStyle = "#fff";
    cx.beginPath(); cx.arc(x, padT + 3, 3, 0, 7); cx.fill();
  }

  /* The clip covers the first n_frames*stride volumes; the plots show the whole run, so
     the cursor sits where the clip is, not at the right edge. */
  const cursorFrac = (nt) => (state.t * S.stride) / Math.max(1, nt - 1);

  let shifts = null;
  function drawShifts() {
    const cv = $("shifts");
    if (!cv || !shifts) return;
    strips(cv, [
      { name: "z", data: shifts.z, color: "#e8845a", dp: 2 },
      { name: "y", data: shifts.y, color: "#7fc97f", dp: 1 },
      { name: "x", data: shifts.x, color: "#8fa8ff", dp: 1 },
    ], cursorFrac(shifts.z.length));
  }

  // ---------------------------------------------------------------- traces
  const chunks = new Map();
  function b64ToArray(s, Type) {
    const bin = atob(s), n = bin.length, u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return new Type(u8.buffer);
  }
  function loadChunk(c) {
    if (chunks.has(c)) return chunks.get(c);
    const p = fetch(`traces/chunk_${pad(c, 4)}.json`)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((j) => {
        const out = { nt: j.nt, n: j.n };
        for (const k of ["f", "spks"]) {
          out[k] = {
            q: b64ToArray(j[k], Int16Array),
            scale: b64ToArray(j[k + "_scale"], Float32Array),
            offset: b64ToArray(j[k + "_offset"], Float32Array),
          };
        }
        return out;
      });
    chunks.set(c, p);
    return p;
  }
  function dequant(ch, key, row) {
    const { q, scale, offset } = ch[key], nt = ch.nt;
    const out = new Float32Array(nt), s = scale[row], o = offset[row], base = row * nt;
    for (let i = 0; i < nt; i++) out[i] = q[base + i] * s + o;
    return out;
  }

  let trace = null;                      // {id, f, spks}
  function drawTraces() {
    const cv = $("traces");
    if (!cv) return;
    if (!trace) {
      const [cx, W, H] = fitCanvas(cv);
      cx.clearRect(0, 0, W, H);
      return;
    }
    strips(cv, [
      { name: "F − 0.7·Fneu", data: trace.f, color: ACC, dp: 0 },
      { name: "spks", data: trace.spks, color: "#e8845a", zero: true, dp: 0 },
    ], cursorFrac(trace.f.length));
  }

  function select(id) {
    state.sel = id;
    paintOverlays();
    const hdr = $("tracehdr");
    if (!hdr) return;
    if (id < 0) { trace = null; hdr.textContent = "Click a cell in any panel above."; drawTraces(); return; }

    const label = `ROI ${id}`;
    if (id >= S.n_traced) {
      trace = null;
      hdr.innerHTML = `<b>${label}</b> — trace not exported ` +
        `(${S.n_traced.toLocaleString()} of ${S.n_roi.toLocaleString()} ROIs carry one; ` +
        `they are the solid outlines).`;
      drawTraces();
      return;
    }
    hdr.innerHTML = `<b>${label}</b> — loading…`;
    const c = Math.floor(id / S.chunk_rois), row = id % S.chunk_rois;
    loadChunk(c).then((ch) => {
      if (state.sel !== id) return;
      trace = { id, f: dequant(ch, "f", row), spks: dequant(ch, "spks", row) };
      hdr.innerHTML = `<b>${label}</b> — brightness rank ${id + 1} of ` +
        `${S.n_roi.toLocaleString()}`;
      drawTraces();
    }).catch((e) => {
      if (state.sel !== id) return;
      hdr.textContent = `${label} — trace failed to load (${e.message})`;
    });
  }


  // ---------------------------------------------------------------- zoom / pan
  // ONE view for all three panels. `u, v` are the normalised image coordinates of the
  // visible top-left corner and `s` is the magnification, so the same numbers drive panels
  // of different pixel sizes (the correlation map is full resolution; SS004's movies are
  // block-meaned 2x). The transform sits on `.zoom`, which wraps the frame AND the ROI
  // overlay -- so the overlay cannot drift off the pixels it outlines, whatever the zoom.
  //
  // hit() needs no inverse transform: getBoundingClientRect() already reports the
  // transformed box of the overlay canvas, and there is no rotation to unpick.
  const MAX_ZOOM = 16;
  const view = { s: 1, u: 0, v: 0 };
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function clampView() {
    view.s = clamp(view.s, 1, MAX_ZOOM);
    const m = 1 - 1 / view.s;            // largest top-left that keeps the frame covering
    view.u = clamp(view.u, 0, m);
    view.v = clamp(view.v, 0, m);
  }
  function applyView() {
    // Translate in PERCENT, not pixels. `.zoom` is inset:0 on `.stage`, so a percentage
    // resolves against each panel's own box -- and the grid does not give the three panels
    // identical boxes (sub-pixel column widths make the third stage 431 px tall where the
    // others are 430). A pixel translate computed from one panel's size would put the
    // panels a pixel out of step with each other.
    const tx = (-view.u * 100).toFixed(4), ty = (-view.v * 100).toFixed(4);
    for (const p of panels) {
      p.querySelector(".zoom").style.transform =
        `scale(${view.s}) translate(${tx}%, ${ty}%)`;
    }
    const home = $("home");
    const idle = view.s === 1 && view.u === 0 && view.v === 0;
    if (home) home.disabled = idle;
    const zo = $("zoomout");
    if (zo) zo.textContent = idle ? "" : `${view.s.toFixed(1)}x`;
  }
  function resetView() { view.s = 1; view.u = 0; view.v = 0; applyView(); }

  function zoomAt(stage, clientX, clientY, factor) {
    const r = stage.getBoundingClientRect();      // untransformed: the transform is inside
    const mx = (clientX - r.left) / r.width, my = (clientY - r.top) / r.height;
    const px = view.u + mx / view.s, py = view.v + my / view.s;   // image coords under cursor
    view.s = clamp(view.s * factor, 1, MAX_ZOOM);
    view.u = px - mx / view.s;                    // keep that point under the cursor
    view.v = py - my / view.s;
    clampView();
    applyView();
  }

  for (const p of panels) {
    const stage = p.querySelector(".stage");
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      zoomAt(stage, e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    // Drag to pan. A drag must not also select an ROI, so the click that the browser
    // synthesises after the pointer goes up is swallowed when the pointer actually moved.
    let drag = null;
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, u: view.u, v: view.v, moved: 0 };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      if (view.s === 1) return;
      const r = stage.getBoundingClientRect();
      view.u = drag.u - dx / (r.width * view.s);
      view.v = drag.v - dy / (r.height * view.s);
      clampView();
      applyView();
    });
    stage.addEventListener("pointerup", (e) => {
      const d = drag;
      drag = null;
      if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
      if (d && d.moved > 4) swallowClick = true;
    });
    stage.addEventListener("dblclick", (e) => {
      e.preventDefault();
      zoomAt(stage, e.clientX, e.clientY, 2);
    });
  }
  let swallowClick = false;

  if ($("home")) $("home").addEventListener("click", resetView);
  window.addEventListener("resize", applyView);

  // ---------------------------------------------------------------- input
  function hit(p, ev) {
    const cv = p.querySelector(".overlay");
    const r = cv.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - r.left) / r.width) * NX);
    const y = Math.floor(((ev.clientY - r.top) / r.height) * NY);
    if (x < 0 || y < 0 || x >= NX || y >= NY) return;
    loadPlane(state.z).then((rec) => {
      const v = rec.labels[y * NX + x];
      select(v ? v - 1 : -1);
    }).catch(() => {});
  }

  let timer = null;
  function stop() { clearInterval(timer); timer = null; $("play").textContent = "Play"; }
  function play() {
    if (timer) return stop();
    $("play").textContent = "Pause";
    timer = setInterval(() => { state.t = (state.t + 1) % S.n_frames; render(); },
                        1000 / +$("fps").value);
  }

  // The z column for the *current* t is what a plane scrub reads, and it goes stale as
  // soon as t moves. Refresh it once the time slider settles, not on every input event.
  let zcolTimer = 0;
  function refreshColumn() {
    clearTimeout(zcolTimer);
    zcolTimer = setTimeout(() => want(zColumn(state.t), true), 120);
  }

  $("frame").addEventListener("input", (e) => {
    stop();
    state.t = +e.target.value;
    render();
    refreshColumn();
  });
  $("plane").addEventListener("input", (e) => {
    state.z = +e.target.value;
    render();
    want(planeSeries(state.z));
  });
  $("fps").addEventListener("change", () => { if (timer) { stop(); play(); } });
  $("play").addEventListener("click", play);

  for (const p of panels) {
    const b = p.querySelector(".roi-toggle");
    if (b) b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      state.overlay[p.dataset.movie] = on;
      paintOverlays();
    });
    if (S.rois) p.querySelector(".stage").addEventListener("click", (e) => {
      if (swallowClick) { swallowClick = false; return; }   // that click ended a pan
      hit(p, e);
    });
  }

  window.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "BUTTON", "TEXTAREA"].includes(e.target.tagName)) return;
    const k = e.key;
    if (k === "ArrowRight") { stop(); state.t = Math.min(S.n_frames - 1, state.t + 1); }
    else if (k === "ArrowLeft") { stop(); state.t = Math.max(0, state.t - 1); }
    else if (k === "ArrowUp") state.z = Math.min(S.nz - 1, state.z + 1);
    else if (k === "ArrowDown") state.z = Math.max(0, state.z - 1);
    else if (k === " ") play();
    else if (k === "0") { resetView(); return; }
    else if (k === "Escape") { select(-1); return; }
    else return;
    e.preventDefault();
    render();
  });

  let raf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { drawShifts(); drawTraces(); });
  });

  // ---------------------------------------------------------------- go
  render();
  applyView();
  // Order matters: the z column first (it is small and makes the plane slider instant),
  // then the current plane's whole time series, then one plane either side. Everything
  // else loads only if the user goes there.
  want(zColumn(state.t), true);
  if (S.corrmap) want(Array.from({ length: S.nz }, (_, z) => frameURL("corrmap", z, 0)));
  // Label maps before the movie frames: they are small (SS004: 22 x 128 kB) and they are
  // what a plane change blocks on. Behind 1100 JPEGs they arrive seconds late.
  if (S.rois) want(Array.from({ length: S.nz }, (_, z) => labelURL(z)));
  want(planeSeries(state.z));
  if (state.z > 0) want(planeSeries(state.z - 1));
  if (state.z < S.nz - 1) want(planeSeries(state.z + 1));
  if (S.shifts) {
    fetch("shifts.json").then((r) => r.json()).then((j) => {
      shifts = { z: Float32Array.from(j.z), y: Float32Array.from(j.y), x: Float32Array.from(j.x) };
      drawShifts();
    }).catch(() => {});
  }
})();
