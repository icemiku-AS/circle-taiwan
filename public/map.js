import { drawClueTiles, intersects } from './clue-tiles.js';

export function drawPath(context, geometry) {
  context.beginPath();
  for (const poly of geometry) for (const ring of poly) {
    if (!ring.length) continue;
    context.moveTo(...ring[0]); for (let i = 1; i < ring.length; i++) context.lineTo(...ring[i]); context.closePath();
  }
}

export function drawLandmarkTarget(c, point, detail, scale) {
  if (!point) return;
  const px = 1 / scale;
  c.save();
  if (detail?.hit === false && detail.nearestPoint) {
    c.beginPath(); c.moveTo(...point); c.lineTo(...detail.nearestPoint);
    c.strokeStyle = '#ffffff'; c.lineWidth = 5 * px; c.stroke();
    c.strokeStyle = '#7d3927'; c.lineWidth = 2 * px; c.setLineDash([6 * px, 4 * px]); c.stroke(); c.setLineDash([]);
  }
  c.translate(...point); c.scale(px, px);
  c.beginPath(); c.moveTo(0, 0); c.bezierCurveTo(-4, 6, -11, 12, -11, 20);
  c.arc(0, 20, 11, Math.PI, 0, true); c.bezierCurveTo(11, 12, 4, 6, 0, 0); c.closePath();
  c.fillStyle = '#a43825'; c.strokeStyle = '#fffdf7'; c.lineWidth = 3; c.fill(); c.stroke();
  c.beginPath(); c.arc(0, 20, 3.5, 0, Math.PI * 2); c.fillStyle = '#fffdf7'; c.fill();
  c.restore();
}

