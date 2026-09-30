//! The shared brain (core/src/brain.rs): contributions, recall ranking,
//! feedback, caps and eviction, persistence, a store that fails, stats.
//! Requests go through the real wire parsers.

use serde_json::{json, Value};
use vectorvroom_brain_core::brain::{contributor_id, match_factor, Brain, Config, MemStore, Store};
use vectorvroom_brain_core::wire::{self, encode_f32, parse_contribute, parse_recall, Context};

const T0: u64 = 1_790_000_000_000; // 2026-09-21, a fixed clock
const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const OTHER: &str = "fedcba9876543210fedcba9876543210";

fn stream(seed: u64) -> impl FnMut() -> f32 {
    let mut s = seed.max(1);
    move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s >> 40) as f32 / (1u64 << 24) as f32 * 2.0 - 1.0
    }
}
fn brain(seed: u64) -> Vec<f32> {
    let mut r = stream(seed);
    (0..wire::BRAIN_DIM).map(|_| r()).collect()
}
fn unit(seed: u64, dim: usize) -> Vec<f32> {
    let mut r = stream(seed);
    let v: Vec<f32> = (0..dim).map(|_| r()).collect();
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / n).collect()
}
/// `base` nudged by a small `step` in the direction of `other`, renormalised.
fn near(base: &[f32], other: &[f32], step: f32) -> Vec<f32> {
    let v: Vec<f32> = base.iter().zip(other).map(|(a, b)| a + step * b).collect();
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / n).collect()
}
fn context(profile: &str) -> Value {
    json!({"profile": profile, "track": "t1", "maxSpeed": 15, "traction": 0.5, "seconds": 20, "collisions": "off"})
}

struct Item {
    vector: Vec<f32>,
    fitness: f64,
    track: Option<usize>,
    dynamics: Option<Vec<f32>>,
    profile: &'static str,
}
fn item(seed: u64, fitness: f64, track: Option<usize>) -> Item {
    Item { vector: brain(seed), fitness, track, dynamics: None, profile: "balanced" }
}

fn contribution(tracks: &[Vec<f32>], items: &[Item], feedback: Value) -> Vec<u8> {
    let brains: Vec<Value> = items
        .iter()
        .map(|b| {
            let mut v = json!({"vector": encode_f32(&b.vector), "fitness": b.fitness,
                "meta": {"generation": 3, "source": "evolved", "learning": {"context": context(b.profile), "styleScore": 0.5}}});
            if let Some(t) = b.track {
                v["track"] = json!(t);
            }
            if let Some(d) = &b.dynamics {
                v["dynamics"] = json!(encode_f32(d));
            }
            v
        })
        .collect();
    let tracks: Vec<String> = tracks.iter().map(|t| encode_f32(t)).collect();
    serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": TOKEN, "tracks": tracks, "brains": brains, "feedback": feedback})).unwrap()
}
fn recall_body(track: &[f32], dynamics: Option<&[f32]>, profile: &str, k: usize) -> Vec<u8> {
    let mut v = json!({"protocol": 1, "brainSchema": 6, "track": encode_f32(track), "context": context(profile), "k": k});
    if let Some(d) = dynamics {
        v["dynamics"] = json!(encode_f32(d));
    }
    serde_json::to_vec(&v).unwrap()
}

