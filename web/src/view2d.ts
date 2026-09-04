import type { ViewModel } from "./types";

export interface View2DDeps {
  atlasUrl: string;
  atlasCols: number;
  atlasTile: number;
  panelCount: number;
  stepped: boolean;
  panelLabel: (panel: number) => string;
  load: (panel: number) => Promise<ViewModel>;
  onError: (message: string) => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 64;
const TEXT_ZOOM = 22;
const GUTTER_ZOOM = 10;
const MAP_SIDE = 128;
const NOOBLINE_ROWS = 1;

function gridLines(from: number, to: number, step: number, offset: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil((from - offset) / step) * step + offset; v <= to; v += step) {
    out.push(v);
  }
  return out;
}

interface Selected {
  x: number;
  y: number;
  z: number;
  paletteId: number;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function loadAtlas(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("atlas image failed to load"));
    img.src = url;
  });
}

export async function openView2D(deps: View2DDeps): Promise<void> {
  const atlas = await loadAtlas(deps.atlasUrl);

  let vm: ViewModel | null = null;
  let panel = deps.panelCount > 1 ? 0 : -1;
  let zoom = 8;
  let panX = 0;
  let panY = 0;
  let selected: Selected | null = null;

  const root = el("div", "view2d");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "build view");
  root.tabIndex = -1;

  const bar = el("div", "view2d-bar");
  const closeBtn = el("button", "mini", "close");
  closeBtn.title = "back to the app (Esc)";
  const sizeEl = el("span", "view2d-size");
  const waila = el("span", "view2d-waila");
  const hint = el("span", "view2d-hint", "drag to pan, scroll to zoom, click a block");
  bar.append(closeBtn);

  let panelSelect: HTMLSelectElement | null = null;
  if (deps.panelCount > 1) {
    const label = el("label", "view2d-panel");
    label.append("panel ");
    panelSelect = el("select");
    for (let i = 0; i < deps.panelCount; i++) {
      const opt = el("option");
      opt.value = String(i);
      opt.textContent = deps.panelLabel(i);
      panelSelect.append(opt);
    }
    label.append(panelSelect);
    bar.append(label);
  }
  bar.append(sizeEl, waila, hint);

  const canvas = el("canvas", "view2d-canvas");
  root.append(bar, canvas);
  document.body.append(root);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    root.remove();
    deps.onError("this browser gave us no 2d canvas");
    return;
  }

  function tileSource(paletteId: number): { sx: number; sy: number } | null {
    if (!vm) return null;
    const entry = vm.palette[paletteId];
    if (!entry || entry.block === null) return null;
    const col = entry.block % deps.atlasCols;
    const row = Math.floor(entry.block / deps.atlasCols);
    return { sx: col * deps.atlasTile, sy: row * deps.atlasTile };
  }

  function fit() {
    if (!vm) return;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    zoom = Math.max(MIN_ZOOM, Math.min(w / vm.w, h / vm.d));
    panX = (w - vm.w * zoom) / 2;
    panY = (h - vm.d * zoom) / 2;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawSteps(x: number, z: number, sx: number, sy: number) {
    if (!vm || z === 0) return;
    const i = z * vm.w + x;
    const north = vm.cells[i - vm.w];
    if (north < 0 || vm.cells[i] < 0) return;
    const delta = vm.heights[i] - vm.heights[i - vm.w];
    if (delta === 0) return;
    const band = Math.max(1, Math.round(zoom / 8));
    ctx!.fillStyle = "rgba(0, 0, 40, 0.2)";
    for (let k = 0; k < 4; k++) {
      const depth = band * (k + 1);
      if (delta > 0) ctx!.fillRect(sx, sy - depth, zoom, depth);
      else ctx!.fillRect(sx, sy, zoom, depth);
    }
  }

  function draw() {
    if (!vm) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx!.fillStyle = "#0b0b0d";
    ctx!.fillRect(0, 0, w, h);
    ctx!.imageSmoothingEnabled = false;

    const x0 = Math.max(0, Math.floor(-panX / zoom));
    const x1 = Math.min(vm.w, Math.ceil((w - panX) / zoom));
    const z0 = Math.max(0, Math.floor(-panY / zoom));
    const z1 = Math.min(vm.d, Math.ceil((h - panY) / zoom));

    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const paletteId = vm.cells[z * vm.w + x];
        if (paletteId < 0) continue;
        const sx = panX + x * zoom;
        const sy = panY + z * zoom;
        const src = tileSource(paletteId);
        if (src) {
          ctx!.drawImage(atlas, src.sx, src.sy, deps.atlasTile, deps.atlasTile, sx, sy, zoom, zoom);
        } else {
          ctx!.fillStyle = paletteId === vm.support ? "#3a3a42" : "#6a2a2a";
          ctx!.fillRect(sx, sy, zoom, zoom);
        }
        drawSteps(x, z, sx, sy);
      }
    }

    if (zoom >= GUTTER_ZOOM) {
      ctx!.strokeStyle = "rgba(0, 0, 0, 0.35)";
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      for (let x = x0; x <= x1; x++) {
        const sx = Math.round(panX + x * zoom) + 0.5;
        ctx!.moveTo(sx, panY);
        ctx!.lineTo(sx, panY + vm.d * zoom);
      }
      for (let z = z0; z <= z1; z++) {
        const sy = Math.round(panY + z * zoom) + 0.5;
        ctx!.moveTo(panX, sy);
        ctx!.lineTo(panX + vm.w * zoom, sy);
      }
      ctx!.stroke();
    }

    ctx!.strokeStyle = "rgba(90, 140, 255, 0.55)";
    ctx!.lineWidth = 1;
    ctx!.beginPath();
    for (const x of gridLines(x0, x1, 16, 0)) {
      const sx = Math.round(panX + x * zoom) + 0.5;
      ctx!.moveTo(sx, panY);
      ctx!.lineTo(sx, panY + vm.d * zoom);
    }
    for (const z of gridLines(z0, z1, 16, NOOBLINE_ROWS)) {
      const sy = Math.round(panY + z * zoom) + 0.5;
      ctx!.moveTo(panX, sy);
      ctx!.lineTo(panX + vm.w * zoom, sy);
    }
    ctx!.stroke();

    ctx!.strokeStyle = "rgba(255, 92, 92, 0.9)";
    ctx!.lineWidth = 2;
    ctx!.beginPath();
    for (const x of gridLines(x0, x1, MAP_SIDE, 0)) {
      const sx = Math.round(panX + x * zoom);
      ctx!.moveTo(sx, panY);
      ctx!.lineTo(sx, panY + vm.d * zoom);
    }
    for (const z of gridLines(z0, z1, MAP_SIDE, NOOBLINE_ROWS)) {
      const sy = Math.round(panY + z * zoom);
      ctx!.moveTo(panX, sy);
      ctx!.lineTo(panX + vm.w * zoom, sy);
    }
    ctx!.stroke();

    if (deps.stepped && zoom >= TEXT_ZOOM) {
      ctx!.font = `${Math.round(zoom / 2.6)}px ui-monospace, monospace`;
      ctx!.textAlign = "right";
      ctx!.textBaseline = "alphabetic";
      ctx!.lineWidth = 3;
      ctx!.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx!.fillStyle = "#fff";
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          const i = z * vm.w + x;
          if (vm.cells[i] < 0) continue;
          const t = String(vm.heights[i]);
          const tx = panX + (x + 1) * zoom - zoom * 0.1;
          const ty = panY + (z + 1) * zoom - zoom * 0.12;
          ctx!.strokeText(t, tx, ty);
          ctx!.fillText(t, tx, ty);
        }
      }
    }

    if (selected) {
      ctx!.strokeStyle = "#ffd34d";
      ctx!.lineWidth = 2;
      ctx!.strokeRect(
        Math.round(panX + selected.x * zoom) + 1,
        Math.round(panY + selected.z * zoom) + 1,
        zoom - 2,
        zoom - 2,
      );
    }
  }

  function renderWaila() {
    waila.textContent = "";
    if (!vm || !selected) return;
    const entry = vm.palette[selected.paletteId];
    const coords = el("span", "view2d-coords", `x ${selected.x}  y ${selected.y}  z ${selected.z}`);
    waila.append(coords);
    if (entry?.block !== null && entry !== undefined) {
      const tile = el("span", "tile small");
      const col = entry.block % deps.atlasCols;
      const row = Math.floor(entry.block / deps.atlasCols);
      tile.style.backgroundPosition = `calc(var(--tile-size, 20px) * -${col}) calc(var(--tile-size, 20px) * -${row})`;
      waila.append(tile);
    }
    const name =
      selected.paletteId === vm.support
        ? `${entry?.display_name ?? "support"} (support)`
        : (entry?.display_name ?? "unknown");
    waila.append(el("span", "view2d-name", name));
  }

  function updateSize() {
    if (!vm) return;
    const [sx, sy, sz] = vm.size;
    sizeEl.textContent = `size: ${sx} x ${sy} x ${sz}`;
    sizeEl.classList.toggle("warn", sy > 256);
    sizeEl.title = sy > 256 ? "taller than one schematic; export split" : "";
  }

  async function show(next: number, keepView: boolean) {
    try {
      const model = await deps.load(next);
      vm = model;
      panel = next;
      selected = null;
      renderWaila();
      updateSize();
      resize();
      if (!keepView) fit();
      draw();
    } catch (e) {
      deps.onError(String(e).replace(/^Error:\s*/, ""));
      close();
    }
  }

  function cellAt(clientX: number, clientY: number): { x: number; z: number } | null {
    if (!vm) return null;
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((clientX - r.left - panX) / zoom);
    const z = Math.floor((clientY - r.top - panY) / zoom);
    if (x < 0 || x >= vm.w || z < 0 || z >= vm.d) return null;
    return { x, z };
  }

  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    moved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      dragging = true;
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
    lastX = e.clientX;
    lastY = e.clientY;
    panX += dx;
    panY += dy;
    draw();
  };

  const onPointerUp = (e: PointerEvent) => {
    dragging = false;
    try {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch {
      dragging = false;
    }
    if (moved || !vm) return;
    const hit = cellAt(e.clientX, e.clientY);
    if (!hit) return;
    const i = hit.z * vm.w + hit.x;
    const paletteId = vm.cells[i];
    if (paletteId < 0) {
      selected = null;
    } else {
      selected = { x: hit.x, y: vm.heights[i], z: hit.z, paletteId };
    }
    renderWaila();
    draw();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!vm) return;
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (next === zoom) return;
    panX = cx - ((cx - panX) * next) / zoom;
    panY = cy - ((cy - panY) * next) / zoom;
    zoom = next;
    draw();
  };

  const onResize = () => {
    resize();
    draw();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  function close() {
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKey);
    root.remove();
  }

  closeBtn.onclick = () => close();
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", onResize);
  document.addEventListener("keydown", onKey);
  if (panelSelect) {
    panelSelect.onchange = () => void show(Number(panelSelect!.value), true);
  }

  root.focus();
  await show(panel, false);
}
