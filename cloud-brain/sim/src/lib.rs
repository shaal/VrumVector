//! The game's deterministic core (X1 of docs/plan/cloud-brain.md): one AI
//! car driven by a 10-16-4 network on a track, as the browser's trial worker
//! (AI-Car-Racer/learning/trial-worker.js) runs it: the car alone, sensors
//! and network every frame (no stride), the canonical start pose. Each part
//! is a line-by-line port of AI-Car-Racer's JavaScript, statement order and
//! float evaluation order kept (no fused multiply-adds):
//!
//! - `Car::step`: `Car#update` (car.js): `#move`, the polygon, walls,
//!   checkpoints and laps, then the rays (sensor.js), the network
//!   (network.js) and the driving style (driver/profiles.js `apply`).
//! - `Grid`: `SpatialGrid` (spatialGrid.js), whose query order decides which
//!   checkpoint a car touching two is counted at.
//! - `Track::start`: `computeStartInfoInPlace` (main.js).
//!
//! Float storage follows the JavaScript: the network's inputs, weights,
//! biases and hidden outputs are Float32Array values, the arithmetic on them
//! is double precision. The math functions are `jsmath`'s (V8's `hypot` and
//! `tanh`; `sin`, `cos`, `atan2` within 1 ulp of V8's), so a trajectory can
//! part from the browser's where a decision sits within about 1e-15 of its
//! threshold (docs/validation/cloud-brain.md, X1).

pub mod jsmath;

use jsmath::{cos, hypot, sin};

/// Flat brain length and layout (brainCodec.js): level 0 biases (16) and
/// weights (10 × 16), level 1 biases (4) and weights (16 × 4).
pub const BRAIN_LEN: usize = 244;
const INPUTS: usize = 10;
const HIDDEN: usize = 16;
const OUTPUTS: usize = 4;
const RAYS: usize = 7;
const RAY_LENGTH: f64 = 400.0;
const CAR_WIDTH: f64 = 30.0;
const CAR_HEIGHT: f64 = 50.0;
const GRID_CELL: f64 = 200.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

pub type Segment = [Point; 2];

/// `lerp(A, B, t)` (utils.js).
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// `getIntersection(A, B, C, D)` (utils.js): the point of AB where it
/// crosses CD, and its offset along AB (0..1).
fn intersection(a: Point, b: Point, c: Point, d: Point) -> Option<(Point, f64)> {
    let t_top = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
    let u_top = (c.y - a.y) * (a.x - b.x) - (c.x - a.x) * (a.y - b.y);
    let bottom = (d.y - c.y) * (b.x - a.x) - (d.x - c.x) * (b.y - a.y);
    if bottom != 0.0 {
        let t = t_top / bottom;
        let u = u_top / bottom;
        if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
            return Some((Point { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }, t));
        }
    }
    None
}

/// `polysIntersect(poly1, poly2)` (utils.js), for a polygon and a segment
/// (a two-point polygon: both of its edge directions are tested).
fn polys_intersect(poly: &[Point], segment: &Segment) -> bool {
    for i in 0..poly.len() {
        for j in 0..2 {
            if intersection(poly[i], poly[(i + 1) % poly.len()], segment[j], segment[(j + 1) % 2]).is_some() {
                return true;
            }
        }
    }
    false
}

// ─── the grid ───────────────────────────────────────────────────────────────

/// `SpatialGrid` (spatialGrid.js) with 200 px cells: each cell lists the
/// segments whose bounding box touches it, in insertion order; a query
/// returns each segment once, in cell order then list order.
#[derive(Clone, Debug)]
pub struct Grid {
    cols: i64,
    rows: i64,
    cells: Vec<Vec<usize>>,
}