struct Fixture {
    brain: Brain,
    store: MemStore,
}
impl Fixture {
    fn new(config: Config) -> Self {
        let mut store = MemStore::default();
        Fixture { brain: Brain::open(config, &mut store, T0).unwrap(), store }
    }
    fn contribute(&mut self, token: &str, body: &[u8], now: u64) -> Value {
        let c = parse_contribute(body).expect("a valid contribution");
        json!(self.brain.contribute(c, &contributor_id(token), now, &mut self.store).unwrap())
    }
    fn recall(&self, body: &[u8]) -> Value {
        json!(self.brain.recall(&parse_recall(body).unwrap(), &self.store).unwrap())
    }
}
fn ids(answer: &Value) -> Vec<String> {
    answer["pool"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect()
}
fn id(seed: u64) -> String {
    wire::brain_id(&brain(seed))
}

#[test]
fn a_contributed_brain_comes_back_bit_for_bit() {
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    let mut b = item(10, 42.5, Some(0));
    b.dynamics = Some(unit(2, wire::DYNAMICS_DIM));
    let answer = f.contribute(TOKEN, &contribution(std::slice::from_ref(&track), &[b], json!([])), T0);
    assert_eq!(answer, json!({"protocol": 1, "accepted": [id(10)], "rejected": [], "feedbackAccepted": 0, "feedbackRejected": []}));
    let pool = f.recall(&recall_body(&track, None, "balanced", 5));
    assert_eq!(pool["protocol"], 1);
    assert_eq!(pool["brainSchema"], 6);
    let entry = &pool["pool"][0];
    assert_eq!(entry["id"], id(10));
    assert_eq!(entry["vector"], encode_f32(&brain(10)));
    assert_eq!(entry["fitness"], 42.5);
    assert_eq!(entry["meta"]["generation"], 3);
    assert_eq!(entry["meta"]["learning"]["context"]["profile"], "balanced");
    assert_eq!(entry["feedback"], json!({"weight": 0.0, "count": 0, "contributors": 0}));
    assert_eq!((f.brain.len(), f.brain.track_count()), (1, 1));
}

#[test]
fn contributions_are_idempotent() {
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    let body = contribution(std::slice::from_ref(&track), &[item(10, 5.0, Some(0)), item(11, 6.0, None)], json!([]));
    let first = f.contribute(TOKEN, &body, T0);
    let snapshot = (f.store.brains.len(), f.store.tracks.len());
    let second = f.contribute(OTHER, &body, T0 + 1);
    assert_eq!(first, second);
    assert_eq!((f.store.brains.len(), f.store.tracks.len()), snapshot);
    // The first contributor keeps the credit.
    assert_eq!(f.store.brains[&id(10)].0.contributor, contributor_id(TOKEN));
}

#[test]
fn near_tracks_are_one_track() {
    let mut f = Fixture::new(Config::default());
    let a = unit(1, wire::TRACK_DIM);
    let same = near(&a, &unit(2, wire::TRACK_DIM), 0.05); // cosine distance about 0.001
    let other = near(&a, &unit(2, wire::TRACK_DIM), 0.2); // about 0.02
    f.contribute(TOKEN, &contribution(&[a.clone(), same, other], &[item(10, 1.0, Some(0)), item(11, 1.0, Some(1)), item(12, 1.0, Some(2))], json!([])), T0);
    assert_eq!(f.brain.track_count(), 2);
    assert_eq!(f.brain.track_of(&id(10)), f.brain.track_of(&id(11)));
    assert_ne!(f.brain.track_of(&id(10)), f.brain.track_of(&id(12)));
}

#[test]
fn recall_ranks_the_nearest_track_first_then_fitness() {
    let mut f = Fixture::new(Config::default());
    let (a, b) = (unit(1, wire::TRACK_DIM), unit(2, wire::TRACK_DIM));
    f.contribute(TOKEN, &contribution(&[a.clone(), b.clone()],
        &[item(10, 10.0, Some(0)), item(11, 90.0, Some(0)), item(12, 500.0, Some(1)), item(13, 1000.0, None)], json!([])), T0);
    // On track a: its two brains, best first. Track b is another circuit and
    // is searched too (5 nearest), but its brains score lower.
    let pool = ids(&f.recall(&recall_body(&a, None, "balanced", 64)));
    assert_eq!(&pool[..2], &[id(11), id(10)]);
    assert!(!pool.contains(&id(13)), "a brain without a track only comes when no track is near");
    // k bounds the pool.
    assert_eq!(ids(&f.recall(&recall_body(&a, None, "balanced", 1))), vec![id(11)]);
}

#[test]
fn with_no_track_near_every_brain_is_a_candidate() {
    let mut f = Fixture::new(Config::default());
    f.contribute(TOKEN, &contribution(&[], &[item(10, 10.0, None), item(11, 90.0, None)], json!([])), T0);
    let pool = ids(&f.recall(&recall_body(&unit(1, wire::TRACK_DIM), None, "balanced", 50)));
    assert_eq!(pool, vec![id(11), id(10)]);
}

#[test]
fn the_context_and_dynamics_move_a_brain_up() {
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    let dynamics = unit(3, wire::DYNAMICS_DIM);
    let mut wild = item(10, 50.0, Some(0));
    wild.profile = "wild";
    let mut similar = item(11, 50.0, Some(0));
    similar.dynamics = Some(dynamics.clone());
    let mut opposite = item(12, 50.0, Some(0));
    opposite.dynamics = Some(dynamics.iter().map(|x| -x).collect());
    f.contribute(TOKEN, &contribution(std::slice::from_ref(&track), &[wild, similar, opposite], json!([])), T0);
    // Same fitness and track: the matching style wins; among those, the
    // driving that looks like the query's.
    let pool = ids(&f.recall(&recall_body(&track, Some(&dynamics), "balanced", 3)));
    assert_eq!(pool, vec![id(11), id(12), id(10)]);
    // Asking for wild driving puts the wild brain first.
    assert_eq!(ids(&f.recall(&recall_body(&track, None, "wild", 3)))[0], id(10));
}

#[test]
fn offspring_feedback_moves_the_weight_as_the_browser_does() {
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    f.contribute(TOKEN, &contribution(std::slice::from_ref(&track), &[item(10, 40.0, Some(0)), item(11, 40.0, Some(0))], json!([])), T0);
    let row = |seed: u64, profile: &str, mean: f64| json!({"id": id(seed), "context": context(profile), "meanFitness": mean, "count": 8});
    let answer = f.contribute(OTHER, &contribution(&[], &[], json!([
        row(10, "balanced", 60.0),                  // its own context: vs its fitness 40 → +0.5
        row(11, "wild", 60.0),                      // another context: sets the baseline only
        {"id": wire::brain_id(&brain(99)), "context": context("balanced"), "meanFitness": 1, "count": 1},
    ])), T0 + 1);
    assert_eq!(answer["feedbackAccepted"], 2);
    assert_eq!(answer["feedbackRejected"], json!([{"index": 2, "reason": "feedback-unknown"}]));
    // The next generation's report, in the next request: vs the baseline 60 → +0.5.
    f.contribute(OTHER, &contribution(&[], &[], json!([row(11, "wild", 90.0)])), T0 + 2);
    let pool = f.recall(&recall_body(&track, None, "balanced", 2));
    assert_eq!(ids(&pool)[0], id(10), "good feedback lifts the brain");
    let fb = &pool["pool"][0]["feedback"];
    assert!((fb["weight"].as_f64().unwrap() - 0.15).abs() < 1e-12, "{fb}");
    assert_eq!((fb["count"].as_u64(), fb["contributors"].as_u64()), (Some(1), Some(1)));
    let wild = f.recall(&recall_body(&track, None, "wild", 2));
    let entry = wild["pool"].as_array().unwrap().iter().find(|e| e["id"] == id(11)).unwrap();
    assert!((entry["feedback"]["weight"].as_f64().unwrap() - 0.15).abs() < 1e-12);
    assert_eq!(entry["feedback"]["count"], 2);
}

#[test]
fn feedback_keeps_8_contexts_a_brain_and_counts_8_contributors() {
    use vectorvroom_brain_core::brain::{MAX_CONTEXTS_PER_BRAIN, MAX_CONTRIBUTORS};
    let mut f = Fixture::new(Config::default());
    f.contribute(TOKEN, &contribution(&[], &[item(10, 40.0, None)], json!([])), T0);
    // 40 contexts, one a request: all but the 8 reported last are dropped.
    for i in 0..40u64 {
        let ctx = json!({"profile": "balanced", "track": format!("t{i}"), "maxSpeed": 15, "traction": 0.5, "seconds": 20});
        f.contribute(OTHER, &contribution(&[], &[], json!([{"id": id(10), "context": ctx, "meanFitness": 50, "count": 2}])), T0 + 1 + i);
    }
    assert_eq!(f.store.feedback.len(), MAX_CONTEXTS_PER_BRAIN);
    let held = |t: &str| f.store.feedback.values().any(|r| r.context.contains(&format!("\"track\":\"{t}\"")));
    assert!(!held("t0") && !held("t31") && held("t32") && held("t39"));
    let reopened = Brain::open(Config::default(), &mut f.store, T0 + 100).unwrap();
    let query = |brain: &Brain, t: &str| {
        let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "track": encode_f32(&unit(1, wire::TRACK_DIM)),
            "context": {"profile": "balanced", "track": t, "maxSpeed": 15, "traction": 0.5, "seconds": 20}})).unwrap();
        json!(brain.recall(&parse_recall(&body).unwrap(), &f.store).unwrap())["pool"][0]["feedback"]["count"].clone()
    };
    assert_eq!((query(&reopened, "t39"), query(&reopened, "t0")), (json!(1), json!(0)));
    // Contributors: counted up to 8.
    let ctx = context("balanced");
    for i in 0..30u64 {
        let token = format!("{i:032x}");
        f.contribute(&token, &contribution(&[], &[], json!([{"id": id(10), "context": ctx, "meanFitness": 50, "count": 1}])), T0 + 200 + i);
    }
    let row = f.store.feedback.values().find(|r| r.count == 30).expect("the balanced context");
    assert_eq!(row.contributors.len(), MAX_CONTRIBUTORS);
    let pool = f.recall(&recall_body(&unit(1, wire::TRACK_DIM), None, "balanced", 1));
    assert_eq!(pool["pool"][0]["feedback"]["contributors"], MAX_CONTRIBUTORS);
    assert_eq!(pool["pool"][0]["feedback"]["count"], 30);
}

