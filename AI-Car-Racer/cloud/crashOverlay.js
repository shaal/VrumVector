// cloud/crashOverlay.js — "where everyone crashes here" (docs/plan/
// cloud-brain.md, X4). Everyone's crash map for this track (16 × 9 cells over
// the 3200 × 1800 canvas, from cloud/session.js's recall) drawn under the
// cars on the flat view, when the Memory panel's toggle is on.

export const COLS = 16, ROWS = 9;

/**
 * The cells to draw: [{x, y, w, h, alpha}] for the cells with crashes, the
 * busiest at `max` alpha (a crash map holds log1p counts scaled to length 1:
 * cells compare by value). Empty without a map.
 */
export function crashCells(map, {width = 3200, height = 1800, max = 0.5} = {}) {
  if (!map || map.length !== COLS * ROWS) return [];
  let top = 0;
  for (const v of map) if (v > top) top = v;
  if (!(top > 0)) return [];
  const w = width / COLS, h = height / ROWS, out = [];
  for (let i = 0; i < map.length; i++) {
    if (!(map[i] > 0)) continue;
    out.push({x: (i % COLS) * w, y: Math.floor(i / COLS) * h, w, h, alpha: max * map[i] / top});
  }
  return out;
}

export class CrashOverlay {
  constructor() {
    this.map = null;
    this.shown = false;
  }
  /** Everyone's map for this track now (null: none). */
  set(map) {
    this.map = map || null;
  }
  show(on) {
    this.shown = !!on;
    return this.shown;
  }
  /** On the flat view, in world coordinates, under the cars. */
  draw(ctx, size) {
    if (!this.shown || !this.map || !ctx) return;
    const cells = crashCells(this.map, size);
    if (!cells.length) return;
    ctx.save();
    ctx.fillStyle = '#E53935';
    for (const c of cells) {
      ctx.globalAlpha = c.alpha;
      ctx.fillRect(c.x, c.y, c.w, c.h);
    }
    ctx.restore();
  }
}