impl Grid {
    fn new(width: f64, height: f64, segments: &[Segment]) -> Grid {
        let cols = ((width / GRID_CELL).ceil() as i64).max(1);
        let rows = ((height / GRID_CELL).ceil() as i64).max(1);
        let mut grid = Grid { cols, rows, cells: vec![Vec::new(); (cols * rows) as usize] };
        for (index, s) in segments.iter().enumerate() {
            let (min_x, max_x) = (jsmath::min(s[0].x, s[1].x), jsmath::max(s[0].x, s[1].x));
            let (min_y, max_y) = (jsmath::min(s[0].y, s[1].y), jsmath::max(s[0].y, s[1].y));
            let (cx0, cx1) = (grid.clamp_x(min_x), grid.clamp_x(max_x));
            let (cy0, cy1) = (grid.clamp_y(min_y), grid.clamp_y(max_y));
            for cy in cy0..=cy1 {
                for cx in cx0..=cx1 {
                    grid.cells[(cy * cols + cx) as usize].push(index);
                }
            }
        }
        grid
    }
    // `_clamp(_toCell(v), 0, n - 1)` for finite coordinates.
    fn clamp(v: f64, n: i64) -> i64 {
        let cell = (v / GRID_CELL).floor();
        if cell < 0.0 {
            0
        } else if cell > (n - 1) as f64 {
            n - 1
        } else {
            cell as i64
        }
    }
    fn clamp_x(&self, v: f64) -> i64 {
        Grid::clamp(v, self.cols)
    }
    fn clamp_y(&self, v: f64) -> i64 {
        Grid::clamp(v, self.rows)
    }
    /// `queryAABB`: the segments of the cells the box touches, once each.
    fn query(&self, min_x: f64, min_y: f64, max_x: f64, max_y: f64, out: &mut Vec<usize>, seen: &mut [u32], epoch: &mut u32) {
        out.clear();
        // A NaN bound makes the JavaScript loops run no times.
        if [min_x, min_y, max_x, max_y].iter().any(|v| v.is_nan()) {
            return;
        }
        *epoch = epoch.wrapping_add(1);
        let (cx0, cx1) = (self.clamp_x(min_x), self.clamp_x(max_x));
        let (cy0, cy1) = (self.clamp_y(min_y), self.clamp_y(max_y));
        for cy in cy0..=cy1 {
            for cx in cx0..=cx1 {
                for &id in &self.cells[(cy * self.cols + cx) as usize] {
                    if seen[id] != *epoch {
                        seen[id] = *epoch;
                        out.push(id);
                    }
                }
            }
        }
    }
}

// ─── the track ──────────────────────────────────────────────────────────────

/// A car's starting pose.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
}

/// A track as road.js builds it: the four canvas edges, then the inner and
/// the outer loop as wall segments; the checkpoints (gates) in order.
#[derive(Clone, Debug)]
pub struct Track {
    pub width: f64,
    pub height: f64,
    pub borders: Vec<Segment>,
    pub checkpoints: Vec<Segment>,
    border_grid: Grid,
    cp_grid: Grid,
}

impl Track {
    pub fn new(width: f64, height: f64, inner: &[Point], outer: &[Point], checkpoints: &[Segment]) -> Track {
        let p = |x, y| Point { x, y };
        let mut borders = vec![
            [p(0.0, 0.0), p(0.0, height)],
            [p(width, 0.0), p(width, height)],
            [p(0.0, 0.0), p(width, 0.0)],
            [p(0.0, height), p(width, height)],
        ];
        for lp in [inner, outer] {
            for i in 0..lp.len() {
                borders.push([lp[i], lp[(i + 1) % lp.len()]]);
            }
        }
        let border_grid = Grid::new(width, height, &borders);
        let cp_grid = Grid::new(width, height, checkpoints);
        Track { width, height, borders, checkpoints: checkpoints.to_vec(), border_grid, cp_grid }
    }