#[test]
fn a_full_brain_evicts_the_least_valuable_but_keeps_each_tracks_best_and_the_new() {
    let mut f = Fixture::new(Config { max_brains: 4, max_tracks: 10, keep_per_track: 1 });
    let (a, b) = (unit(1, wire::TRACK_DIM), unit(2, wire::TRACK_DIM));
    // Track b's only brain is weak but the best of its track: kept.
    f.contribute(TOKEN, &contribution(&[a.clone(), b.clone()],
        &[item(10, 90.0, Some(0)), item(11, 20.0, Some(0)), item(12, -50.0, Some(1)), item(13, 30.0, None)], json!([])), T0);
    assert_eq!(f.brain.len(), 4);
    // Two more, weaker than everything: they are new, so kept; the least
    // valuable others go (11 at 20 and 13 at 30; 12 is track b's best).
    f.contribute(TOKEN, &contribution(&[], &[item(14, -90.0, None), item(15, -80.0, None)], json!([])), T0 + 1);
    assert_eq!(f.brain.len(), 4);
    for (seed, held) in [(10, true), (11, false), (12, true), (13, false), (14, true), (15, true)] {
        assert_eq!(f.brain.contains(&id(seed)), held, "brain {seed}");
        assert_eq!(f.store.brains.contains_key(&id(seed)), held, "stored brain {seed}");
    }
}

#[test]
fn feedback_changes_what_is_evicted_and_among_equals_the_oldest_goes() {
    let mut f = Fixture::new(Config { max_brains: 3, max_tracks: 10, keep_per_track: 0 });
    f.contribute(TOKEN, &contribution(&[], &[item(10, 10.0, None)], json!([])), T0);
    f.contribute(TOKEN, &contribution(&[], &[item(11, 10.0, None)], json!([])), T0 + 1);
    f.contribute(TOKEN, &contribution(&[], &[item(12, 10.0, None)], json!([])), T0 + 2);
    // Brain 10 is the oldest, but its offspring did well.
    let good = json!([{"id": id(10), "context": context("balanced"), "meanFitness": 30, "count": 4}]);
    f.contribute(OTHER, &contribution(&[], &[], good), T0 + 3);
    f.contribute(TOKEN, &contribution(&[], &[item(13, 10.0, None)], json!([])), T0 + 4);
    assert!(f.brain.contains(&id(10)));
    assert!(!f.brain.contains(&id(11)), "the oldest of the equals");
    assert!(f.brain.contains(&id(12)) && f.brain.contains(&id(13)));
    assert!(f.store.feedback.keys().all(|k| k.0 != id(11)));
}

#[test]
fn full_tracks_make_room_from_an_unused_one_or_keep_the_brain_without_a_track() {
    let mut f = Fixture::new(Config { max_brains: 100, max_tracks: 2, keep_per_track: 1 });
    let t = |s| unit(s, wire::TRACK_DIM);
    f.contribute(TOKEN, &contribution(&[t(1), t(2)], &[item(10, 1.0, Some(0)), item(11, 1.0, Some(1))], json!([])), T0);
    // Both tracks have brains: a third track is not stored, its brain is.
    f.contribute(TOKEN, &contribution(&[t(3)], &[item(12, 1.0, Some(0))], json!([])), T0 + 1);
    assert_eq!(f.brain.track_count(), 2);
    assert!(f.brain.contains(&id(12)));
    assert_eq!(f.brain.track_of(&id(12)), None);
    // A track only listed (no brain on it) takes no room from used ones.
    let mut g = Fixture::new(Config { max_brains: 100, max_tracks: 2, keep_per_track: 1 });
    g.contribute(TOKEN, &contribution(&[t(1), t(2)], &[item(10, 1.0, Some(0))], json!([])), T0);
    g.contribute(TOKEN, &contribution(&[t(3)], &[item(12, 1.0, Some(0))], json!([])), T0 + 1);
    assert_eq!(g.brain.track_count(), 2);
    assert!(g.brain.track_of(&id(12)).is_some(), "the unused track made room");
    assert!(g.brain.track_of(&id(10)).is_some());
}

#[test]
fn a_reopened_brain_answers_exactly_as_before() {
    let mut f = Fixture::new(Config { max_brains: 6, max_tracks: 3, keep_per_track: 1 });
    let (a, b) = (unit(1, wire::TRACK_DIM), unit(2, wire::TRACK_DIM));
    let mut items: Vec<Item> = (0..8).map(|i| item(20 + i, 10.0 * i as f64 - 20.0, Some((i % 2) as usize))).collect();
    items[3].dynamics = Some(unit(5, wire::DYNAMICS_DIM));
    items[5].profile = "wild";
    f.contribute(TOKEN, &contribution(&[a.clone(), b.clone()], &items, json!([])), T0);
    let rows: Vec<Value> = (0..8).map(|i| json!({"id": id(20 + i), "context": context("balanced"), "meanFitness": 5 * i, "count": 2})).collect();
    f.contribute(OTHER, &contribution(&[], &[], json!(rows)), T0 + 10);
    let queries = [recall_body(&a, None, "balanced", 64), recall_body(&b, Some(&unit(5, wire::DYNAMICS_DIM)), "wild", 3), recall_body(&unit(9, wire::TRACK_DIM), None, "calm", 64)];
    let before: Vec<Value> = queries.iter().map(|q| f.recall(q)).collect();
    let stats = json!(f.brain.stats(T0 + 20, &f.store).unwrap());
    let reopened = Brain::open(Config { max_brains: 6, max_tracks: 3, keep_per_track: 1 }, &mut f.store, T0 + 20).unwrap();
    for (q, b) in queries.iter().zip(&before) {
        assert_eq!(&json!(reopened.recall(&parse_recall(q).unwrap(), &f.store).unwrap()), b);
    }
    assert_eq!(json!(reopened.stats(T0 + 20, &f.store).unwrap()), stats);
}

