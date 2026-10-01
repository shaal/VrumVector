//! The brain driven by random sequences of requests (contributions with
//! brains, tracks and feedback from a few contributors, recalls, forgets,
//! time passing, rebuilds from the store), with small caps and quotas so
//! eviction, the track cap, the context cap and quotas all happen. After
//! every step: no panic and no store error, memory mirrors the store,
//! everything stays within its cap, every slot has its contributor's id and
//! none is the brain's own contributor's, a served fitness is never more
//! than the claim, never below min(claim, 0), and never above 0 before two
//! other contributors corroborate it, forget leaves none of the
//! contributor's brains or slots, answers hold no -0 and fit 256 KiB, and a
//! rebuild answers as the live brain did.
//!
//! X2: training sessions (small budgets) among the requests: what they
//! archive is the service's, its run its verified run (served in its own
//! context only), at most CLOUD_BRAINS of them.
//!
//! X1: verifications on the golden traces' tracks (and a few hostile ones),
//! of random brains and of brains the game evolved there (they lap), and
//! leaderboards. A brain verified in its own context is served its verified
//! fitness in that context (only there), whatever it claimed; every run's
//! track key pinned to one geometry, the presets' to theirs; at most 4 runs
//! a brain, every run of a held brain, none left with a forgotten
//! contributor; a leaderboard holds at most 20 held brains with a lap, each
//! once, the fastest first lap first.

#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::OnceLock;
use vectorvroom_brain_core::brain::{context_hash, contributor_id, tag, Brain, Config, MemStore, Refusal, Training, Usage, BOARD_SIZE, CLOUD_BRAINS, CLOUD_CONTRIBUTOR, CRASH_CONTRIBUTORS, CRASH_LAYOUTS, CRASH_MODES, MAX_CONTEXTS_PER_BRAIN, MAX_CONTRIBUTORS, VERIFIED_PER_BRAIN};
use vectorvroom_brain_core::presets::presets;
use vectorvroom_brain_core::wire::{self, encode_f32, limits, parse_board, parse_contribute, parse_crash_recall, parse_crashes, parse_recall, parse_verify};

const T0: u64 = 1_790_000_000_000;
const TOKENS: usize = 5;

#[derive(Arbitrary, Debug)]
struct BrainIn {
    seed: u8,
    fitness: i32,
    track: Option<u8>,
    dynamics: Option<u8>,
    context: u8,
}

#[derive(Arbitrary, Debug)]
struct RowIn {
    brain: u8,
    context: u8,
    mean: i32,
    count: u16,
}

#[derive(Arbitrary, Debug)]
enum Op {
    Contribute { who: u8, tracks: Vec<u8>, brains: Vec<BrainIn>, feedback: Vec<RowIn> },
    Recall { track: u8, dynamics: Option<u8>, context: u8, k: u8 },
    Forget { who: u8 },
    Verify { who: u8, brain: u8, track: u8, context: u8 },
    Board { track: u8, context: u8 },
    Train { frames: u16, seed: u8 },
    Crash { who: u8, track: u8, cells: Vec<(u8, u8)>, mode: u8, layout: Option<(u8, u8)> },
    CrashRecall { track: u8, mode: u8, geometry: u8 },
    Wait { ms: u32 },
    Reopen,
    Bytes(Vec<u8>),
}

fn token(who: u8) -> String {
    format!("{:032x}", 0xa11ce + (who as usize % TOKENS) as u64)
}
/// One of 6 collision modes (a track keeps CRASH_MODES).
fn crash_mode(mode: u8) -> &'static str {
    ["off", "solid/k8", "solid/k4", "solid/k2", "solid/k1", "solid/k3"][usize::from(mode % 6)]
}
fn stream(seed: u64) -> impl FnMut() -> f32 {
    let mut s = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
    move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s >> 40) as f32 / (1u64 << 24) as f32 * 2.0 - 1.0
    }
}
fn vector(seed: u64, dim: usize) -> Vec<f32> {
    let mut r = stream(seed);
    (0..dim).map(|_| r()).collect()
}

