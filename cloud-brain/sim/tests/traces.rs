//! The port against the game itself: golden traces of the browser's scripts
//! run in Node (tests/fixtures/cloud-brain-sim/traces.json, made by
//! scripts/cloud-brain-sim-traces.mjs). Every case must give the same
//! controls every frame, the same states (within 1e-9 relative: `sin` and
//! `cos` may be 1 ulp from V8's) and the same outcome, unless it parts at a
//! frame where the browser's decision was within 1e-9 of its threshold (a
//! 1 ulp difference can flip it); after that frame nothing is compared.

use base64::Engine as _;
use serde_json::Value;
use vectorvroom_sim::{run, Brain, Car, Point, Pose, Profile, Settings, Track};

/// The fixture, or SIM_TRACES (a larger set made with --extra, for a check
/// run by hand).
fn fixture() -> Value {
    let path = std::env::var("SIM_TRACES")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/cloud-brain-sim/traces.json"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("run scripts/cloud-brain-sim-traces.mjs")).unwrap()
}
fn points(v: &Value) -> Vec<Point> {
    v.as_array().unwrap().iter().map(|p| Point { x: p[0].as_f64().unwrap(), y: p[1].as_f64().unwrap() }).collect()
}
pub fn track(t: &Value) -> Track {
    let gates: Vec<[Point; 2]> = t["checkpoints"].as_array().unwrap().iter().map(|g| {
        let p = points(g);
        [p[0], p[1]]
    }).collect();
    Track::new(t["width"].as_f64().unwrap(), t["height"].as_f64().unwrap(), &points(&t["inner"]), &points(&t["outer"]), &gates)
}
fn brain(c: &Value) -> Brain {
    let bytes = base64::engine::general_purpose::STANDARD.decode(c["vector"].as_str().unwrap()).unwrap();
    let flat: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    Brain::from_flat(&flat).unwrap()
}
fn settings(s: &Value) -> (Settings, u64) {
    let settings = Settings {
        max_speed: s["maxSpeed"].as_f64().unwrap(),
        traction: s["traction"].as_f64().unwrap(),
        profile: Profile::from_id(s["profile"].as_str().unwrap()),
    };
    (settings, (s["seconds"].as_f64().unwrap() * 60.0) as u64)
}
fn close(a: f64, b: f64) -> bool {
    a == b || (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
}
fn ulps(a: f64, b: f64) -> u64 {
    (a.to_bits() as i64 - b.to_bits() as i64).unsigned_abs()
}

/// How a case compared: identical, or parted at a frame the browser was
/// within 1e-9 of flipping a decision at.
#[derive(Debug)]
enum Verdict {
    Same,
    Parted(u64),
}

/// Sampled states compared, and those equal bit for bit; the most work a
/// frame any case took (segments examined, `Car::work`).
#[derive(Default)]
struct Tally {
    states: usize,
    exact: usize,
    work_per_frame: f64,
}

/// Runs a case from the browser's start pose, or (`own_pose`) from the one
/// the port finds itself, as the service does.
fn compare(t: &Track, c: &Value, own_pose: bool, tally: &mut Tally) -> Result<Verdict, String> {
    let js_start = &c["start"];
    let pose = if own_pose {
        t.start().unwrap()
    } else {
        Pose { x: js_start["x"].as_f64().unwrap(), y: js_start["y"].as_f64().unwrap(), angle: js_start["angle"].as_f64().unwrap() }
    };
    let (settings, frames) = settings(&c["settings"]);
    let controls: Vec<u8> = c["controls"].as_str().unwrap().bytes().map(|b| (b as char).to_digit(16).unwrap() as u8).collect();
    let states: Vec<&Value> = c["states"].as_array().unwrap().iter().collect();
    let near: Vec<u64> = c["near"].as_array().unwrap().iter().map(|n| n["frame"].as_u64().unwrap()).collect();
    let mut problem: Option<String> = None;
    let mut parted: Option<u64> = None;
    let mut next_state = 0;
    let outcome = run(t, pose, brain(c), settings, frames, |frame, car: &Car| {
        if problem.is_some() || parted.is_some() {
            return;
        }
        let bits = car.controls.iter().enumerate().fold(0u8, |acc, (i, on)| acc | (u8::from(*on) << i));
        let want = controls.get(frame as usize - 1).copied();
        if want != Some(bits) {
            if near.contains(&frame) {
                parted = Some(frame);
            } else {
                problem = Some(format!("frame {frame}: controls {bits:x}, the browser {want:?}; margins {:?}", car.margins));
            }
            return;
        }
        if let Some(s) = states.get(next_state).filter(|s| s["frame"].as_u64() == Some(frame)) {
            next_state += 1;
            let checks = [("x", car.x), ("y", car.y), ("angle", car.angle), ("speed", car.speed), ("vx", car.vx), ("vy", car.vy)];
            tally.states += 1;
            if checks.iter().all(|(name, v)| s[*name].as_f64() == Some(*v)) {
                tally.exact += 1;
            }
            for (name, v) in checks {
                let js = s[name].as_f64().unwrap();
                if !close(v, js) {
                    problem = Some(format!("frame {frame}: {name} {v} vs the browser's {js}"));
                }
            }
            if s["slide"].as_bool() != Some(car.slide) || s["checkpoints"].as_u64() != Some(u64::from(car.checkpoints)) || s["laps"].as_u64() != Some(u64::from(car.laps)) {
                problem = Some(format!("frame {frame}: slide/checkpoints/laps differ: {s}"));
            }
        }
    });
    if let Some(p) = problem {
        return Err(p);
    }
    if let Some(frame) = parted {
        return Ok(Verdict::Parted(frame));
    }
    tally.work_per_frame = tally.work_per_frame.max(outcome.work as f64 / outcome.frames.max(1) as f64);
    let js = &c["outcome"];
    let lap_frames: Vec<u64> = js["lapFrames"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
    if outcome.fitness != js["fitness"].as_f64().unwrap()
        || u64::from(outcome.laps) != js["laps"].as_u64().unwrap()
        || outcome.lap_frames != lap_frames
        || outcome.crashed_at != js["crashedAt"].as_u64()
        || outcome.frames != js["frames"].as_u64().unwrap()
    {
        return Err(format!("outcome {outcome:?} vs the browser's {js}"));
    }
    Ok(Verdict::Same)
}

/// Every case of the fixture (or SIM_TRACES), from the browser's start pose
/// or the port's own.
fn drive_every_case(own_pose: bool) {
    let f = fixture();
    let tracks = &f["tracks"];
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 60, "{} cases", cases.len());
    let (mut same, mut parted, mut failures, mut tally) = (0, Vec::new(), Vec::new(), Tally::default());
    for (i, c) in cases.iter().enumerate() {
        let t = track(&tracks[c["track"].as_str().unwrap()]);
        match compare(&t, c, own_pose, &mut tally) {
            Ok(Verdict::Same) => same += 1,
            Ok(Verdict::Parted(frame)) => parted.push((i, frame)),
            Err(e) => failures.push(format!("case {i} ({}, {}, {}): {e}", c["track"], c["brain"], c["settings"])),
        }
    }
    let laps = cases.iter().filter(|c| c["outcome"]["laps"].as_u64().unwrap() > 0).count();
    eprintln!(
        "{} start pose: {same} of {} cases identical ({laps} with a lap); parted at a near-threshold frame: {parted:?}; {} of {} sampled states bit for bit; at most {:.0} segments examined a frame",
        if own_pose { "the port's own" } else { "the browser's" },
        cases.len(),
        tally.exact,
        tally.states,
        tally.work_per_frame
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(laps >= 3, "cases with laps");
}

#[test]
fn the_port_drives_as_the_browser() {
    drive_every_case(false);
}

#[test]
fn from_its_own_start_pose_too() {
    // The service finds the pose itself (with musl's atan2, an ulp or two
    // from V8's at most): the same runs.
    drive_every_case(true);
}

#[test]
fn the_start_pose_is_main_js_compute_start_info_in_place() {
    // Within 2 ulps of the browser's (V8's atan2 is not musl's; JSON writes
    // -0 as 0).
    let f = fixture();
    for (name, t) in f["tracks"].as_object().unwrap() {
        let pose = track(t).start().unwrap();
        let case = f["cases"].as_array().unwrap().iter().find(|c| c["track"] == name.as_str()).unwrap();
        let js = &case["start"];
        assert_eq!(pose.x, js["x"].as_f64().unwrap(), "{name}");
        assert_eq!(pose.y, js["y"].as_f64().unwrap(), "{name}");
        let angle = js["angle"].as_f64().unwrap();
        assert!(pose.angle == angle || ulps(pose.angle, angle) <= 2, "{name}: {} vs {angle}", pose.angle);
    }
}

#[test]
#[ignore = "a timing probe: cargo test --release -p vectorvroom-sim -- --ignored --nocapture"]
fn how_fast_a_verification_runs() {
    let f = fixture();
    let c = f["cases"].as_array().unwrap().iter().filter(|c| c["outcome"]["laps"].as_u64().unwrap() > 0).max_by_key(|c| c["outcome"]["frames"].as_u64().unwrap()).unwrap();
    let t = track(&f["tracks"][c["track"].as_str().unwrap()]);
    let pose = t.start().unwrap();
    let (settings, _) = settings(&c["settings"]);
    let started = std::time::Instant::now();
    let mut frames = 0;
    for _ in 0..20 {
        frames += run(&t, pose, brain(c), settings, 7_200, |_, _| {}).frames;
    }
    let per = started.elapsed().as_secs_f64() / frames as f64;
    eprintln!("{frames} frames ({}), {:.2} µs a frame, {:.1} ms for 120 s", c["track"], per * 1e6, per * 7_200.0 * 1e3);
}