#[test]
fn a_store_that_fails_mid_request_leaves_a_brain_that_reopens_consistently() {
    for fail_after in 0..12 {
        let mut store = MemStore::default();
        let mut brain = Brain::open(Config::default(), &mut store, T0).unwrap();
        let (a, b) = (unit(1, wire::TRACK_DIM), unit(2, wire::TRACK_DIM));
        let body = contribution(&[a.clone(), b], &(0..6).map(|i| item(30 + i, i as f64, Some((i % 2) as usize))).collect::<Vec<_>>(), json!([]));
        store.fail_after = Some(fail_after);
        let result = brain.contribute(parse_contribute(&body).unwrap(), &contributor_id(TOKEN), T0, &mut store);
        store.fail_after = None;
        // The Worker drops its brain after a store error and reopens it.
        let reopened = Brain::open(Config::default(), &mut store, T0).unwrap();
        assert_eq!(reopened.len(), store.brains.len(), "fail after {fail_after}");
        let pool = json!(reopened.recall(&parse_recall(&recall_body(&a, None, "balanced", 64)).unwrap(), &store).unwrap());
        for entry in pool["pool"].as_array().unwrap() {
            assert!(store.brains.contains_key(entry["id"].as_str().unwrap()));
        }
        if result.is_ok() {
            assert_eq!(reopened.len(), 6);
        }
    }
}

#[test]
fn stats_count_contributors_today_and_contributions_in_24_hours() {
    let mut f = Fixture::new(Config::default());
    let day = 86_400_000;
    let midnight = T0 - T0 % day;
    f.contribute(TOKEN, &contribution(&[], &[item(10, 1.0, None)], json!([])), midnight - 1000);
    f.contribute(OTHER, &contribution(&[], &[], json!([])), midnight + 1000);
    f.contribute(OTHER, &contribution(&[], &[], json!([])), midnight + 2000);
    let s = json!(f.brain.stats(midnight + 3000, &f.store).unwrap());
    assert_eq!(s, json!({"protocol": 1, "brains": 1, "tracks": 0, "contributorsToday": 1, "contributions24h": 3}));
    // A day later the first contribution has left the window, in memory and in the store.
    f.contribute(OTHER, &contribution(&[], &[], json!([])), midnight - 1000 + day);
    assert_eq!(f.brain.stats(midnight - 1000 + day, &f.store).unwrap().contributions24h, 3);
    // Counted by the minute: the store holds at most 1 440 counts.
    assert!(f.store.minutes.keys().all(|m| m + 1440 > (midnight - 1000 + day) / 60_000));
}

#[test]
fn answers_hold_no_negative_zero_and_fit_in_256_kib() {
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    // The largest meta a brain can carry, on 64 brains.
    let long_meta = json!({"generation": 1e9, "parentIds": (0..8).map(|i| wire::brain_id(&brain(900 + i))).collect::<Vec<_>>(),
        "fastestLap": 999999.123456789, "source": "demonstration",
        "learning": {"context": {"profile": "reckless", "track": "x".repeat(180), "maxSpeed": 99.123456789, "traction": 0.123456789,
            "seconds": 599.123456789, "collisions": format!("solid/k65536/{}", "a".repeat(26))}, "styleScore": 0.123456789,
            "driving": {"averageSpeed": 0.123456789, "nearWallRate": 0.123456789, "slideRate": 0.123456789, "smoothness": 0.123456789,
                "steeringChanges": 123456789.123, "aliveSeconds": 123456789.123, "crashed": true, "carContact": true, "nearCarRate": 0.123456789}}});
    for chunk in 0..4 {
        let brains: Vec<Value> = (0..16).map(|i| json!({"vector": encode_f32(&brain(100 + chunk * 16 + i)), "fitness": -123456.123456789, "track": 0, "meta": long_meta})).collect();
        let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": TOKEN, "tracks": [encode_f32(&track)], "brains": brains})).unwrap();
        f.contribute(TOKEN, &body, T0);
    }
    let text = serde_json::to_string(&f.brain.recall(&parse_recall(&recall_body(&track, None, "balanced", 64)).unwrap(), &f.store).unwrap()).unwrap();
    assert_eq!(ids(&serde_json::from_str(&text).unwrap()).len(), 64);
    assert!(text.len() <= wire::limits::RESPONSE_BYTES, "{} bytes", text.len());
    // -0 in: a fitness of -0 is stored and answered as 0.
    let zero = br#"{"protocol":1,"brainSchema":6,"token":"0123456789abcdef0123456789abcdef","brains":[{"vector":"VECTOR","fitness":-0}]}"#;
    let zero = String::from_utf8(zero.to_vec()).unwrap().replace("VECTOR", &encode_f32(&brain(5)));
    let mut g = Fixture::new(Config::default());
    g.contribute(TOKEN, zero.as_bytes(), T0);
    let text = serde_json::to_string(&g.brain.recall(&parse_recall(&recall_body(&track, None, "balanced", 5)).unwrap(), &g.store).unwrap()).unwrap();
    assert!(!text.contains("-0.0") && !text.contains("\"fitness\":-0"), "{}", &text[..200]);
}

#[test]
fn the_context_match_is_the_browsers() {
    // tests/fixtures/cloud-brain/match.json: matchContext(...).factor from
    // learning/policy.js for pairs of cleaned contexts.
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/cloud-brain/match.json");
    let rows: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(rows.len() >= 20);
    for row in rows {
        let memory: Option<Context> = (!row["memory"].is_null()).then(|| wire::wire_context(Some(&row["memory"])).unwrap());
        let query = wire::wire_context(Some(&row["query"])).unwrap();
        let got = match_factor(memory.as_ref(), &query);
        assert!((got - row["factor"].as_f64().unwrap()).abs() < 1e-12, "{row}: got {got}");
    }
}

