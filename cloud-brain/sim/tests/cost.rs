//! What a verification can cost the service at most: the largest track a
//! verification accepts (two loops of 256 points, 64 gates, on the game's
//! 3200 × 1800 canvas), every wall and gate within the sensors' reach of a
//! car that never moves (so it never crashes) for the longest run (120 s).
//! Two shapes: walls zigzagging across the canvas above and below the car,
//! and walls and gates as long diagonals over every grid cell, with two tiny
//! gates inside the car (it never reaches the next one).

use vectorvroom_sim::{run, run_within, Brain, Point, Profile, Settings, Track};

const W: f64 = 3_200.0;
const H: f64 = 1_800.0;

/// Walls: two zigzags of long segments across the canvas, 200 px above and
/// below the car. Gates: 64 short ones around it (two set its start).
pub fn zigzags() -> Track {
    let zigzag = |y: f64| -> Vec<Point> { (0..256).map(|i| Point { x: if i % 2 == 0 { 0.0 } else { W }, y: y + i as f64 * 0.01 }).collect() };
    let mut gates = vec![[Point { x: 1600.0, y: 400.0 }, Point { x: 1600.0, y: 600.0 }], [Point { x: 1700.0, y: 400.0 }, Point { x: 1700.0, y: 600.0 }]];
    gates.extend((0..62).map(|i| [Point { x: 1300.0 + i as f64 * 10.0, y: 420.0 }, Point { x: 1300.0 + i as f64 * 10.0, y: 440.0 }]));
    Track::new(W, H, &zigzag(300.0), &zigzag(700.0), &gates)
}

/// Walls and 62 gates as diagonals from corner to corner, off the canvas
/// (every cell holds them all), crossing far from the car; its two gates
/// are a pixel long, inside it.
pub fn diagonals() -> Track {
    let far = 99_900.0;
    let diagonal = |i: usize| -> Point {
        let t = i as f64 / 255.0;
        if i % 2 == 0 { Point { x: -far, y: -far + t } } else { Point { x: far, y: far + t } }
    };
    let walls: Vec<Point> = (0..256).map(diagonal).collect();
    let other: Vec<Point> = (0..256).map(|i| { let p = diagonal(i); Point { x: p.x, y: -p.y } }).collect();
    let mut gates = vec![[Point { x: 2600.0, y: 300.0 }, Point { x: 2600.0, y: 301.0 }], [Point { x: 2601.0, y: 300.0 }, Point { x: 2601.0, y: 301.0 }]];
    gates.extend((0..62).map(|i| [Point { x: -far, y: -far + i as f64 }, Point { x: far, y: far + i as f64 }]));
    Track::new(W, H, &walls, &other, &gates)
}

/// A brain whose outputs are always off: the car stays where it starts.
pub fn parked() -> Brain {
    let mut flat = vec![0.0f32; 244];
    // Layer 1's biases (after layer 0's 16 biases and 160 weights).
    flat[176..180].fill(1.0);
    Brain::from_flat(&flat).unwrap()
}

fn settings() -> Settings {
    Settings { max_speed: 15.0, traction: 0.5, profile: Profile::from_id("balanced") }
}

#[test]
fn the_costliest_tracks_run_to_the_end() {
    for (name, track) in [("zigzags", zigzags()), ("diagonals", diagonals())] {
        let outcome = run(&track, track.start().unwrap(), parked(), settings(), 600, |_, _| {});
        assert_eq!((outcome.frames, outcome.crashed_at), (600, None), "{name}: a car that never crashes");
    }
}

#[test]
#[ignore = "a timing probe: cargo test --release -p vectorvroom-sim --test cost -- --ignored --nocapture"]
fn how_long_the_costliest_verification_takes() {
    for (name, make) in [("zigzags", zigzags as fn() -> Track), ("diagonals", diagonals)] {
        let mut best = f64::MAX;
        for _ in 0..5 {
            let started = std::time::Instant::now();
            let track = make();
            let outcome = run(&track, track.start().unwrap(), parked(), settings(), 7_200, |_, _| {});
            assert_eq!(outcome.frames, 7_200);
            best = best.min(started.elapsed().as_secs_f64());
        }
        let work = run(&make(), make().start().unwrap(), parked(), settings(), 7_200, |_, _| {}).work;
        eprintln!("{name}: 7 200 frames in {:.0} ms (best of 5, the track built too), {work} segments examined ({:.1} ns each)", best * 1e3, best * 1e9 / work as f64);
        // As the service runs it: stopped past 600 segments a frame on average.
        let started = std::time::Instant::now();
        let track = make();
        let bounded = run_within(&track, track.start().unwrap(), parked(), settings(), 7_200, 7_200 * 600, |_, _| {});
        assert!(bounded.over_budget);
        eprintln!("{name}, within the service's budget: stopped at frame {} after {:.0} ms", bounded.frames, started.elapsed().as_secs_f64() * 1e3);
    }
}

#[test]
fn a_run_beats_another_by_fitness_then_by_its_first_lap_and_keeps_lap_times_as_car_js() {
    let o = |fitness: f64, laps: &[u64]| vectorvroom_sim::Outcome { fitness, laps: laps.len() as u32, lap_frames: laps.to_vec(), crashed_at: None, frames: 1200, work: 0, over_budget: false };
    assert!(o(7.0, &[]).beats(&o(6.0, &[998])));
    assert!(o(6.0, &[900]).beats(&o(6.0, &[998])) && !o(6.0, &[998]).beats(&o(6.0, &[900])));
    assert!(o(6.0, &[998]).beats(&o(6.0, &[])), "a lap before none");
    assert!(!o(6.0, &[998]).beats(&o(6.0, &[998])));
    // car.js: [round2(607/60)] = [10.12], then round2(1214/60 - 10.12) = 10.11.
    assert_eq!(o(10.0, &[607, 1214]).fastest_lap(), Some(10.11));
    assert_eq!(o(10.0, &[998]).fastest_lap(), Some(16.63));
    assert_eq!(o(0.0, &[]).fastest_lap(), None);
}