    /// `computeStartInfoInPlace` (main.js): just shy of gate 0, facing the
    /// middle of gate 1 (or across gate 0 when it is the only gate). None
    /// without a gate.
    pub fn start(&self) -> Option<Pose> {
        let g0 = self.checkpoints.first()?;
        let mx = (g0[0].x + g0[1].x) / 2.0;
        let my = (g0[0].y + g0[1].y) / 2.0;
        let (hx, hy) = match self.checkpoints.get(1) {
            Some(g1) => ((g1[0].x + g1[1].x) / 2.0 - mx, (g1[0].y + g1[1].y) / 2.0 - my),
            None => (-(g0[1].y - g0[0].y), g0[1].x - g0[0].x),
        };
        let angle = jsmath::atan2(-hx, -hy);
        let len = (hx * hx + hy * hy).sqrt();
        let offset = jsmath::min(20.0, len * 0.05);
        let x = mx - if len > 0.0 { hx / len * offset } else { 0.0 };
        let y = my - if len > 0.0 { hy / len * offset } else { 0.0 };
        Some(Pose { x, y, angle })
    }
}

// ─── the network ────────────────────────────────────────────────────────────

/// The 10-16-4 network (network.js): Float32Array storage, double
/// arithmetic; tanh on the hidden level, `sum > bias` on the output level.
#[derive(Clone, Debug)]
pub struct Brain {
    b0: [f32; HIDDEN],
    w0: [f32; INPUTS * HIDDEN],
    b1: [f32; OUTPUTS],
    w1: [f32; HIDDEN * OUTPUTS],
}

impl Brain {
    /// A flat brain (brainCodec.js's order); None unless 244 values.
    pub fn from_flat(flat: &[f32]) -> Option<Brain> {
        if flat.len() != BRAIN_LEN {
            return None;
        }
        let mut b = Brain { b0: [0.0; HIDDEN], w0: [0.0; INPUTS * HIDDEN], b1: [0.0; OUTPUTS], w1: [0.0; HIDDEN * OUTPUTS] };
        let mut at = 0;
        for dst in [&mut b.b0[..], &mut b.w0[..], &mut b.b1[..], &mut b.w1[..]] {
            dst.copy_from_slice(&flat[at..at + dst.len()]);
            at += dst.len();
        }
        Some(b)
    }

    /// `NeuralNetwork.feedForward`: the four controls, and the output
    /// level's margins (sum - bias: how far each decision was from flipping).
    pub fn decide(&self, given: &[f64; INPUTS]) -> ([bool; OUTPUTS], [f64; OUTPUTS]) {
        let mut inputs = [0f32; INPUTS];
        for (i, v) in given.iter().enumerate() {
            inputs[i] = *v as f32;
        }
        let mut hidden = [0f32; HIDDEN];
        for (i, h) in hidden.iter_mut().enumerate() {
            let mut sum = 0.0f64;
            for (j, input) in inputs.iter().enumerate() {
                sum += f64::from(*input) * f64::from(self.w0[j * HIDDEN + i]);
            }
            *h = jsmath::tanh(sum - f64::from(self.b0[i])) as f32;
        }
        let (mut out, mut margin) = ([false; OUTPUTS], [0f64; OUTPUTS]);
        for i in 0..OUTPUTS {
            let mut sum = 0.0f64;
            for (j, h) in hidden.iter().enumerate() {
                sum += f64::from(*h) * f64::from(self.w1[j * OUTPUTS + i]);
            }
            margin[i] = sum - f64::from(self.b1[i]);
            out[i] = sum > f64::from(self.b1[i]);
        }
        (out, margin)
    }
}

// ─── driving styles ─────────────────────────────────────────────────────────

/// The driving styles (driver/profiles.js). A style changes the network's
/// decisions, never the physics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Balanced,
    Calm,
    Careful,
    Wild,
    Reckless,
}

struct Style {
    pace: f64,
    corner: f64,
    braking: f64,
    patience: i64,
}

impl Profile {
    /// A profile by id; anything else is Balanced (DriverProfiles.get).
    pub fn from_id(id: &str) -> Profile {
        match id {
            "calm" => Profile::Calm,
            "careful" => Profile::Careful,
            "wild" => Profile::Wild,
            "reckless" => Profile::Reckless,
            _ => Profile::Balanced,
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Profile::Balanced => "balanced",
            Profile::Calm => "calm",
            Profile::Careful => "careful",
            Profile::Wild => "wild",
            Profile::Reckless => "reckless",
        }
    }
    fn style(self) -> Option<Style> {
        match self {
            Profile::Balanced | Profile::Reckless => None,
            Profile::Calm => Some(Style { pace: 0.55, corner: 0.40, braking: 1.15, patience: 5 }),
            Profile::Careful => Some(Style { pace: 0.42, corner: 0.30, braking: 1.65, patience: 3 }),
            Profile::Wild => Some(Style { pace: 0.96, corner: 0.85, braking: 0.45, patience: 1 }),
        }
    }
}