#[test]
fn hostile_bytes_never_panic() {
    // Every fixture body with one byte changed (or cut short), through the
    // parsers and, when it parses, through the brain.
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/cloud-brain");
    let mut bodies: Vec<Vec<u8>> = Vec::new();
    for kind in ["valid", "invalid"] {
        for e in std::fs::read_dir(root.join(kind)).unwrap() {
            let fixture: Value = serde_json::from_str(&std::fs::read_to_string(e.unwrap().path()).unwrap()).unwrap();
            if let Some(text) = fixture["body"].as_str() {
                bodies.push(text.as_bytes().to_vec());
            }
        }
    }
    let mut f = Fixture::new(Config { max_brains: 50, max_tracks: 5, keep_per_track: 1 });
    let mut r = stream(7);
    let mut next = move |n: usize| ((r() + 1.0) / 2.0 * n as f32) as usize % n.max(1);
    let (mut parsed, mut runs) = (0, 0);
    for round in 0..6000 {
        let mut body = bodies[next(bodies.len())].clone();
        match round % 3 {
            0 => {
                let at = next(body.len());
                body[at] = next(256) as u8;
            }
            1 => body.truncate(next(body.len())),
            _ => {
                let at = next(body.len());
                body.insert(at, b"-0e,:[]{}\"\\"[next(11)]);
            }
        }
        runs += 1;
        if let Ok(c) = parse_contribute(&body) {
            parsed += 1;
            let _ = f.brain.contribute(c, &contributor_id(TOKEN), T0 + round as u64, &mut f.store).unwrap();
        }
        if let Ok(q) = parse_recall(&body) {
            parsed += 1;
            let _ = f.brain.recall(&q, &f.store).unwrap();
        }
        let _ = wire::parse_forget(&body);
    }
    assert_eq!(runs, 6000);
    assert!(parsed > 100, "only {parsed} edited bodies still parsed");
    // Deep nesting stops at serde_json's limit, never the stack.
    let deep = format!("{}{}", "[".repeat(30_000), "]".repeat(30_000));
    assert_eq!(parse_contribute(deep.as_bytes()).unwrap_err(), wire::Reason::NotJson);
    f.store.load(0, &mut |_| Ok(())).unwrap();
}

// ─── from the second review ─────────────────────────────────────────────────

fn unit_between(q: &[f32], p: &[f32], theta: f32) -> Vec<f32> {
    q.iter().zip(p).map(|(a, b)| theta.cos() * a + theta.sin() * b).collect()
}
/// A unit vector orthogonal to `q` (Gram-Schmidt on another stream).
fn orthogonal(q: &[f32], seed: u64) -> Vec<f32> {
    let r = unit(seed, q.len());
    let dot: f32 = r.iter().zip(q).map(|(a, b)| a * b).sum();
    let v: Vec<f32> = r.iter().zip(q).map(|(a, b)| a - dot * b).collect();
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / n).collect()
}

#[test]
fn a_request_never_frees_a_track_it_lists() {
    // One track only: A is listed first (no brain on it yet), B second. B
    // must not take A's place, since A's brain is attached after the tracks.
    let mut f = Fixture::new(Config { max_brains: 100, max_tracks: 1, keep_per_track: 1 });
    let (a, b) = (unit(1, wire::TRACK_DIM), unit(2, wire::TRACK_DIM));
    f.contribute(TOKEN, &contribution(&[a.clone(), b], &[item(10, 1.0, Some(0)), item(11, 1.0, Some(1))], json!([])), T0);
    assert_eq!(f.brain.track_count(), 1);
    let held = f.brain.track_of(&id(10)).expect("A is held").to_string();
    assert!(f.store.tracks.contains_key(&held));
    assert_eq!(f.brain.track_of(&id(11)), None, "no room for B");
    assert_eq!(f.store.brains[&id(11)].0.track, None);
    assert_eq!(ids(&f.recall(&recall_body(&a, None, "balanced", 5)))[0], id(10));
    // An old unused track matched again is listed too: a new track frees another.
    let mut g = Fixture::new(Config { max_brains: 100, max_tracks: 2, keep_per_track: 1 });
    let (x, z, n) = (unit(3, wire::TRACK_DIM), unit(4, wire::TRACK_DIM), unit(5, wire::TRACK_DIM));
    g.contribute(TOKEN, &contribution(&[x.clone(), z.clone()], &[], json!([])), T0);
    g.contribute(TOKEN, &contribution(&[x.clone(), n], &[item(12, 1.0, Some(0)), item(13, 1.0, Some(1))], json!([])), T0 + 1);
    assert!(g.brain.track_of(&id(12)).is_some_and(|t| g.store.tracks.contains_key(t)));
    assert!(g.brain.track_of(&id(13)).is_some_and(|t| g.store.tracks.contains_key(t)));
    assert_eq!(ids(&g.recall(&recall_body(&x, None, "balanced", 1))), vec![id(12)]);
    // Live and reopened agree.
    let reopened = Brain::open(Config { max_brains: 100, max_tracks: 2, keep_per_track: 1 }, &mut g.store, T0 + 2).unwrap();
    for q in [recall_body(&x, None, "balanced", 5), recall_body(&z, None, "balanced", 5)] {
        assert_eq!(json!(reopened.recall(&parse_recall(&q).unwrap(), &g.store).unwrap()), g.recall(&q));
    }
}

#[test]
fn the_oldest_unused_track_makes_room() {
    let mut f = Fixture::new(Config { max_brains: 100, max_tracks: 2, keep_per_track: 1 });
    let t = |s| unit(s, wire::TRACK_DIM);
    f.contribute(TOKEN, &contribution(&[t(1)], &[], json!([])), T0);
    f.contribute(TOKEN, &contribution(&[t(2)], &[], json!([])), T0 + 1);
    f.contribute(TOKEN, &contribution(&[t(3)], &[item(10, 1.0, Some(0))], json!([])), T0 + 2);
    let held: Vec<&String> = f.store.tracks.keys().collect();
    assert_eq!(held.len(), 2);
    assert!(f.store.tracks.contains_key(&wire::fingerprint("track_", &t(2))), "the newer unused track stays");
    assert!(!f.store.tracks.contains_key(&wire::fingerprint("track_", &t(1))), "the oldest goes");
}

#[test]
fn one_feedback_row_counts_per_brain_and_context_in_a_request() {
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    f.contribute(TOKEN, &contribution(std::slice::from_ref(&track), &[item(10, 40.0, Some(0))], json!([])), T0);
    let row = |profile: &str, mean: f64| json!({"id": id(10), "context": context(profile), "meanFitness": mean, "count": 8});
    let answer = f.contribute(OTHER, &contribution(&[], &[], json!([row("balanced", 60.0), row("balanced", 60.0), row("wild", 60.0), row("balanced", 100.0)])), T0 + 1);
    assert_eq!(answer["feedbackAccepted"], 2);
    assert_eq!(answer["feedbackRejected"], json!([{"index": 1, "reason": "feedback-duplicate"}, {"index": 3, "reason": "feedback-duplicate"}]));
    let fb = &f.recall(&recall_body(&track, None, "balanced", 1))["pool"][0]["feedback"];
    assert!((fb["weight"].as_f64().unwrap() - 0.15).abs() < 1e-12, "{fb}");
    assert_eq!(fb["count"], 1);
}

