// Classic worker script. Presentation-only, bounded at ~1.1 MB per generation.
// Sample a fixed, evenly distributed cohort; never splice different drivers.
(function (root) {
  class PresentationRecorder {
    constructor(cars, enabled) {
      this.limit = 2401; // first two minutes, 20 samples / simulated second
      this.count = 0;
      this.lastFrame = -1;
      this.truncated = false;
      this.entries = [];
      if (enabled && cars.length) {
        const n = Math.min(16, cars.length);
        for (let i = 0; i < n; i++) {
          const index = n === 1 ? 0 : Math.floor(i * (cars.length - 1) / (n - 1));
          this.entries.push({ index, car: cars[index], data: new Float32Array(this.limit * 7) });
        }
      }
    }
    capture(frame, force = false) {
      if (!this.entries.length || frame === this.lastFrame || (!force && frame % 3 !== 0)) return;
      if (this.count === this.limit) { this.truncated = true; return; }
      const offset = this.count++ * 7;
      this.lastFrame = frame;
      for (const { car: c, data: d } of this.entries) {
        const controls = c.controls || {};
        d[offset] = frame; d[offset + 1] = c.x; d[offset + 2] = c.y;
        d[offset + 3] = c.angle; d[offset + 4] = c.speed;
        d[offset + 5] = (+!!controls.forward) | (+!!controls.left << 1) | (+!!controls.right << 2) | (+!!controls.reverse << 3);
        d[offset + 6] = +!!c.damaged;
      }
    }
    finish(checkpointCount) {
      if (!this.entries.length || this.count < 2) return null;
      let winner = this.entries[0], best = -Infinity;
      for (const entry of this.entries) {
        const fit = entry.car.checkPointsCount + entry.car.laps * checkpointCount;
        if (fit > best) { best = fit; winner = entry; }
      }
      let count = this.count;
      // Stop shortly after a crash instead of replaying a stationary car.
      for (let i = 0; i < count; i++) if (winner.data[i * 7 + 6]) { count = Math.min(count, i + 11); break; }
      return { samples: winner.data.slice(0, count * 7), driverIndex: winner.index,
        candidates: this.entries.length, fitness: best, laps: winner.car.laps,
        truncated: this.truncated, sampleRate: 20 };
    }
  }
  root.PresentationRecorder = PresentationRecorder;
})(globalThis);