export class GameMap {
  constructor(canvas, data, { onChange, onMessage, onViewChange }) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.data = data;
    this.onChange = onChange; this.onMessage = onMessage; this.points = []; this.reveal = null;
    this.onViewChange = onViewChange; this.background = document.createElement('canvas'); this.cluesVisible = false; this.clues = null;
    this.extent = data.bounds; this.mode = 'draw'; this.editable = false; this.pointers = new Map(); this.view = null;
    this.cursor = [(data.bounds[0] + data.bounds[2]) / 2, (data.bounds[1] + data.bounds[3]) / 2];
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoom(Math.exp(-e.deltaY * .0015), this.local(e)); }, { passive: false });
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.up(e));
    canvas.addEventListener('keydown', e => this.key(e));
    canvas.addEventListener('focus', () => this.render()); canvas.addEventListener('blur', () => this.render());
  }
  local(e) { const b = this.canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; }
  world([x, y]) { return [this.view.x + (x - this.width / 2) / this.view.scale, this.view.y - (y - this.height / 2) / this.view.scale]; }
  screen([x, y]) { return [(x - this.view.x) * this.view.scale + this.width / 2, (this.view.y - y) * this.view.scale + this.height / 2]; }
  visibleBounds(padding = 0) {
    const a = this.world([-this.width * padding, this.height * (1 + padding)]), b = this.world([this.width * (1 + padding), -this.height * padding]);
    return [a[0], a[1], b[0], b[1]].map((n, i) => Math.max(this.data.playBounds[i % 2], Math.min(this.data.playBounds[i % 2 + 2], n)));
  }
  scaleFor(bounds) { return Math.min(this.width / (bounds[2] - bounds[0]), this.height / (bounds[3] - bounds[1])) * .88; }
  resize() {
    const b = this.canvas.getBoundingClientRect(); if (b.width < 2 || b.height < 2) return;
    if (!this.suspended && this.width === b.width && this.height === b.height && this.dpr === Math.min(devicePixelRatio || 1, 2)) return;
    this.suspended = false;
    const oldWidth = this.width, oldHeight = this.height; this.width = b.width; this.height = b.height; this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr); this.canvas.height = Math.round(this.height * this.dpr);
    if (!this.view) this.fit(this.extent);
    else {
      const dx = this.extent[2] - this.extent[0], dy = this.extent[3] - this.extent[1];
      if (oldWidth && oldHeight) this.view.scale *= Math.min(this.width / dx, this.height / dy) / Math.min(oldWidth / dx, oldHeight / dy);
      this.render();
    }
  }
  suspend() {
    if (this.suspended) return;
    this.suspended = true; clearTimeout(this.settleTimer); this.interacting = false;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined; this.gesture = null; this.pointers.clear(); this.reveal = null;
    this.canvas.width = this.canvas.height = this.background.width = this.background.height = 0;
    this.baseKey = this.baseContentKey = this.vectorPaths = null;
    this.revealPaths?.clear();
  }
  fit(extent = this.extent) {
    this.extent = extent;
    if (!this.width) return;
    this.view = { x: (extent[0] + extent[2]) / 2, y: (extent[1] + extent[3]) / 2, scale: this.scaleFor(extent) };
    this.cursor = [this.view.x, this.view.y]; this.render();
  }
  zoom(factor, point = [this.width / 2, this.height / 2]) {
    if (!this.view) return;
    this.interact();
    const anchor = this.world(point);
    this.view.scale = Math.max(this.scaleFor(this.data.bounds) * .6, Math.min(this.scaleFor(this.extent) * 80, this.view.scale * factor));
    this.view.x = anchor[0] - (point[0] - this.width / 2) / this.view.scale;
    this.view.y = anchor[1] + (point[1] - this.height / 2) / this.view.scale;
    this.clamp(); this.render();
  }
  clamp() {
    const b = this.data.playBounds;
    this.view.x = Math.max(b[0], Math.min(b[2], this.view.x)); this.view.y = Math.max(b[1], Math.min(b[3], this.view.y));
  }
  interact() {
    this.interacting = true; clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { this.interacting = false; this.render(); }, 150);
  }
  safePoint(point) { const b = this.data.playBounds; return [Math.max(b[0], Math.min(b[2], point[0])), Math.max(b[1], Math.min(b[3], point[1]))]; }
  down(e) {
    e.preventDefault(); this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 2) {
      if (this.mode === 'draw') { if (this.gesture?.drawing) this.restoreStroke(); this.gesture = null; this.onMessage('請先切換到移動模式，再用雙指縮放'); return; }
      const [a, b] = [...this.pointers.values()];
      this.gesture = { pinch: Math.hypot(a[0] - b[0], a[1] - b[1]), center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; return;
    }
    if (this.pointers.size !== 1) return;
    const point = this.local(e);
    if (this.mode === 'move' || e.button === 2 || e.button === 1) this.gesture = { pan: point };
    else if (this.editable) {
      const undoBefore = this.beforeStroke;
      this.beforeStroke = { points: this.points.slice(), keyboardDrawing: this.keyboardDrawing };
      this.points = [this.safePoint(this.world(point))]; this.gesture = { drawing: true, last: point, undoBefore }; this.keyboardDrawing = false; this.onChange(this.points);
    }
    else this.gesture = { pan: point };
    this.render();
  }
  move(e) {
    if (!this.pointers.has(e.pointerId) || !this.view) return;
    const point = this.local(e); this.pointers.set(e.pointerId, point); const g = this.gesture;
    if (!g) return;
    if (g.pan || g.pinch) this.interact();
    if (g.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()], distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.zoom(distance / Math.max(1, g.pinch), center);
      this.view.x -= (center[0] - g.center[0]) / this.view.scale; this.view.y += (center[1] - g.center[1]) / this.view.scale;
      g.pinch = distance; g.center = center;
    } else if (g.pan) {
      this.view.x -= (point[0] - g.pan[0]) / this.view.scale; this.view.y += (point[1] - g.pan[1]) / this.view.scale; g.pan = point;
    } else if (g.drawing && this.editable && Math.hypot(point[0] - g.last[0], point[1] - g.last[1]) >= 3) {
      if (this.points.length >= this.data.maxPoints) { if (!g.full) this.onMessage('筆畫已達點數上限，請放開或重畫'); g.full = true; }
      else { this.points.push(this.safePoint(this.world(point))); g.last = point; this.onChange(this.points); }
    }
    this.clamp(); this.render();
  }
  up(e) {
    this.pointers.delete(e.pointerId); const drawing = this.gesture?.drawing;
    if (drawing && (this.points.length < 3 || e.type === 'pointercancel')) this.restoreStroke();
    else { this.gesture = null; if (drawing) this.onChange(this.points, true); }
    this.render();
  }
  restoreStroke() {
    this.points = this.beforeStroke.points; this.keyboardDrawing = this.beforeStroke.keyboardDrawing;
    this.beforeStroke = this.gesture?.undoBefore; this.gesture = null; this.onChange(this.points, true); this.render();
  }
  undo() { if (this.editable && !this.gesture?.drawing && this.beforeStroke) this.restoreStroke(); }
  clear() {
    if (!this.editable || !this.points.length) return;
    this.beforeStroke = { points: this.points.slice(), keyboardDrawing: this.keyboardDrawing };
    this.points = []; this.keyboardDrawing = false; this.onChange(this.points, true); this.render();
  }
  key(e) {
    if (!this.view) return;
    const arrows = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, 12], ArrowDown: [0, -12] };
    if (this.editable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); }
    else if (arrows[e.key]) {
      e.preventDefault(); const d = arrows[e.key];
      if (this.mode === 'move') { this.interact(); this.view.x += d[0] / this.view.scale; this.view.y += d[1] / this.view.scale; this.clamp(); }
      else this.cursor = this.safePoint([this.cursor[0] + d[0] / this.view.scale, this.cursor[1] + d[1] / this.view.scale]);
    } else if (this.editable && this.mode === 'draw' && e.code === 'Space') {
      e.preventDefault(); if (!this.keyboardDrawing) { this.beforeStroke = { points: this.points.slice(), keyboardDrawing: false }; this.points = []; this.keyboardDrawing = true; }
      if (this.points.length < this.data.maxPoints) { this.points.push(this.cursor.slice()); this.onChange(this.points); }
    } else if (this.editable && e.key === 'Enter') { e.preventDefault(); this.keyboardDrawing = false; this.onChange(this.points, true); }
    else return;
    this.render();
  }
  path(geometry) {
    drawPath(this.ctx, geometry);
  }
  line(points, color, dash = false, fill = false, closed = true) {
    if (!points.length) return;
    const c = this.ctx, px = 1 / this.view.scale;
    if (closed) this.path([[points]]);
    else { c.beginPath(); c.moveTo(...points[0]); for (const p of points.slice(1)) c.lineTo(...p); }
    if (fill && closed && points.length >= 3) { c.fillStyle = `${color}35`; c.fill('nonzero'); }
    c.strokeStyle = '#fff'; c.lineWidth = 5 * px; c.stroke(); c.strokeStyle = color; c.lineWidth = 2.4 * px;
    c.setLineDash(dash ? [7 * px, 5 * px] : []); c.stroke(); c.setLineDash([]);
  }
  cluePaths(detail) {
    if (this.vectorPaths?.generation === this.clues.generation && this.vectorPaths.detail === detail) return this.vectorPaths;
    const water = [], lines = new Map(), order = new Map();
    for (const f of this.clues.features) {
      if (f.kind !== 'water' && f.tier > detail) continue;
      // Stable 16km batches reuse native paths across pans; wide overviews retain the original small stroke count.
      const cell = detail ? `:${Math.floor((f.bounds[0] + f.bounds[2]) / 32000)}:${Math.floor((f.bounds[1] + f.bounds[3]) / 32000)}` : '';
      const category = `${f.kind}:${f.tier}`, key = category + cell;
      if (!order.has(category)) order.set(category, order.size);
      if (f.kind !== 'water' && !lines.has(key)) lines.set(key, { kind: f.kind, tier: f.tier, order: order.get(category), bounds: [...f.bounds], path: new Path2D() });
      const group = lines.get(key), path = f.kind === 'water' ? new Path2D() : group.path;
      if (group) for (let i = 0; i < 4; i++) group.bounds[i] = i < 2 ? Math.min(group.bounds[i], f.bounds[i]) : Math.max(group.bounds[i], f.bounds[i]);
      for (const points of f.paths) {
        if (!points.length) continue;
        path.moveTo(...points[0]); for (let i = 1; i < points.length; i++) path.lineTo(...points[i]);
        if (f.kind === 'water') path.closePath();
      }
      if (f.kind === 'water') water.push({ bounds: f.bounds, path });
    }
    return this.vectorPaths = { generation: this.clues.generation, detail, water, lines: [...lines.values()].sort((a, b) => a.order - b.order) };
  }
  paintBase() {
    const v = this.view, d = this.dpr, px = 1 / v.scale;
    const contentKey = [this.width, this.height, d, this.cluesVisible, this.countiesVisible, this.clues?.generation].join(':');
    const key = [this.width, this.height, d, v.x, v.y, v.scale, this.cluesVisible, this.countiesVisible, this.clues?.generation].join(':');
    if (this.baseKey === key) return;
    // Panning does not change pixel density; keep exact-scale pixels until coverage or content changes.
    if ((this.interacting || this.baseView?.scale === v.scale) && this.baseContentKey === contentKey) {
      if (this.baseFull) return;
      const { x, y, scale } = this.baseTransform();
      if (x <= 0 && y <= 0 && x + this.background.width * scale >= this.canvas.width && y + this.background.height * scale >= this.canvas.height) return;
    }
    const b = this.data.bounds, fullWidth = (b[2] - b[0]) * d * v.scale + 2 * d, fullHeight = (b[3] - b[1]) * d * v.scale + 2 * d;
    this.baseFull = fullWidth <= this.canvas.width * 1.4 && fullHeight <= this.canvas.height * 1.4;
    this.baseContentKey = contentKey;
    this.baseView = this.baseFull ? { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, scale: v.scale, dpr: d } : { ...v, dpr: d };
    const center = this.baseView;
    this.baseKey = key; const c = this.background.getContext('2d');
    const width = Math.ceil(this.baseFull ? fullWidth : this.canvas.width * 1.4), height = Math.ceil(this.baseFull ? fullHeight : this.canvas.height * 1.4);
    if (this.background.width !== width) this.background.width = width;
    if (this.background.height !== height) this.background.height = height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#e6e9e3'; c.fillRect(0, 0, this.background.width, this.background.height);
    c.setTransform(d * v.scale, 0, 0, -d * v.scale, this.background.width / 2 - d * center.x * v.scale, this.background.height / 2 + d * center.y * v.scale);
    drawPath(c, this.data.land); c.fillStyle = '#f6f4ed'; c.fill('nonzero');
    if (this.cluesVisible && this.clues) {
      c.save(); c.clip('nonzero');
      const [x0, y0, x1, y1] = this.clues.terrain.bounds;
      c.save(); c.translate(x0, y1); c.scale(1, -1); c.drawImage(this.clues.canvas, 0, 0, x1 - x0, y1 - y0); c.restore();
      const bounds = (this.baseFull ? b : this.visibleBounds(.2)).map((n, i) => n + (i < 2 ? -2 : 2) * px);
      const detail = px > 200 ? 0 : px > 35 ? 1 : 2;
      if (this.clues.raster) drawClueTiles(c, this.clues.raster, bounds);
      const paths = this.clues.raster ? { water: [], lines: [] } : this.cluePaths(detail);
      c.fillStyle = '#9BCADB';
      for (const f of paths.water) {
        if (f.bounds[0] > bounds[2] || f.bounds[2] < bounds[0] || f.bounds[1] > bounds[3] || f.bounds[3] < bounds[1]) continue;
        c.fill(f.path, 'nonzero');
      }
      for (const f of paths.lines) {
        if (!intersects(f.bounds, bounds)) continue;
        c.strokeStyle = f.kind === 'river' ? '#79ADC5' : f.tier === 0 ? '#B59D78' : '#C5B799';
        c.lineWidth = (f.kind === 'river' ? 1.05 : f.tier === 0 ? 1.2 : .65) * px; c.stroke(f.path);
      }
      c.restore();
    }
    if (this.countiesVisible && this.countyBoundaries) { drawPath(c, this.countyBoundaries); c.strokeStyle = '#718477'; c.lineWidth = 1.1 * px; c.stroke(); }
    drawPath(c, this.data.land); c.strokeStyle = '#738477'; c.lineWidth = px; c.stroke();
  }
  baseTransform() {
    const b = this.baseView, v = this.view, scale = v.scale / b.scale * this.dpr / b.dpr;
    return { scale, x: this.canvas.width / 2 + (b.x - v.x) * v.scale * this.dpr - this.background.width / 2 * scale,
      y: this.canvas.height / 2 + (v.y - b.y) * v.scale * this.dpr - this.background.height / 2 * scale };
  }
  render() {
    if (this.suspended || !this.view || !this.width) return;
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.paint(); });
  }
  paint() {
    const c = this.ctx, v = this.view, d = this.dpr, px = 1 / v.scale;
    this.paintBase();
    this.onViewChange?.();
    if (this.baseFull) { c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#e6e9e3'; c.fillRect(0, 0, this.canvas.width, this.canvas.height); }
    const base = this.baseTransform(); c.setTransform(base.scale, 0, 0, base.scale, base.x, base.y); c.drawImage(this.background, 0, 0);
    c.setTransform(d * v.scale, 0, 0, -d * v.scale, d * (this.width / 2 - v.x * v.scale), d * (this.height / 2 + v.y * v.scale));
    c.lineJoin = 'round'; c.lineCap = 'round';
    const r = this.reveal;
    // Keep only the displayed comparison; original coordinates remain available for sharing.
    const geometries = r ? [r.neutral, r.target, ...Object.values(r.results || {}).flatMap(v => [v.hit, v.extra, v.miss, v.answer])].filter(Boolean) : [];
    this.revealPaths ||= new Map();
    for (const geometry of this.revealPaths.keys()) if (!geometries.includes(geometry)) this.revealPaths.delete(geometry);
    const retainedPath = geometry => {
      if (!this.revealPaths.has(geometry)) {
        const path = new Path2D();
        for (const polygon of geometry || []) for (const ring of polygon) {
          if (!ring.length) continue;
          path.moveTo(...ring[0]); for (const point of ring.slice(1)) path.lineTo(...point); path.closePath();
        }
        this.revealPaths.set(geometry, path);
      }
      return this.revealPaths.get(geometry);
    };
    if (r) {
      if (r.neutral?.length) { c.fillStyle = '#D5D5D5'; c.fill(retainedPath(r.neutral), 'nonzero'); }
      const focused = r.results?.[r.focus];
      if (focused?.landmark) { c.fillStyle = `${r.players.find(p => p.id === r.focus)?.color || '#c56e46'}35`; c.fill(retainedPath(focused.answer), 'nonzero'); }
      else if (focused) for (const [key, color] of [['hit', '#b6975888'], ['extra', '#c56e4666'], ['miss', '#65798e55']]) { c.fillStyle = color; c.fill(retainedPath(focused[key]), 'nonzero'); }
      else if (r.target && r.players.length > 1) { c.fillStyle = '#3e654e24'; c.fill(retainedPath(r.target), 'nonzero'); }
      for (const p of r.players) if (!r.focus || r.focus === p.id) this.line(p.points, p.color, false, !r.target && !r.targetPoint);
      if (r.target) {
        if (!focused && r.players.length > 1) { c.strokeStyle = '#ffffffcc'; c.lineWidth = 4.6 * px; c.setLineDash([8 * px, 5 * px]); c.stroke(retainedPath(r.target)); }
        c.strokeStyle = '#3e654e'; c.lineWidth = 2.6 * px; c.setLineDash([8 * px, 5 * px]); c.stroke(retainedPath(r.target)); c.setLineDash([]);
      }
      if (!r.focus && r.players.length > 1 && c.fillText) {
        c.save(); c.setTransform(d, 0, 0, d, 0, 0);
        c.font = '700 11px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
        c.textBaseline = 'middle';
        const placed = [];
        for (const p of r.players) {
          if (!p.points?.length || !p.name) continue;
          let top = p.points[0];
          for (const pt of p.points) if (pt[1] > top[1]) top = pt;
          let sx = this.width / 2 + (top[0] - v.x) * v.scale;
          let sy = this.height / 2 - (top[1] - v.y) * v.scale - 14;
          const text = [...p.name].slice(0, 10).join('');
          const tw = (c.measureText ? c.measureText(text).width : text.length * 11) + 18;
          const th = 20;
          sx = Math.max(tw / 2 + 6, Math.min(this.width - tw / 2 - 6, sx));
          sy = Math.max(th / 2 + 6, Math.min(this.height - th / 2 - 6, sy));
          const initialY = sy;
          for (let tries = 1; tries <= r.players.length * 2 && placed.some(b => Math.abs(sx - b.x) < (tw + b.w) / 2 + 4 && Math.abs(sy - b.y) < th + 3); tries++) {
            const offset = Math.ceil(tries / 2) * (tries % 2 ? 1 : -1) * (th + 4);
            sy = Math.max(th / 2 + 6, Math.min(this.height - th / 2 - 6, initialY + offset));
          }
          placed.push({ x: sx, y: sy, w: tw });
          const x0 = sx - tw / 2, y0 = sy - th / 2;
          c.fillStyle = '#fbfaf6f2';
          c.strokeStyle = p.color || '#1f2a23';
          c.lineWidth = 1.5;
          c.beginPath();
          if (c.roundRect) c.roundRect(x0, y0, tw, th, 10);
          else c.rect(x0, y0, tw, th);
          c.fill(); c.stroke();
          c.fillStyle = p.color || '#1f2a23';
          c.beginPath(); c.arc(x0 + 8, sy, 3.2, 0, Math.PI * 2); c.fill();
          c.fillText(text, x0 + 14, sy + 0.5);
        }
        c.restore();
      }
      drawLandmarkTarget(c, r.targetPoint, r.landmark, v.scale);
    } else this.line(this.points, this.strokeColor || '#c56e46', false, true, !this.gesture?.drawing && !this.keyboardDrawing);
    if (document.activeElement === this.canvas && this.mode === 'draw' && this.editable) {
      const [x, y] = this.cursor; c.beginPath(); c.moveTo(x - 8 * px, y); c.lineTo(x + 8 * px, y); c.moveTo(x, y - 8 * px); c.lineTo(x, y + 8 * px); c.strokeStyle = '#3e654e'; c.lineWidth = 1.5 * px; c.stroke();
    }
  }
}