#[test]
fn a_context_without_a_track_key_is_never_exact() {
    // matchContext needs a track key for an exact match: the first row only
    // sets a baseline, as in any other context.
    let mut f = Fixture::new(Config::default());
    let empty = json!({"profile": "balanced", "track": "", "maxSpeed": 15, "traction": 0.5, "seconds": 20});
    let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": TOKEN,
        "brains": [{"vector": encode_f32(&brain(10)), "fitness": 40, "meta": {"learning": {"context": empty}}}]})).unwrap();
    f.contribute(TOKEN, &body, T0);
    let rows = |mean: f64| json!([{"id": id(10), "context": empty, "meanFitness": mean, "count": 3}]);
    f.contribute(OTHER, &contribution(&[], &[], rows(60.0)), T0 + 1);
    let recall = |f: &Fixture| {
        let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "track": encode_f32(&unit(1, wire::TRACK_DIM)), "context": empty})).unwrap();
        f.recall(&body)["pool"][0]["feedback"].clone()
    };
    assert_eq!(recall(&f)["weight"], 0.0);
    f.contribute(OTHER, &contribution(&[], &[], rows(90.0)), T0 + 2);
    assert!((recall(&f)["weight"].as_f64().unwrap() - 0.15).abs() < 1e-12);
}

#[test]
fn in_another_context_each_row_is_measured_against_the_last() {
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    f.contribute(TOKEN, &contribution(std::slice::from_ref(&track), &[item(10, 40.0, Some(0))], json!([])), T0);
    for (i, mean) in [60.0, 90.0, 120.0].into_iter().enumerate() {
        let rows = json!([{"id": id(10), "context": context("wild"), "meanFitness": mean, "count": 8}]);
        f.contribute(OTHER, &contribution(&[], &[], rows), T0 + 1 + i as u64);
    }
    // 60 sets the baseline; 90: 0.3 × 30/60 = 0.15; 120: 0.3 × 30/90 + 0.7 × 0.15.
    let fb = &f.recall(&recall_body(&track, None, "wild", 1))["pool"][0]["feedback"];
    assert!((fb["weight"].as_f64().unwrap() - (0.1 + 0.105)).abs() < 1e-12, "{fb}");
    assert_eq!((fb["count"].as_u64(), fb["contributors"].as_u64()), (Some(3), Some(1)), "three rows, one contributor");
}

#[test]
fn feedback_in_another_context_does_not_move_the_ranking() {
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    f.contribute(TOKEN, &contribution(std::slice::from_ref(&track), &[item(10, 60.0, Some(0)), item(11, 50.0, Some(0))], json!([])), T0);
    // Brain 10's offspring did badly, but when driving wild.
    let rows = json!([{"id": id(10), "context": context("wild"), "meanFitness": 60, "count": 8},
        {"id": id(11), "context": context("balanced"), "meanFitness": 50, "count": 8}]);
    f.contribute(OTHER, &contribution(&[], &[], rows), T0 + 1);
    let rows = json!([{"id": id(10), "context": context("wild"), "meanFitness": -500, "count": 8}]);
    f.contribute(OTHER, &contribution(&[], &[], rows), T0 + 2);
    assert_eq!(ids(&f.recall(&recall_body(&track, None, "balanced", 2))), vec![id(10), id(11)]);
    assert_eq!(ids(&f.recall(&recall_body(&track, None, "wild", 2)))[0], id(11), "in its own context it sinks");
}

#[test]
fn the_25_nearest_dynamics_count_in_order() {
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    let q = unit(2, wire::DYNAMICS_DIM);
    let p = orthogonal(&q, 3);
    // 30 brains alike but for their dynamics, each a little further from q.
    let items: Vec<Item> = (0..30u64)
        .map(|i| {
            let mut b = item(100 + i, 50.0, Some(0));
            b.dynamics = Some(unit_between(&q, &p, 0.04 * (i as f32 + 1.0)));
            b
        })
        .collect();
    for chunk in items.chunks(16) {
        let chunk: Vec<Item> = chunk.iter().map(|b| Item { vector: b.vector.clone(), fitness: b.fitness, track: b.track, dynamics: b.dynamics.clone(), profile: b.profile }).collect();
        f.contribute(TOKEN, &contribution(std::slice::from_ref(&track), &chunk, json!([])), T0);
    }
    let pool = ids(&f.recall(&recall_body(&track, Some(&q), "balanced", 30)));
    let expected: Vec<String> = (0..25u64).map(|i| id(100 + i)).collect();
    assert_eq!(&pool[..25], &expected[..], "the 25 nearest, nearest first");
    let mut rest: Vec<String> = (25..30u64).map(|i| id(100 + i)).collect();
    rest.sort();
    assert_eq!(&pool[25..], &rest[..], "past 25 no dynamics term: ties by id");
}

#[test]
fn equal_distances_rank_the_same_after_every_rebuild() {
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    let same = unit(2, wire::DYNAMICS_DIM);
    for chunk in 0..3u64 {
        let items: Vec<Item> = (0..14u64)
            .map(|i| {
                let mut b = item(200 + chunk * 14 + i, 50.0, Some(0));
                b.dynamics = Some(same.clone());
                b
            })
            .collect();
        f.contribute(TOKEN, &contribution(std::slice::from_ref(&track), &items, json!([])), T0);
    }
    let q = recall_body(&track, Some(&same), "balanced", 64);
    let live = f.recall(&q);
    for _ in 0..6 {
        let reopened = Brain::open(Config::default(), &mut f.store, T0 + 1).unwrap();
        assert_eq!(json!(reopened.recall(&parse_recall(&q).unwrap(), &f.store).unwrap()), live);
    }
}