/// The golden traces' tracks and their evolved brains (tests/fixtures/
/// cloud-brain-sim), then hostile tracks: every point the same, one gate,
/// coordinates far off the canvas.
struct Traces {
    tracks: Vec<Value>,
    evolved: Vec<Vec<f32>>,
}
fn traces() -> &'static Traces {
    static TRACES: OnceLock<Traces> = OnceLock::new();
    TRACES.get_or_init(|| {
        let f: Value = serde_json::from_str(include_str!("../../../../tests/fixtures/cloud-brain-sim/traces.json")).unwrap();
        let mut tracks: Vec<Value> = ["Rectangle", "Oval", "Triangle", "Monza", "Monaco"].iter().map(|n| f["tracks"][n].clone()).collect();
        for t in &mut tracks {
            t.as_object_mut().unwrap().remove("key");
        }
        tracks.push(json!({"width": 3200, "height": 1800, "inner": [[5, 5], [5, 5], [5, 5]], "outer": [[5, 5], [5, 5], [5, 5]], "checkpoints": [[[5, 5], [5, 5]]]}));
        tracks.push(json!({"width": 3200, "height": 1800, "inner": [[650, 700], [2450, 700], [2450, 1100]], "outer": [[250, 300], [3100, 300], [3100, 1500]], "checkpoints": [[[1600, 300], [1600, 700]]]}));
        tracks.push(json!({"width": 3200, "height": 1800, "inner": [[-100000, -100000], [100000, -100000], [100000, 100000]], "outer": [[-99999, 5], [3, 99999], [0.5, -0.25]], "checkpoints": [[[-100000, 0], [100000, 0]], [[0, -100000], [0, 100000]]]}));
        // Every wall in every ray's way: stopped past the work budget.
        let zigzag = |y: f64| (0..256).map(|i| json!([if i % 2 == 0 { 0.0 } else { 3200.0 }, y + i as f64 * 0.01])).collect::<Vec<_>>();
        tracks.push(json!({"width": 3200, "height": 1800, "inner": zigzag(300.0), "outer": zigzag(700.0),
            "checkpoints": [[[1600, 400], [1600, 600]], [[1700, 400], [1700, 600]]]}));
        let evolved = f["cases"].as_array().unwrap().iter().filter(|c| c["outcome"]["laps"].as_u64() > Some(0)).map(|c| {
            let bytes = wire::decode_f32(Some(&c["vector"]), wire::BRAIN_DIM).unwrap();
            bytes
        }).collect();
        Traces { tracks, evolved }
    })
}
fn geometry(t: u8) -> &'static Value {
    let all = &traces().tracks;
    &all[t as usize % all.len()]
}
/// The track keys of the Rectangle and of a made-up track with one gate
/// (a car parked on it laps every frame): contexts are on them, so a brain's
/// own context can be one a verification decides.
fn keys() -> &'static [String; 2] {
    static KEYS: OnceLock<[String; 2]> = OnceLock::new();
    KEYS.get_or_init(|| {
        [0u8, 6].map(|t| {
            let body = json!({"protocol": 1, "brainSchema": 6, "token": token(0), "vector": encode_f32(&vector(1, wire::BRAIN_DIM)),
                "track": geometry(t), "context": {"profile": "balanced", "track": "", "maxSpeed": 15, "traction": 0.5, "seconds": 20}});
            wire::geometry_key(&parse_verify(&serde_json::to_vec(&body).unwrap()).unwrap().geometry)
        })
    })
}
fn unit(seed: u64, dim: usize) -> Vec<f32> {
    let v = vector(seed, dim);
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / n).collect()
}
/// A few contexts: one without a track key (never a brain's own), on the
/// Rectangle and on the made-up track (a verification there can decide a
/// brain's fitness).
fn context(c: u8) -> Value {
    let tracks = [keys()[0].as_str(), keys()[1].as_str(), "t2", ""];
    let profiles = ["balanced", "wild"];
    json!({"profile": profiles[c as usize % 2], "track": tracks[(c as usize / 2) % 4], "maxSpeed": 15, "traction": 0.5, "seconds": 20})
}
/// Few brains, tracks and dynamics, so ops meet the same ones again: 24
/// random brains, then the evolved ones.
fn brain_vector(s: u8) -> Vec<f32> {
    let evolved = &traces().evolved;
    match (s as usize) % (24 + evolved.len()) {
        n if n < 24 => vector(1_000 + n as u64, wire::BRAIN_DIM),
        n => evolved[n - 24].clone(),
    }
}
fn track_seed(t: u8) -> u64 {
    2_000 + u64::from(t % 6)
}

fn no_negative_zero(v: &Value) -> bool {
    match v {
        Value::Number(n) => n.as_f64().map_or(true, |x| !(x == 0.0 && x.is_sign_negative())),
        Value::Array(items) => items.iter().all(no_negative_zero),
        Value::Object(map) => map.values().all(no_negative_zero),
        _ => true,
    }
}

