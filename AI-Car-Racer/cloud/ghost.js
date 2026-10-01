// cloud/ghost.js — race the cloud champion (docs/plan/cloud-brain.md, X3).
// In shared mode the best brain the shared pool holds for this track drives
// a ghost car next to yours: simulated here from its weights, as the trial
// worker drives a car (car.js, sensors every frame), from the same start
// pose and with the same physics as your car. It never collides with your
// car, never trains and is never scored. main.js steps it with your cars
// while the AI trains, draws it, and starts it over with them; the 3D view
// places it from `pose()`.

/** Frames a crashed ghost waits before it starts over (as your car does). */
export const RESPAWN_FRAMES = 40;

/**
 * The champion among what this page pulled, for the track whose key is
 * `track` (the learning context's): the fastest verified first lap on this
 * track's leaderboard whose brain the last pull brought (it can be driven
 * here), else the pool's best that learned on this track (a pool holds the
 * nearest tracks' brains, which may be other tracks'). `board`: wire.js
 * parseLeaderboardResponse's answer or null; `pool`: the recall entries
 * ({id, vector, meta, fitness}). Returns {id, vector, profile, lapFrames
 * (the verified first lap, or null), from: 'leaderboard' | 'pool'} or null.
 */
export function chooseChampion(board, pool, track) {
  if (!Array.isArray(pool) || !pool.length || !track) return null;
  const drivable = pool.filter(p => p?.vector?.length === 244);
  const byId = new Map(drivable.map(p => [p.id, p]));
  if (board?.track === track) {
    for (const e of board.entries || []) {
      const held = byId.get(e.id);
      if (held) return {id: e.id, vector: held.vector, profile: e.profile, lapFrames: e.lapFrames, from: 'leaderboard'};
    }
  }
  const best = drivable.find(p => p.meta?.learning?.context?.track === track);
  if (!best) return null;
  return {id: best.id, vector: best.vector, profile: best.meta.learning.context.profile || 'balanced', lapFrames: null, from: 'pool'};
}

/**
 * The ghost. Everything it needs from the page is passed in (main.js's
 * globals in the app; a vm's in tests): `Car`, `inflate(flat)` (a network
 * from 244 weights), `road()`, `start()` ({x, y, heading}), `maxSpeed()`.
 */
export class Ghost {
  constructor({Car, inflate, road, start, maxSpeed}) {
    Object.assign(this, {Car, inflate, road, start, maxSpeed});
    this.champion = null;
    this.next = null;
    // The player's choice; it races while there is a champion.
    this.wanted = false;
    this.car = null;
    this.frames = 0;
    this.wrecked = 0;
    this.lapFrames = [];
  }

  get enabled() {
    return this.wanted && !!this.champion;
  }

  /**
   * The brain it drives (null: none for this track now; racing waits for
   * the next). Racing, another champion waits for the next start (it does
   * not jump in mid-lap); the same one (its lap time known now, say) never
   * restarts it.
   */
  setChampion(champion) {
    if (champion && champion.id === this.champion?.id) {
      this.champion = champion;
      this.next = null;
      return;
    }
    if (this.car && champion) {
      this.next = champion;
      return;
    }
    this.next = null;
    this.champion = champion || null;
    this.reset();
  }

  /** Race or not (the choice stays while champions come and go). */
  enable(on) {
    this.wanted = !!on;
    this.reset();
    return this.enabled;
  }

  /** Back to the start pose (with your cars, at each new run). */
  reset() {
    if (this.next) {
      this.champion = this.next;
      this.next = null;
    }
    this.car = null;
    this.frames = 0;
    this.wrecked = 0;
    this.lapFrames = [];
    if (!this.enabled) return;
    const s = this.start?.();
    if (!s || ![s.x, s.y].every(Number.isFinite)) return;
    const car = new this.Car(s.x, s.y, 30, 50, 'AI', this.maxSpeed(), s.heading || 0);
    car.brain = this.inflate(this.champion.vector);
    car.driverProfile = this.champion.profile || 'balanced';
    // Sensors every frame, as the service and the trial worker's best car
    // drive (a car past the sensor stride would drive another race).
    car.senseEveryFrame = true;
    this.car = car;
  }

  /** One frame, alongside your cars. A wreck starts over after a while. */
  step() {
    const r = this.road?.();
    if (!this.car || !r) return;
    if (this.car.damaged && ++this.wrecked >= RESPAWN_FRAMES) {
      this.reset();
      if (!this.car) return;
    }
    const laps = this.car.laps;
    this.car.update(r.borders, r.checkPointList);
    this.frames++;
    if (this.car.laps > laps) this.lapFrames.push(this.frames);
  }

  /** Its pose for the 3D view, or null. */
  pose() {
    const c = this.car;
    return c ? {x: c.x, y: c.y, angle: c.angle, speed: c.speed, damaged: !!c.damaged} : null;
  }

  /** Its laps so far: {laps, lapFrames, crashed, frames}. */
  status() {
    return {laps: this.lapFrames.length, lapFrames: [...this.lapFrames], crashed: !!this.car?.damaged, frames: this.frames};
  }

  /** Drawn translucent on the 2D canvas. */
  draw(ctx, color = '#B388FF') {
    if (!this.car || !ctx) return;
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = 0.45;
    this.car.draw(ctx, color);
    ctx.globalAlpha = alpha;
  }
}