#[test]
fn an_evicted_brain_leaves_no_feedback_behind() {
    let mut f = Fixture::new(Config { max_brains: 2, max_tracks: 10, keep_per_track: 0 });
    f.contribute(TOKEN, &contribution(&[], &[item(10, 1.0, None), item(11, 90.0, None)], json!([])), T0);
    let rows = json!([{"id": id(10), "context": context("balanced"), "meanFitness": -50, "count": 4}]);
    f.contribute(OTHER, &contribution(&[], &[], rows), T0 + 1);
    f.contribute(TOKEN, &contribution(&[], &[item(12, 90.0, None)], json!([])), T0 + 2);
    assert!(!f.brain.contains(&id(10)));
    // Contributed again, it starts with no feedback.
    f.contribute(TOKEN, &contribution(&[], &[item(10, 1.0, None)], json!([])), T0 + 3);
    let pool = f.recall(&recall_body(&unit(1, wire::TRACK_DIM), None, "balanced", 5));
    let entry = pool["pool"].as_array().unwrap().iter().find(|e| e["id"] == id(10)).expect("held again");
    assert_eq!(entry["feedback"], json!({"weight": 0.0, "count": 0, "contributors": 0}));
    assert!(f.store.feedback.keys().all(|k| k.0 != id(10)));
}

#[test]
fn a_contribution_at_midnight_is_today() {
    let mut f = Fixture::new(Config::default());
    let day = 86_400_000;
    let midnight = T0 - T0 % day + day;
    f.contribute(TOKEN, &contribution(&[], &[], json!([])), midnight - 1);
    f.contribute(OTHER, &contribution(&[], &[], json!([])), midnight);
    let s = f.brain.stats(midnight + 1, &f.store).unwrap();
    assert_eq!((s.contributors_today, s.contributions24h), (1, 2));
}

#[test]
fn the_score_is_the_documented_product() {
    // (0.5 + 0.5·track sim) × (0.5 + 0.5·tanh(fitness / 100)) × (1 + 0.3·dynamics sim)
    // × matchContext factor × (1 + 0.3·feedback weight).
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    let q = unit(2, wire::DYNAMICS_DIM);
    let theta: f32 = 0.6;
    let mut b = item(10, 0.5, Some(0));
    b.dynamics = Some(unit_between(&q, &orthogonal(&q, 3), theta));
    f.contribute(TOKEN, &contribution(std::slice::from_ref(&track), &[b], json!([])), T0);
    // Asked in the wild context: the brain's is balanced (factor 0.45), and
    // the one wild row only set a baseline (weight 0).
    let rows = json!([{"id": id(10), "context": context("wild"), "meanFitness": 1.0, "count": 2}]);
    let answer = f.contribute(OTHER, &contribution(&[], &[], rows), T0 + 1);
    assert_eq!(answer["feedbackAccepted"], 1);
    let pool = f.recall(&recall_body(&track, Some(&q), "wild", 1));
    let score = pool["pool"][0]["score"].as_f64().unwrap();
    let expected = 1.0 * (0.5 + 0.5 * (0.5f64 / 100.0).tanh()) * (1.0 + 0.3 * f64::from(theta.cos())) * 0.45 * 1.0;
    assert!((score - expected).abs() < 1e-5, "wild: {score} vs {expected}");
    // In its own context, fitness 0.5: (1 − 0.5) / max(1, 0.5) = 0.5, a weight of 0.15.
    let rows = json!([{"id": id(10), "context": context("balanced"), "meanFitness": 1.0, "count": 2}]);
    f.contribute(OTHER, &contribution(&[], &[], rows), T0 + 2);
    let pool = f.recall(&recall_body(&track, Some(&q), "balanced", 1));
    let score = pool["pool"][0]["score"].as_f64().unwrap();
    let expected = 1.0 * (0.5 + 0.5 * (0.5f64 / 100.0).tanh()) * (1.0 + 0.3 * f64::from(theta.cos())) * 1.0 * (1.0 + 0.3 * 0.15);
    assert!((score - expected).abs() < 1e-5, "balanced: {score} vs {expected}");
    assert!((pool["pool"][0]["feedback"]["weight"].as_f64().unwrap() - 0.15).abs() < 1e-12);
}

#[test]
fn a_recall_searches_the_5_nearest_tracks() {
    let mut f = Fixture::new(Config::default());
    let q = unit(1, wire::TRACK_DIM);
    // Six tracks, each further from q; one brain on each.
    let tracks: Vec<Vec<f32>> = (0..6).map(|i| unit_between(&q, &orthogonal(&q, 10 + i), 0.3 + 0.2 * i as f32)).collect();
    for (i, t) in tracks.iter().enumerate() {
        f.contribute(TOKEN, &contribution(std::slice::from_ref(t), &[item(20 + i as u64, 50.0, Some(0))], json!([])), T0 + i as u64);
    }
    let pool = ids(&f.recall(&recall_body(&q, None, "balanced", 64)));
    assert_eq!(pool, (0..5).map(|i| id(20 + i)).collect::<Vec<_>>(), "the five nearest, nearest first; not the sixth");
}

#[test]
fn a_brains_value_weighs_each_context_by_its_count() {
    // X: ten reports a little above its fitness in its own context (+0.097,
    // count 10), two in another that went badly (−0.2, count 2). Weighted
    // by count X is worth more than Y (no feedback); unweighted, less.
    let mut f = Fixture::new(Config { max_brains: 2, max_tracks: 10, keep_per_track: 0 });
    f.contribute(TOKEN, &contribution(&[], &[item(11, 10.0, None)], json!([])), T0);
    f.contribute(TOKEN, &contribution(&[], &[item(10, 10.0, None)], json!([])), T0 + 1);
    for i in 0..10u64 {
        let rows = json!([{"id": id(10), "context": context("balanced"), "meanFitness": 11, "count": 3}]);
        f.contribute(OTHER, &contribution(&[], &[], rows), T0 + 2 + i);
    }
    for (i, mean) in [10.0, 10.0 / 3.0].into_iter().enumerate() {
        let rows = json!([{"id": id(10), "context": context("wild"), "meanFitness": mean, "count": 3}]);
        f.contribute(OTHER, &contribution(&[], &[], rows), T0 + 20 + i as u64);
    }
    f.contribute(TOKEN, &contribution(&[], &[item(12, 10.0, None)], json!([])), T0 + 30);
    assert!(f.brain.contains(&id(10)), "X is worth more");
    assert!(!f.brain.contains(&id(11)), "Y goes");
}

// ─── from the third review ──────────────────────────────────────────────────