// ─── the car ────────────────────────────────────────────────────────────────

/// Physics settings of a run (the learning context's).
#[derive(Clone, Copy, Debug)]
pub struct Settings {
    pub max_speed: f64,
    pub traction: f64,
    pub profile: Profile,
}

/// One AI car (car.js), with its sensor readings and style state.
#[derive(Clone, Debug)]
pub struct Car {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub speed: f64,
    pub vx: f64,
    pub vy: f64,
    pub slide: bool,
    pub damaged: bool,
    pub checkpoints: u32,
    pub passed: Vec<usize>,
    pub laps: u32,
    /// The frame each lap was completed at.
    pub lap_frames: Vec<u64>,
    /// forward, left, right, reverse: set by the last perception.
    pub controls: [bool; 4],
    /// The output level's margins at the last perception.
    pub margins: [f64; 4],
    /// The rays' readings (offset along the ray, 0..1; None: nothing).
    pub readings: [Option<f64>; RAYS],
    polygon: [Point; 3],
    acceleration: f64,
    break_accel: f64,
    max_speed: f64,
    friction: f64,
    slide_speed: f64,
    traction: f64,
    profile: Profile,
    style_turn: i8,
    style_age: i64,
    brain: Brain,
    scratch: Vec<usize>,
    seen: Vec<u32>,
    epoch: u32,
    /// Segments the grid queries returned so far: what the run cost (a ray
    /// or the wall test examines each one).
    pub work: u64,
}

/// `Car.polygonAt(x, y, angle, 30, 50)`: a long triangle, tip at the rear.
fn polygon_at(x: f64, y: f64, angle: f64) -> [Point; 3] {
    let (half_len, half_wid) = (CAR_HEIGHT / 2.0, CAR_WIDTH / 2.0);
    let (fx, fy, rx, ry) = (sin(angle), cos(angle), cos(angle), -sin(angle));
    [
        Point { x: x + fx * half_len, y: y + fy * half_len },
        Point { x: x - fx * half_len + rx * half_wid, y: y - fy * half_len + ry * half_wid },
        Point { x: x - fx * half_len - rx * half_wid, y: y - fy * half_len - ry * half_wid },
    ]
}

impl Car {
    pub fn new(pose: Pose, brain: Brain, settings: Settings, track: &Track) -> Car {
        let m = settings.max_speed;
        let segments = track.borders.len().max(track.checkpoints.len());
        Car {
            x: pose.x,
            y: pose.y,
            angle: pose.angle,
            speed: 0.0,
            vx: 0.0,
            vy: 0.0,
            slide: false,
            damaged: false,
            checkpoints: 0,
            passed: Vec::new(),
            laps: 0,
            lap_frames: Vec::new(),
            controls: [false; 4],
            margins: [0.0; 4],
            readings: [None; RAYS],
            polygon: polygon_at(pose.x, pose.y, pose.angle),
            acceleration: m / 50.0,
            break_accel: m / 60.0,
            max_speed: m,
            friction: 0.02,
            slide_speed: settings.traction * m,
            traction: settings.traction,
            profile: settings.profile,
            style_turn: 0,
            style_age: 99,
            brain,
            scratch: Vec::new(),
            seen: vec![0; segments.max(1)],
            epoch: 0,
            work: 0,
        }
    }

    /// Progress as the game scores it: gates passed plus laps × gates.
    pub fn fitness(&self, gates: usize) -> f64 {
        f64::from(self.checkpoints) + f64::from(self.laps) * gates as f64
    }

