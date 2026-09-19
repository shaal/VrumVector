// Pure presentation math. These functions never write to simulation objects.
export const SCALE = 0.035;
export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const worldX = x => (x - 1600) * SCALE;
export const worldZ = y => (y - 900) * SCALE;
export const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
export const finitePose = p => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.angle);
export function interpolatePose(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    angle: a.angle + angleDelta(a.angle, b.angle) * t };
}
export function poseAt(positions, index) {
  const i = index * 5;
  const pose = { x: positions[i], y: positions[i + 1], angle: positions[i + 2],
    damaged: !!positions[i + 3], progress: positions[i + 4] };
  return finitePose(pose) ? pose : null;
}
export function pointInLoop(x, y, loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function distanceToLoop(x, y, loop) {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
    const t = len ? clamp(((x - a.x) * dx + (y - a.y) * dy) / len, 0, 1) : 0;
    best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
  }
  return best;
}
export function cleanLoop(points) {
  const out = [];
  for (const p of points || []) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [];
    if (!out.length || Math.hypot(p.x - out.at(-1).x, p.y - out.at(-1).y) > 0.01) out.push({ x: p.x, y: p.y });
  }
  if (out.length > 1 && Math.hypot(out[0].x - out.at(-1).x, out[0].y - out.at(-1).y) < 0.01) out.pop();
  return out;
}
export function trackKey(road) {
  return JSON.stringify([road.innerList, road.outerList, road.checkPointList]);
}
export function seededRandom(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6D2B79F5;
    let t = Math.imul(h ^ h >>> 15, 1 | h);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Retains two snapshots only. Identity includes the run serial, not merely the
// generation number (manual restarts can retain the same generation number).
export class SnapshotBuffer {
  reset() { this.previous = this.current = null; }
  push(snapshot, run, now) {
    if (snapshot === this.current?.snapshot) return false;
    const old = this.current;
    const continuous = old && old.run === run && old.snapshot.N === snapshot.N
      && snapshot.frameCount > old.snapshot.frameCount;
    this.previous = continuous ? old : null;
    this.current = { snapshot, run, at: now };
    return true;
  }
  pose(index, now, interpolate = true) {
    if (!this.current || !Number.isInteger(index) || index < 0 || index >= this.current.snapshot.N) return null;
    const b = poseAt(this.current.snapshot.positions, index), old = this.previous;
    if (!b || !interpolate || !old || b.damaged) return b;
    const a = poseAt(old.snapshot.positions, index);
    // Don't invent paths through corners when fast training skips a large span.
    if (!a || a.damaged || this.current.snapshot.frameCount - old.snapshot.frameCount > 12 || Math.hypot(a.x-b.x,a.y-b.y) > 150) return b;
    const t = clamp((now - this.current.at) / clamp(this.current.at - old.at, 16, 100), 0, 1);
    return { ...interpolatePose(a, b, t), damaged: b.damaged, progress: b.progress };
  }
}

// Replay samples have [frame, x, y, angle, speed, controls bitmask, damaged].
// Samples come from one fixed driver in the worker, never a stitched champion.
export function sampleRun(run, seconds) {
  if (!run?.samples?.length) return null;
  const data = run.samples, n = data.length / 7;
  const frame = clamp(seconds * 60, data[0], data[(n - 1) * 7]);
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (data[mid * 7] <= frame) lo = mid; else hi = mid; }
  const a = lo * 7, b = hi * 7;
  const discrete = frame >= data[b] ? b : a;
  const t = data[b] === data[a] ? 0 : (frame - data[a]) / (data[b] - data[a]);
  const pose = interpolatePose({x:data[a+1],y:data[a+2],angle:data[a+3]}, {x:data[b+1],y:data[b+2],angle:data[b+3]}, t);
  if (!finitePose(pose)) return null;
  return { ...pose, speed: data[discrete+4], controls: data[discrete+5], damaged: !!data[discrete+6] };
}
export class ReplayArchive {
  constructor() { this.runs = []; this.key = ''; }
  setTrack(key) { if (key !== this.key) { this.key = key; this.runs = []; } }
  add(run) {
    if (!run?.samples || run.samples.length < 14 || run.samples.length % 7 || !run.samples.every(Number.isFinite)) return false;
    this.runs.unshift({ ...run, duration: run.samples[run.samples.length - 7] / 60 });
    this.runs.length = Math.min(this.runs.length, 6);
    return true;
  }
}