#[test]
fn contributions_are_counted_by_the_minute_whatever_their_number() {
    let mut f = Fixture::new(Config::default());
    for i in 0..3_000u64 {
        let token = format!("{:032x}", i % 7);
        f.contribute(&token, &contribution(&[], &[], json!([])), T0 + i * 40); // 2 minutes
    }
    let s = f.brain.stats(T0 + 3_000 * 40, &f.store).unwrap();
    assert_eq!((s.contributions24h, s.contributors_today), (3_000, 7));
    assert!(f.store.minutes.len() <= 3, "{} minute rows", f.store.minutes.len());
    let reopened = Brain::open(Config::default(), &mut f.store, T0 + 3_000 * 40).unwrap();
    assert_eq!(reopened.stats(T0 + 3_000 * 40, &f.store).unwrap().contributions24h, 3_000);
}

#[test]
fn many_equal_distances_rank_the_same_after_every_rebuild() {
    // More tied neighbours than the search asks for first (2k + 16 = 66).
    let mut f = Fixture::new(Config::default());
    let track = unit(1, wire::TRACK_DIM);
    let same = unit(2, wire::DYNAMICS_DIM);
    for chunk in 0..6u64 {
        let items: Vec<Item> = (0..16u64)
            .map(|i| {
                let mut b = item(300 + chunk * 16 + i, 50.0, Some(0));
                b.dynamics = Some(same.clone());
                b
            })
            .collect();
        f.contribute(TOKEN, &contribution(std::slice::from_ref(&track), &items, json!([])), T0);
    }
    let q = recall_body(&track, Some(&same), "balanced", 64);
    let live = f.recall(&q);
    for _ in 0..6 {
        let reopened = Brain::open(Config::default(), &mut f.store, T0 + 1).unwrap();
        assert_eq!(json!(reopened.recall(&parse_recall(&q).unwrap(), &f.store).unwrap()), live);
    }
}

#[test]
fn new_contexts_cannot_push_out_ones_that_repeated_reports_built() {
    let mut f = Fixture::new(Config::default());
    f.contribute(TOKEN, &contribution(&[], &[item(10, 40.0, None)], json!([])), T0);
    for i in 0..5u64 {
        let rows = json!([{"id": id(10), "context": context("balanced"), "meanFitness": 50, "count": 3}]);
        f.contribute(OTHER, &contribution(&[], &[], rows), T0 + 1 + i);
    }
    let fresh = |t: String| json!({"id": id(10), "context": {"profile": "wild", "track": t, "maxSpeed": 15, "traction": 0.5, "seconds": 20}, "meanFitness": 1, "count": 1});
    // Eight new contexts at once: seven fill the cap, the eighth has nothing to replace.
    let answer = f.contribute(OTHER, &contribution(&[], &[], json!((0..8).map(|i| fresh(format!("n{i}"))).collect::<Vec<_>>())), T0 + 10);
    assert_eq!(answer["feedbackAccepted"], 7);
    assert_eq!(answer["feedbackRejected"], json!([{"index": 7, "reason": "feedback-full"}]));
    // One more later replaces a context reported once, never the balanced one.
    let answer = f.contribute(OTHER, &contribution(&[], &[], json!([fresh("m0".into())])), T0 + 11);
    assert_eq!(answer["feedbackAccepted"], 1);
    let balanced = |f: &Fixture| f.recall(&recall_body(&unit(1, wire::TRACK_DIM), None, "balanced", 1))["pool"][0]["feedback"]["count"].clone();
    assert_eq!(balanced(&f), 5);
    assert_eq!(f.store.feedback.len(), 8);
    // Not reported for 7 days, even a well-reported context can go: here
    // every other context was reported twice this week.
    let week = 7 * 86_400_000;
    let mut g = Fixture::new(Config::default());
    g.contribute(TOKEN, &contribution(&[], &[item(10, 40.0, None)], json!([])), T0);
    for i in 0..5u64 {
        let rows = json!([{"id": id(10), "context": context("balanced"), "meanFitness": 50, "count": 3}]);
        g.contribute(OTHER, &contribution(&[], &[], rows), T0 + 1 + i);
    }
    for i in 0..14u64 {
        g.contribute(OTHER, &contribution(&[], &[], json!([fresh(format!("o{}", i / 2))])), T0 + week + i);
    }
    let answer = g.contribute(OTHER, &contribution(&[], &[], json!([fresh("x".into())])), T0 + week + 100);
    assert_eq!(answer["feedbackAccepted"], 1);
    assert_eq!(balanced(&g), 0, "the stale context was the one to go");
}

#[test]
fn rows_that_do_not_clean_are_deleted_when_the_brain_is_rebuilt() {
    use vectorvroom_brain_core::brain::{BrainRow, FeedbackRow};
    let mut f = Fixture::new(Config::default());
    f.contribute(TOKEN, &contribution(&[], &[item(10, 40.0, None)], json!([])), T0);
    // A brain row whose meta is not JSON, and 10 feedback rows (an older build's cap).
    let bad = BrainRow { id: id(11), fitness: 1.0, track: None, dynamics: None, meta: "{not json".into(), contributor: "x".into(), created: T0 };
    f.store.brains.insert(id(11), (bad, brain(11)));
    for i in 0..10u64 {
        let row = FeedbackRow { brain: id(10), context_key: format!("{i:016x}"), context: String::new(), weight: 0.1, count: 1, baseline: None, contributors: vec![1], updated: T0 + i };
        f.store.feedback.insert((id(10), row.context_key.clone()), row);
    }
    let reopened = Brain::open(Config::default(), &mut f.store, T0 + 20).unwrap();
    assert!(!reopened.contains(&id(11)) && !f.store.brains.contains_key(&id(11)), "the bad row is gone from both");
    assert_eq!(f.store.feedback.len(), 8, "the 8 most recent stay");
    assert!(!f.store.feedback.contains_key(&(id(10), format!("{:016x}", 0))) && !f.store.feedback.contains_key(&(id(10), format!("{:016x}", 1))));
    // Contributed again, brain 11 is stored whole.
    f.brain = reopened;
    f.contribute(TOKEN, &contribution(&[], &[item(11, 1.0, None)], json!([])), T0 + 21);
    assert!(f.store.brains[&id(11)].0.meta.starts_with('{') && f.brain.contains(&id(11)));
}

#[test]
fn a_day_of_minutes_is_all_that_is_held() {
    let mut f = Fixture::new(Config::default());
    for i in 0..1_500u64 {
        f.contribute(TOKEN, &contribution(&[], &[], json!([])), T0 + i * 60_000);
    }
    let now = T0 + 1_499 * 60_000;
    assert_eq!(f.brain.minutes_held(), 1_440);
    assert_eq!(f.store.minutes.len(), 1_440);
    assert_eq!(f.brain.stats(now, &f.store).unwrap().contributions24h, 1_440);
}