struct World {
    brain: Brain,
    store: MemStore,
    config: Config,
    now: u64,
}

impl World {
    fn recall(&self, body: &[u8]) -> Value {
        let r = parse_recall(body).expect("a valid recall");
        let query = context_hash(&r.context);
        let answer = self.brain.recall(&r, &self.store).unwrap();
        let text = serde_json::to_string(&answer).unwrap();
        assert!(text.len() <= limits::RESPONSE_BYTES);
        let value: Value = serde_json::from_str(&text).unwrap();
        assert!(no_negative_zero(&value));
        for e in value["pool"].as_array().unwrap() {
            self.check_entry(e, query);
        }
        value
    }

    /// In its own context a brain verified there is served its verified
    /// fitness; otherwise (and in every other context) a served fitness is
    /// at most the claim, and at most 0 unless two other contributors have
    /// values in the brain's own context.
    fn check_entry(&self, e: &Value, query: u64) {
        let id = e["id"].as_str().unwrap();
        let (row, _) = &self.store.brains[id];
        let served = e["fitness"].as_f64().unwrap();
        // The service's own (X2): its run is its verified run (served in its
        // own context only, as any verified run, below).
        if row.contributor == CLOUD_CONTRIBUTOR {
            assert!(self.store.verified.iter().any(|r| r.brain == id && r.fitness == row.fitness && r.contributor == CLOUD_CONTRIBUTOR));
        }
        let meta: Value = serde_json::from_str(&row.meta).unwrap();
        let own = wire::clean_brain_meta(Some(&meta)).learning.map(|l| l.context).filter(|c| !c.track.is_empty());
        if let Some(run) = own.as_ref().filter(|o| context_hash(o) == query).and_then(|o| self.store.verified.iter().find(|r| r.brain == id && context_hash(&r.context()) == context_hash(o))) {
            assert_eq!(served, wire::plain(run.fitness), "{id}: verified, served {served}");
            return;
        }
        assert!(served <= row.fitness, "{id}: served {served} over the claim {}", row.fitness);
        assert!(served >= row.fitness.min(0.0), "{id}: served {served} under its floor");
        if served > 0.0 {
            let key = format!("{:016x}", context_hash(own.as_ref().expect("a claim counts only in its own context")));
            let others = self.store.feedback.get(&(id.to_string(), key)).map_or(0, |r| r.slots.iter().filter(|s| s.value.is_some()).count());
            assert!(others >= 2, "{id}: served {served} with {others} corroborators");
        }
        let fb = &e["feedback"];
        assert!(fb["weight"].as_f64().unwrap().abs() <= 1.0 && fb["contributors"].as_u64().unwrap() <= MAX_CONTRIBUTORS as u64);
    }

    fn check(&self) {
        let c = &self.config;
        assert!(self.brain.len() <= c.max_brains && self.brain.track_count() <= c.max_tracks);
        assert_eq!(self.brain.len(), self.store.brains.len(), "memory mirrors the store");
        assert!(self.store.tracks.len() <= c.max_tracks);
        let mut per_brain = std::collections::HashMap::<&str, usize>::new();
        for ((brain, _), row) in &self.store.feedback {
            assert!(self.store.brains.contains_key(brain), "feedback about a brain not held");
            *per_brain.entry(brain.as_str()).or_default() += 1;
            assert!(!row.slots.is_empty() && row.slots.len() <= MAX_CONTRIBUTORS);
            let who: HashSet<u16> = row.slots.iter().map(|s| s.who).collect();
            assert_eq!(who.len(), row.slots.len(), "a contributor twice");
            assert!(row.slots.iter().all(|s| s.who == tag(&s.id)), "a slot without its contributor's id");
            // Its contributor's reports are never evidence for their own brain.
            assert!(row.slots.iter().all(|s| s.id != self.store.brains[brain].0.contributor));
            assert!(row.slots.iter().all(|s| s.value.map_or(true, |v| v.abs() <= 1.0)));
        }
        assert!(per_brain.values().all(|n| *n <= MAX_CONTEXTS_PER_BRAIN));
        for row in self.store.contributors.values() {
            assert!(row.used.requests <= c.quota.requests && row.used.brains <= c.quota.brains && row.used.feedback <= c.quota.feedback);
        }
        let mut runs = std::collections::HashMap::<&str, usize>::new();
        for (i, r) in self.store.verified.iter().enumerate() {
            assert!(self.store.brains.contains_key(&r.brain), "a run of a brain not held");
            assert!(self.store.verified[..i].iter().all(|o| !(o.brain == r.brain && o.context() == r.context())), "a run twice");
            assert!(r.lap_frames.is_some() == (r.laps > 0) && r.frames <= (limits::VERIFY_SECONDS * 60.0) as u64);
            *runs.entry(r.brain.as_str()).or_default() += 1;
        }
        assert!(runs.values().all(|n| *n <= VERIFIED_PER_BRAIN));
        // Crash maps (X4): one a contributor a track and mode, at most
        // CRASH_CONTRIBUTORS, in at most CRASH_MODES modes a track, on held
        // tracks.
        let mut per: std::collections::HashMap<(&str, &str), Vec<&str>> = std::collections::HashMap::new();
        let mut modes: std::collections::HashMap<&str, HashSet<&str>> = std::collections::HashMap::new();
        for r in &self.store.crashes {
            assert!(self.store.tracks.contains_key(&r.track), "a crash map of a track not held");
            per.entry((&r.track, &r.mode)).or_default().push(&r.contributor);
            modes.entry(&r.track).or_default().insert(&r.mode);
        }
        for who in per.values() {
            assert!(who.len() <= CRASH_CONTRIBUTORS && who.iter().collect::<HashSet<_>>().len() == who.len());
        }
        assert!(modes.values().all(|m| m.len() <= CRASH_MODES));
        // Every run's key is pinned; the presets' to their own geometries.
        assert!(self.store.verified.iter().all(|r| self.store.pins.contains_key(&r.track)));
        assert!(presets().iter().all(|p| self.store.pins.get(&p.key) == Some(&p.digest)));
    }