    /// One frame (`Car#update` at `frameCount` = `frame`): physics, walls,
    /// checkpoints; then, unless crashed before this frame, perception.
    pub fn step(&mut self, frame: u64, track: &Track) {
        if self.damaged {
            return;
        }
        self.drive();
        self.polygon = polygon_at(self.x, self.y, self.angle);
        self.damaged = self.hits_wall(track);
        if let Some(cp) = self.touched_checkpoint(track) {
            let first = self.passed.first().copied();
            let seen = self.passed.contains(&cp);
            if !seen || Some(cp) == first {
                if !seen {
                    self.checkpoints += 1;
                }
                if self.checkpoints as usize >= track.checkpoints.len() && Some(cp) == first {
                    self.checkpoints = 1;
                    self.laps += 1;
                    self.lap_frames.push(frame);
                    self.passed.truncate(1);
                }
                self.passed.push(cp);
            }
        }
        self.perceive(track);
    }

    fn hits_wall(&mut self, track: &Track) -> bool {
        self.query_polygon(&track.border_grid);
        let ids = std::mem::take(&mut self.scratch);
        let hit = ids.iter().any(|&i| polys_intersect(&self.polygon, &track.borders[i]));
        self.scratch = ids;
        hit
    }

    fn touched_checkpoint(&mut self, track: &Track) -> Option<usize> {
        self.query_polygon(&track.cp_grid);
        let ids = std::mem::take(&mut self.scratch);
        let found = ids.iter().copied().find(|&i| i < track.checkpoints.len() && polys_intersect(&self.polygon, &track.checkpoints[i]));
        self.scratch = ids;
        found
    }

