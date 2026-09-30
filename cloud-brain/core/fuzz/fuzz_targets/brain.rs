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

#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use serde_json::{json, Value};
use std::collections::HashSet;
use vectorvroom_brain_core::brain::{context_hash, contributor_id, tag, Brain, Config, MemStore, Usage, MAX_CONTEXTS_PER_BRAIN, MAX_CONTRIBUTORS};
use vectorvroom_brain_core::wire::{self, encode_f32, limits, parse_contribute, parse_recall};

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
    Wait { ms: u32 },
    Reopen,
    Bytes(Vec<u8>),
}

fn token(who: u8) -> String {
    format!("{:032x}", 0xa11ce + (who as usize % TOKENS) as u64)
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
fn unit(seed: u64, dim: usize) -> Vec<f32> {
    let v = vector(seed, dim);
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / n).collect()
}
/// A few contexts: one without a track key (never a brain's own).
fn context(c: u8) -> Value {
    let tracks = ["t1", "t2", ""];
    let profiles = ["balanced", "wild"];
    json!({"profile": profiles[c as usize % 2], "track": tracks[(c as usize / 2) % 3], "maxSpeed": 15, "traction": 0.5, "seconds": 20})
}
/// Few brains, tracks and dynamics, so ops meet the same ones again.
fn brain_seed(s: u8) -> u64 {
    1_000 + u64::from(s % 24)
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
        let answer = self.brain.recall(&parse_recall(body).expect("a valid recall"), &self.store).unwrap();
        let text = serde_json::to_string(&answer).unwrap();
        assert!(text.len() <= limits::RESPONSE_BYTES);
        let value: Value = serde_json::from_str(&text).unwrap();
        assert!(no_negative_zero(&value));
        for e in value["pool"].as_array().unwrap() {
            self.check_entry(e);
        }
        value
    }

    /// A served fitness is at most the claim, and at most 0 unless two other
    /// contributors have values in the brain's own context.
    fn check_entry(&self, e: &Value) {
        let id = e["id"].as_str().unwrap();
        let (row, _) = &self.store.brains[id];
        let served = e["fitness"].as_f64().unwrap();
        assert!(served <= row.fitness, "{id}: served {served} over the claim {}", row.fitness);
        assert!(served >= row.fitness.min(0.0), "{id}: served {served} under its floor");
        if served > 0.0 {
            let meta: Value = serde_json::from_str(&row.meta).unwrap();
            let own = wire::clean_brain_meta(Some(&meta)).learning.map(|l| l.context).filter(|c| !c.track.is_empty());
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
    }
}

fn contribution(who: &str, tracks: &[u8], brains: &[BrainIn], feedback: &[RowIn]) -> Vec<u8> {
    let tracks: Vec<String> = tracks.iter().take(limits::TRACKS_PER_REQUEST).map(|t| encode_f32(&unit(track_seed(*t), wire::TRACK_DIM))).collect();
    let n = tracks.len();
    let brains: Vec<Value> = brains
        .iter()
        .take(limits::BRAINS_PER_REQUEST)
        .map(|b| {
            let mut v = json!({"vector": encode_f32(&vector(brain_seed(b.seed), wire::BRAIN_DIM)), "fitness": b.fitness as f64 / 10.0,
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
        .map(|r| json!({"id": wire::brain_id(&vector(brain_seed(r.brain), wire::BRAIN_DIM)), "context": context(r.context),
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
            }
            Op::Wait { ms } => w.now += u64::from(ms) * 64,
            Op::Reopen => {
                let queries: Vec<Vec<u8>> = (0..3u8).map(|i| recall_body(i, (i == 1).then_some(i), i, 63)).collect();
                let live: Vec<Value> = queries.iter().map(|q| w.recall(q)).collect();
                w.brain = Brain::open(w.config.clone(), &mut w.store, w.now).unwrap();
                for (q, before) in queries.iter().zip(&live) {
                    assert_eq!(&w.recall(q), before, "a rebuild answers as the live brain");
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