    /// A leaderboard: at most 20 held brains with a lap, the fastest first lap first.
    fn board(&self, track: u8, c: u8) -> Value {
        let ctx = context(c);
        let query = format!("track={}&maxSpeed={}&traction={}", self.key_of(track), ctx["maxSpeed"], ctx["traction"]);
        let answer = self.brain.leaderboard(&parse_board(&query).unwrap(), &self.store).unwrap();
        assert!(answer.entries.len() <= BOARD_SIZE);
        assert_eq!(answer.entries.iter().map(|e| &e.id).collect::<HashSet<_>>().len(), answer.entries.len(), "a brain twice");
        assert!(answer.entries.windows(2).all(|w| (w[0].lap_frames, -w[0].fitness) <= (w[1].lap_frames, -w[1].fitness)), "{answer:?}");
        for e in &answer.entries {
            assert!(self.store.brains.contains_key(&e.id) && e.laps >= 1);
            assert!(self.store.verified.iter().any(|r| r.brain == e.id && r.track == answer.track && r.lap_frames == Some(e.lap_frames)));
        }
        let value = serde_json::to_value(&answer).unwrap();
        assert!(no_negative_zero(&value));
        value
    }
    /// Everyone's crash map: of length 1 or none, from contributors whose
    /// maps are held; at most CRASH_LAYOUTS layouts, the best first.
    fn crash_recall(&self, track: u8, mode: u8, geometry: u8) -> Value {
        let b = json!({"protocol": 1, "track": encode_f32(&unit(track_seed(track), wire::TRACK_DIM)), "geometry": format!("g{}", geometry % 3), "collisions": crash_mode(mode)});
        let answer = json!(self.brain.crash_recall(&parse_crash_recall(&serde_json::to_vec(&b).unwrap()).unwrap(), &self.store).unwrap());
        match answer["map"].as_str() {
            Some(_) => {
                let m = wire::decode_f32(Some(&answer["map"]), wire::CRASH_DIM).expect("a map");
                assert!(wire::is_unit(&m) && m.iter().all(|x| *x >= 0.0) && answer["contributors"].as_u64() > Some(0));
            }
            None => assert_eq!(answer["contributors"], 0),
        }
        let s: Vec<f64> = answer["layouts"].as_array().unwrap().iter().map(|l| l["survival"].as_f64().unwrap()).collect();
        assert!(s.len() <= CRASH_LAYOUTS && s.windows(2).all(|w| w[0] >= w[1]));
        assert!(no_negative_zero(&answer));
        answer
    }
    fn key_of(&self, track: u8) -> String {
        wire::geometry_key(&parse_verify(&verify_body(0, 0, track, 0)).unwrap().geometry)
    }
}