    /// `queryPolygon` for the car's polygon.
    fn query_polygon(&mut self, grid: &Grid) {
        let (mut min_x, mut max_x, mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for p in &self.polygon {
            if p.x < min_x {
                min_x = p.x;
            }
            if p.x > max_x {
                max_x = p.x;
            }
            if p.y < min_y {
                min_y = p.y;
            }
            if p.y > max_y {
                max_y = p.y;
            }
        }
        grid.query(min_x, min_y, max_x, max_y, &mut self.scratch, &mut self.seen, &mut self.epoch);
        self.work += self.scratch.len() as u64;
    }

    /// The rays (sensor.js), the network's inputs, the network, the style.
    fn perceive(&mut self, track: &Track) {
        let spread = std::f64::consts::PI / 1.5;
        let mut inputs = [0f64; INPUTS];
        for i in 0..RAYS {
            let angle = lerp(spread / 2.0, -spread / 2.0, i as f64 / (RAYS - 1) as f64) + self.angle;
            let start = Point { x: self.x, y: self.y };
            let end = Point { x: self.x - sin(angle) * RAY_LENGTH, y: self.y - cos(angle) * RAY_LENGTH };
            let (min_x, max_x) = (jsmath::min(start.x, end.x), jsmath::max(start.x, end.x));
            let (min_y, max_y) = (jsmath::min(start.y, end.y), jsmath::max(start.y, end.y));
            track.border_grid.query(min_x, min_y, max_x, max_y, &mut self.scratch, &mut self.seen, &mut self.epoch);
            self.work += self.scratch.len() as u64;
            let mut best: Option<f64> = None;
            let mut best_offset = f64::INFINITY;
            for &id in &self.scratch {
                let b = &track.borders[id];
                if let Some((_, offset)) = intersection(start, end, b[0], b[1]) {
                    if offset < best_offset {
                        best = Some(offset);
                        best_offset = offset;
                    }
                }
            }
            self.readings[i] = best;
            inputs[i] = best.map_or(0.0, |offset| 1.0 - offset);
        }
        inputs[RAYS] = self.speed / self.max_speed;
        // The direction to the next gate's middle in the car's frame, over
        // the canvas diagonal.
        let (mut lf, mut lr) = (0.0, 0.0);
        if !track.checkpoints.is_empty() {
            let next = match self.passed.last() {
                None => 0,
                Some(last) => (last + 1) % track.checkpoints.len(),
            };
            let cp = track.checkpoints[next];
            let mx = (cp[0].x + cp[1].x) * 0.5;
            let my = (cp[0].y + cp[1].y) * 0.5;
            let (dx, dy) = (mx - self.x, my - self.y);
            let (s, c) = (sin(self.angle), cos(self.angle));
            let lf_raw = dx * s + dy * c;
            let lr_raw = dx * c - dy * s;
            let d = hypot(track.width, track.height);
            lf = lf_raw / d;
            lr = lr_raw / d;
        }
        inputs[RAYS + 1] = lf;
        inputs[RAYS + 2] = lr;
        let (raw, margins) = self.brain.decide(&inputs);
        self.margins = margins;
        self.controls = self.styled(raw);
    }

    /// DriverProfiles.apply: a style damps quick opposite turns and brakes
    /// over its pace or short of a wall ahead.
    fn styled(&mut self, raw: [bool; 4]) -> [bool; 4] {
        let Some(p) = self.profile.style() else { return raw };
        let mut out = raw;
        let turn: i8 = if out[1] == out[2] {
            0
        } else if out[1] {
            1
        } else {
            -1
        };
        self.style_age += 1;
        if turn != self.style_turn {
            if turn != 0 && self.style_turn != 0 && self.style_age < p.patience {
                out[1] = self.style_turn > 0;
                out[2] = self.style_turn < 0;
            } else {
                self.style_turn = turn;
                self.style_age = 0;
            }
        }
        let turning = out[1] != out[2];
        let speed = jsmath::max(0.0, if self.speed.is_nan() { 0.0 } else { self.speed });
        let target = self.max_speed * if turning { p.corner } else { p.pace };
        let mut clearance = f64::INFINITY;
        let mid = RAYS / 2;
        for reading in self.readings[mid - 1..=mid + 1].iter().flatten() {
            clearance = jsmath::min(clearance, reading * RAY_LENGTH);
        }
        let stopping = CAR_HEIGHT * 0.6 + p.braking * speed * speed / (2.0 * jsmath::max(0.05, self.break_accel + speed * 0.02));
        let brake = speed > target + 0.15 || (p.braking > 0.0 && speed > 0.5 && clearance < stopping);
        if brake {
            out[0] = false;
            out[3] = true;
        }
        out
    }

    /// `Car#move`.
    fn drive(&mut self) {
        let [forward, left, right, reverse] = self.controls;
        if forward {
            self.speed += self.acceleration;
            self.vx += sin(self.angle) * self.acceleration;
            self.vy += cos(self.angle) * self.acceleration;
        }
        if reverse && (!self.slide || self.speed > 0.5) {
            self.speed -= self.break_accel;
            self.vx -= sin(self.angle) * self.break_accel;
            self.vy -= cos(self.angle) * self.break_accel;
        }
        if self.speed != 0.0 {
            let flip = if self.speed > 0.0 { 1.0 } else { -1.0 };
            if left {
                if self.speed.abs() > self.slide_speed {
                    self.slide = true;
                }
                self.angle += 0.03 * flip;
            }
            if right {
                if self.speed.abs() > self.slide_speed {
                    self.slide = true;
                }
                self.angle -= 0.03 * flip;
            }
        }
        // Top speed.
        if hypot(self.vx, self.vy) > self.max_speed {
            let scalar = self.max_speed / hypot(self.vx, self.vy);
            self.vx *= scalar;
            self.vy *= scalar;
            self.speed = self.max_speed;
        } else if self.speed < -self.max_speed / 2.0 {
            let magnitude = hypot(self.vx, self.vy);
            self.speed = -self.max_speed / 2.0;
            if magnitude > 0.0 {
                let scalar = (self.max_speed / 2.0) / magnitude;
                self.vx *= scalar;
                self.vy *= scalar;
            } else {
                self.vx = self.speed * sin(self.angle);
                self.vy = self.speed * cos(self.angle);
            }
        }
        // Sliding or not.
        if self.slide {
            let rate = (self.traction / 2.0 + 0.5) * self.max_speed / (self.speed.abs() + 0.001) * 0.02;
            self.vx = lerp(self.vx, self.speed * sin(self.angle), rate);
            self.vy = lerp(self.vy, self.speed * cos(self.angle), rate);
            let magnitude = hypot(self.vx, self.vy);
            if magnitude > 0.0 {
                let scalar = self.speed.abs() / magnitude;
                self.vx *= scalar;
                self.vy *= scalar;
            } else {
                self.vx = self.speed * sin(self.angle);
                self.vy = self.speed * cos(self.angle);
            }
        } else {
            self.vx = self.speed * sin(self.angle);
            self.vy = self.speed * cos(self.angle);
        }
        // End a slide when not steering (especially braking), or when the
        // velocity is close enough to the heading (the y test reads sin, as
        // car.js does).
        if !left && !right && self.speed < 0.9 * self.slide_speed {
            self.slide = false;
        }
        if self.slide
            && (self.vx.abs() - self.speed * sin(self.angle)).abs() < 0.02
            && (self.vy.abs() - self.speed * sin(self.angle)).abs() < 0.02
        {
            self.slide = false;
        }
        // Friction when sliding, drag when not.
        if self.slide && hypot(self.vx, self.vy) != 0.0 {
            let scalar = self.speed.abs() / hypot(self.vx, self.vy);
            self.vx *= scalar;
            self.vy *= scalar;
        } else if self.speed != 0.0 {
            let wind = 0.001 * (self.speed * sin(self.angle) * self.vx + self.speed * cos(self.angle) * self.vy);
            self.speed -= jsmath::sign(self.speed) * wind;
            self.vx -= wind * sin(self.angle);
            self.vy -= wind * cos(self.angle);
        }
        // Too slow.
        if self.speed.abs() > self.acceleration / 2.0 && self.speed > 0.0 {
            self.vx *= 1.0 - self.friction;
            self.vy *= 1.0 - self.friction;
            self.speed *= 1.0 - self.friction;
        } else if self.speed > 0.0 {
            self.vx = 0.0;
            self.vy = 0.0;
            self.speed = 0.0;
        }
        self.x -= self.vx;
        self.y -= self.vy;
    }
}

// ─── a run ──────────────────────────────────────────────────────────────────

/// How a run ended.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    /// Gates passed plus laps × gates.
    pub fitness: f64,
    pub laps: u32,
    /// The frame each lap was completed at.
    pub lap_frames: Vec<u64>,
    /// The frame the car crashed at, if it did.
    pub crashed_at: Option<u64>,
    /// Frames simulated (a crashed car stops changing: the run ends there).
    pub frames: u64,
    /// Segments examined (`Car::work`).
    pub work: u64,
    /// Stopped past the work budget (`run_within`): the outcome is partial.
    pub over_budget: bool,
}