fn verify_body(who: u8, brain: u8, track: u8, c: u8) -> Vec<u8> {
    serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": token(who), "vector": encode_f32(&brain_vector(brain)), "track": geometry(track), "context": context(c)})).unwrap()
}

fn contribution(who: &str, tracks: &[u8], brains: &[BrainIn], feedback: &[RowIn]) -> Vec<u8> {
    let tracks: Vec<String> = tracks.iter().take(limits::TRACKS_PER_REQUEST).map(|t| encode_f32(&unit(track_seed(*t), wire::TRACK_DIM))).collect();
    let n = tracks.len();
    let brains: Vec<Value> = brains
        .iter()
        .take(limits::BRAINS_PER_REQUEST)
        .map(|b| {
            let mut v = json!({"vector": encode_f32(&brain_vector(b.seed)), "fitness": b.fitness as f64 / 10.0,
                "meta": {"generation": 1, "source": "evolved", "learning": {"context": context(b.context), "styleScore": 0.5}}});
            if let Some(t) = b.track.filter(|_| n > 0) {
                v["track"] = json!(t as usize % n);
            }
            if let Some(d) = b.dynamics {
                v["dynamics"] = json!(encode_f32(&unit(3_000 + u64::from(d % 4), wire::DYNAMICS_DIM)));
            }
            v
        })
        .collect();
    let feedback: Vec<Value> = feedback
        .iter()
        .take(limits::FEEDBACK_PER_REQUEST)
        .map(|r| json!({"id": wire::brain_id(&brain_vector(r.brain)), "context": context(r.context),
            "meanFitness": r.mean as f64 / 10.0, "count": 1 + u64::from(r.count)}))
        .collect();
    serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": who, "tracks": tracks, "brains": brains, "feedback": feedback})).unwrap()
}

fn recall_body(track: u8, dynamics: Option<u8>, c: u8, k: u8) -> Vec<u8> {
    let mut v = json!({"protocol": 1, "brainSchema": 6, "track": encode_f32(&unit(track_seed(track), wire::TRACK_DIM)), "context": context(c), "k": 1 + k as usize % 64});
    if let Some(d) = dynamics {
        v["dynamics"] = json!(encode_f32(&unit(3_000 + u64::from(d % 4), wire::DYNAMICS_DIM)));
    }
    serde_json::to_vec(&v).unwrap()
}