/// Runs a brain alone on a track for `frames` frames (60 a second) from
/// `pose`, calling `observe` after each frame. Stops early when the car
/// crashes: a crashed car never changes again.
pub fn run(track: &Track, pose: Pose, brain: Brain, settings: Settings, frames: u64, observe: impl FnMut(u64, &Car)) -> Outcome {
    run_within(track, pose, brain, settings, frames, u64::MAX, observe)
}

/// `run`, stopped (`over_budget`) once the car has examined more than
/// `budget` segments: what bounds the cost of a track made to be costly.
pub fn run_within(track: &Track, pose: Pose, brain: Brain, settings: Settings, frames: u64, budget: u64, mut observe: impl FnMut(u64, &Car)) -> Outcome {
    let mut car = Car::new(pose, brain, settings, track);
    let mut done = 0;
    let mut crashed_at = None;
    let mut over_budget = false;
    for frame in 1..=frames {
        car.step(frame, track);
        done = frame;
        observe(frame, &car);
        if car.damaged {
            crashed_at = Some(frame);
            break;
        }
        if car.work > budget {
            over_budget = true;
            break;
        }
    }
    Outcome { fitness: car.fitness(track.checkpoints.len()), laps: car.laps, lap_frames: car.lap_frames.clone(), crashed_at, frames: done, work: car.work, over_budget }
}