fuzz_target!(|ops: Vec<Op>| {
    let config = Config {
        max_brains: 10,
        max_tracks: 3,
        keep_per_track: 1,
        corroborators: 2,
        quota: Usage { requests: 30, brains: 40, feedback: 120 },
    };
    // The five tokens have five tags, so the checks can tell them apart.
    let tags: HashSet<u16> = (0..TOKENS as u8).map(|w| tag(&contributor_id(&token(w)))).collect();
    assert_eq!(tags.len(), TOKENS);
    let mut store = MemStore::default();
    let brain = Brain::open(config.clone(), &mut store, T0).unwrap();
    let mut w = World { brain, store, config, now: T0 };
    for op in ops.into_iter().take(64) {
        match op {
            Op::Contribute { who, tracks, brains, feedback } => {
                let body = contribution(&token(who), &tracks, &brains, &feedback);
                let c = parse_contribute(&body).expect("a valid contribution");
                let _ = w.brain.contribute(c, &contributor_id(&token(who)), w.now, &mut w.store).unwrap();
            }
            Op::Recall { track, dynamics, context, k } => {
                w.recall(&recall_body(track, dynamics, context, k));
            }
            Op::Forget { who } => {
                let contributor = contributor_id(&token(who));
                w.brain.forget(&contributor, &mut w.store).unwrap();
                assert!(w.store.brains.values().all(|b| b.0.contributor != contributor));
                assert!(w.store.feedback.values().all(|r| r.slots.iter().all(|s| s.id != contributor)));
                assert!(w.store.verified.iter().all(|r| r.contributor != contributor));
                assert!(w.store.crashes.iter().all(|r| r.contributor != contributor));
            }
            Op::Verify { who, brain, track, context } => {
                let v = parse_verify(&verify_body(who, brain, track, context)).expect("a valid verification");
                let held = w.store.brains.contains_key(&v.id);
                let (id, ctx) = (v.id.clone(), v.context.clone());
                match w.brain.verify(v, &contributor_id(&token(who)), w.now, &mut w.store).unwrap() {
                    Ok(answer) => {
                        assert!(held);
                        let run = w.store.verified.iter().find(|r| r.brain == id && r.track == answer.track && r.profile == ctx.profile).expect("its run is kept");
                        assert_eq!((run.fitness, run.laps, run.lap_frames), (answer.fitness, answer.laps, answer.lap_frames.first().copied()));
                        assert_eq!(answer.matched, answer.track == ctx.track);
                    }
                    Err(Refusal::Reason(reason)) => assert!(!held || reason == wire::Reason::TrackGeometry, "{reason:?}"),
                    Err(Refusal::Limited(_)) => assert!(held),
                }
            }
            Op::Board { track, context } => {
                w.board(track, context);
            }
            Op::Crash { who, track, cells, mode, layout } => {
                // Up to 4 cells with deaths; a layout for one of 3 walls' signatures.
                let mut m = vec![0f32; wire::CRASH_DIM];
                for (cell, n) in cells.iter().take(4) {
                    m[*cell as usize % wire::CRASH_DIM] += (1.0 + f32::from(*n % 50)).ln();
                }
                let norm = m.iter().map(|x| x * x).sum::<f32>().sqrt();
                if norm > 0.0 {
                    let mut b = json!({"protocol": 1, "token": token(who), "track": encode_f32(&unit(track_seed(track), wire::TRACK_DIM)),
                        "map": encode_f32(&m.iter().map(|x| x / norm).collect::<Vec<_>>()), "deaths": 7, "collisions": crash_mode(mode)});
                    if let Some((g, s)) = layout {
                        b["layout"] = json!({"geometry": format!("g{}", g % 3), "survival": f64::from(s) / 255.0, "gates": [[[f64::from(s), 300.0], [f64::from(s), 700.0]]]});
                    }
                    let c = parse_crashes(&serde_json::to_vec(&b).unwrap()).expect("a valid crash map");
                    let _ = w.brain.crashes(c, &contributor_id(&token(who)), w.now, &mut w.store).unwrap();
                }
            }
            Op::CrashRecall { track, mode, geometry } => {
                w.crash_recall(track, mode, geometry);
            }
            Op::Train { frames, seed } => {
                // A small session (up to 3 runs of 20 s), right after the last
                // request: training never waits for idleness here.
                let t = Training { frames: u64::from(frames) % 3_601, idle_minutes: 0 };
                let before: Vec<String> = w.store.brains.keys().cloned().collect();
                if let Some(r) = w.brain.train(t, w.now, u64::from(seed), &mut w.store).unwrap() {
                    assert!(r.frames <= t.frames && r.best_fitness >= r.seed_fitness);
                    if let Some(id) = &r.archived {
                        assert!(!before.contains(id) && w.store.brains[id].0.contributor == CLOUD_CONTRIBUTOR);
                    }
                    assert!(w.store.brains.values().filter(|(b, _)| b.contributor == CLOUD_CONTRIBUTOR).count() <= CLOUD_BRAINS);
                }
            }
            Op::Wait { ms } => w.now += u64::from(ms) * 64,
            Op::Reopen => {
                let queries: Vec<Vec<u8>> = (0..3u8).map(|i| recall_body(i, (i == 1).then_some(i), i, 63)).collect();
                let live: Vec<Value> = queries.iter().map(|q| w.recall(q)).collect();
                let boards: Vec<Value> = (0..2u8).map(|t| w.board(t, 0)).collect();
                let crashes: Vec<Value> = (0..3u8).map(|t| w.crash_recall(t, t, t)).collect();
                w.brain = Brain::open(w.config.clone(), &mut w.store, w.now).unwrap();
                for (q, before) in queries.iter().zip(&live) {
                    assert_eq!(&w.recall(q), before, "a rebuild answers as the live brain");
                }
                for (t, before) in boards.iter().enumerate() {
                    assert_eq!(&w.board(t as u8, 0), before, "a rebuild's leaderboard is the live one");
                }
                for (t, before) in crashes.iter().enumerate() {
                    assert_eq!(&w.crash_recall(t as u8, t as u8, t as u8), before, "a rebuild's crash recall is the live one");
                }
            }
            Op::Bytes(bytes) => {
                // From one of the five contributors whatever its token says,
                // so every contributor's tag is known to the checks.
                if let Ok(c) = parse_contribute(&bytes) {
                    let who = contributor_id(&token(bytes.len() as u8));
                    let _ = w.brain.contribute(c, &who, w.now, &mut w.store).unwrap();
                }
                if let Ok(r) = parse_recall(&bytes) {
                    let _ = w.brain.recall(&r, &w.store).unwrap();
                }
            }
        }
        w.check();
    }
});
