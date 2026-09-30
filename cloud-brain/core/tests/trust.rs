//! Trust, quotas and forget (CB4 of docs/plan/cloud-brain.md): a claimed
//! fitness is quarantined until other contributors' offspring corroborate
//! it, feedback is kept per contributor and trimmed, a contributor's reports
//! about their own brains are not evidence, each contributor has a daily
//! quota, and forget takes a contributor out. Requests go through the real
//! wire parsers.

use serde_json::{json, Value};
use vectorvroom_brain_core::brain::{contributor_id, tag, Brain, Config, Limited, MemStore, Usage, MAX_CONTRIBUTORS, QUOTA};
use vectorvroom_brain_core::wire::{self, encode_f32, parse_contribute, parse_recall};

const T0: u64 = 1_790_000_000_000; // 2026-09-21, a fixed clock
const DAY: u64 = 86_400_000;
const FORGER: &str = "ffffffffffffffffffffffffffffffff";

fn token(n: u64) -> String {
    format!("{n:032x}")
}
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
fn id(seed: u64) -> String {
    wire::brain_id(&brain(seed))
}
fn track() -> Vec<f32> {
    let mut r = stream(1);
    let v: Vec<f32> = (0..wire::TRACK_DIM).map(|_| r()).collect();
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / n).collect()
}
fn context() -> Value {
    json!({"profile": "balanced", "track": "t1", "maxSpeed": 15, "traction": 0.5, "seconds": 20, "collisions": "off"})
}
/// Brains (seed, claimed fitness) on the one track, trained in `context()`.
fn body(who: &str, brains: &[(u64, f64)], feedback: Value) -> Vec<u8> {
    let brains: Vec<Value> = brains
        .iter()
        .map(|(seed, fitness)| json!({"vector": encode_f32(&brain(*seed)), "fitness": fitness, "track": 0,
            "meta": {"generation": 1, "source": "evolved", "learning": {"context": context(), "styleScore": 0.5}}}))
        .collect();
    let tracks = if brains.is_empty() { vec![] } else { vec![encode_f32(&track())] };
    serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": who, "tracks": tracks, "brains": brains, "feedback": feedback})).unwrap()
}
/// Offspring of brain `seed` averaged `mean` in its own context.
fn row(seed: u64, mean: f64) -> Value {
    json!({"id": id(seed), "context": context(), "meanFitness": mean, "count": 8})
}
fn rows(list: &[(u64, f64)]) -> Value {
    json!(list.iter().map(|(s, m)| row(*s, *m)).collect::<Vec<_>>())
}

struct F {
    brain: Brain,
    store: MemStore,
    config: Config,
}
impl F {
    fn new(config: Config) -> Self {
        let mut store = MemStore::default();
        F { brain: Brain::open(config.clone(), &mut store, T0).unwrap(), store, config }
    }
    fn send(&mut self, who: &str, body: &[u8], now: u64) -> Result<Value, Limited> {
        let c = parse_contribute(body).expect("a valid contribution");
        self.brain.contribute(c, &contributor_id(who), now, &mut self.store).unwrap().map(|a| json!(a))
    }
    fn contribute(&mut self, who: &str, body: &[u8], now: u64) -> Value {
        self.send(who, body, now).expect("within the quota")
    }
    fn forget(&mut self, who: &str) -> Value {
        json!(self.brain.forget(&contributor_id(who), &mut self.store).unwrap())
    }
    fn pool_of(brain: &Brain, store: &MemStore) -> Value {
        let q = json!({"protocol": 1, "brainSchema": 6, "track": encode_f32(&track()), "context": context(), "k": 64});
        json!(brain.recall(&parse_recall(&serde_json::to_vec(&q).unwrap()).unwrap(), store).unwrap())
    }
    fn pool(&self) -> Value {
        Self::pool_of(&self.brain, &self.store)
    }
    fn entry(&self, seed: u64) -> Value {
        self.pool()["pool"].as_array().unwrap().iter().find(|e| e["id"] == id(seed)).cloned().expect("in the pool")
    }
    fn order(&self) -> Vec<String> {
        self.pool()["pool"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect()
    }
    /// A rebuild from the store answers exactly as the live brain.
    fn assert_rebuilds_the_same(&mut self, now: u64) {
        let live = self.pool();
        let reopened = Brain::open(self.config.clone(), &mut self.store, now).unwrap();
        assert_eq!(Self::pool_of(&reopened, &self.store), live);
    }
}
fn num(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

#[test]
fn a_forged_fitness_ranks_on_nothing_until_corroborated_then_on_what_its_offspring_showed() {
    let (a, b, c) = (token(1), token(2), token(3));
    let mut f = F::new(Config::default());
    f.contribute(&a, &body(&a, &[(1, 60.0)], json!([])), T0);
    f.contribute(FORGER, &body(FORGER, &[(2, 1e6)], json!([])), T0 + 1);
    // Nobody else has bred from either: both rank and are served as fitness 0.
    let (honest, forged) = (f.entry(1), f.entry(2));
    assert_eq!((num(&honest["fitness"]), num(&forged["fitness"])), (0.0, 0.0));
    assert_eq!(honest["score"], forged["score"], "the claim of 1e6 buys nothing");
    // Its contributor praising it changes nothing.
    let answer = f.contribute(FORGER, &body(FORGER, &[], rows(&[(2, 1e6)])), T0 + 2);
    assert_eq!(answer["feedbackAccepted"], 1);
    assert_eq!(f.entry(2)["feedback"], json!({"weight": 0.0, "count": 0, "contributors": 0}));
    // One other contributor's offspring: still quarantined, and its weight
    // ((50 − 1e6) / 1e6, about −1) sinks it below the honest brain.
    f.contribute(&b, &body(&b, &[], rows(&[(1, 55.0), (2, 50.0)])), T0 + 3);
    assert_eq!(num(&f.entry(2)["fitness"]), 0.0);
    assert_eq!(f.order(), vec![id(1), id(2)]);
    // A second: corroborated, each is worth what its offspring showed, at most its claim.
    f.contribute(&c, &body(&c, &[], rows(&[(1, 57.0), (2, 50.0)])), T0 + 4);
    let (honest, forged) = (f.entry(1), f.entry(2));
    assert_eq!(num(&honest["fitness"]), 56.0, "the mean of 55 and 57");
    assert_eq!(num(&forged["fitness"]), 50.0, "not 1e6");
    assert_eq!(forged["feedback"]["contributors"], 2);
    assert!(num(&forged["feedback"]["weight"]) < -0.99);
    assert_eq!(f.order(), vec![id(1), id(2)]);
    // Offspring that do better than the claim never raise it.
    let d = token(4);
    f.contribute(&d, &body(&d, &[], rows(&[(1, 90.0)])), T0 + 5);
    assert!(num(&f.entry(1)["fitness"]) <= 60.0);
    f.assert_rebuilds_the_same(T0 + 6);
}

#[test]
fn a_claim_can_only_lower_a_brain_before_it_is_corroborated() {
    let a = token(1);
    let mut f = F::new(Config::default());
    f.contribute(&a, &body(&a, &[(1, -40.0), (2, 0.0), (3, 25.0)], json!([])), T0);
    let fitness: Vec<f64> = [1, 2, 3].iter().map(|s| num(&f.entry(*s)["fitness"])).collect();
    assert_eq!(fitness, vec![-40.0, 0.0, 0.0]);
    // A brain without a track key in its context is never corroborated:
    // feedback cannot test a claim made nowhere in particular.
    let mut g = F::new(Config::default());
    let loose = json!({"protocol": 1, "brainSchema": 6, "token": a, "tracks": [encode_f32(&track())],
        "brains": [{"vector": encode_f32(&brain(5)), "fitness": 80, "track": 0, "meta": {"learning": {"context": {"profile": "balanced", "track": ""}}}}]});
    g.contribute(&a, &serde_json::to_vec(&loose).unwrap(), T0);
    for (i, who) in [token(2), token(3), token(4)].iter().enumerate() {
        let r = json!([{"id": id(5), "context": {"profile": "balanced", "track": ""}, "meanFitness": 80, "count": 4}]);
        g.contribute(who, &body(who, &[], r), T0 + 1 + i as u64);
    }
    assert_eq!(num(&g.entry(5)["fitness"]), 0.0);
}

#[test]
fn each_contributor_counts_once_and_one_outlier_cannot_pull_the_weight() {
    let owner = token(1);
    let mut f = F::new(Config::default());
    f.contribute(&owner, &body(&owner, &[(1, 100.0)], json!([])), T0);
    // B reports 50 generations (+0.1 each), C and D once (+0.05, −0.1).
    let (b, c, d, e) = (token(2), token(3), token(4), token(5));
    for i in 0..50u64 {
        f.contribute(&b, &body(&b, &[], rows(&[(1, 110.0)])), T0 + 1 + i);
    }
    f.contribute(&c, &body(&c, &[], rows(&[(1, 105.0)])), T0 + 100);
    f.contribute(&d, &body(&d, &[], rows(&[(1, 90.0)])), T0 + 101);
    let fb = f.entry(1)["feedback"].clone();
    assert!((num(&fb["weight"]) - 0.05).abs() < 1e-4, "the middle of three: {fb}");
    assert_eq!((fb["count"].as_u64(), fb["contributors"].as_u64()), (Some(52), Some(3)), "52 rows, 3 votes");
    assert_eq!(num(&f.entry(1)["fitness"]), 100.0, "its offspring showed 105 (the middle of 90, 105 and 110): the claim stays");
    // E claims its offspring scored −1e6 (weight −1): trimmed, it moves the
    // weight from 0.05 to −0.025 (the mean of all four would be −0.2375).
    f.contribute(&e, &body(&e, &[], rows(&[(1, -1e6)])), T0 + 102);
    let entry = f.entry(1);
    assert!((num(&entry["feedback"]["weight"]) - -0.025).abs() < 1e-4, "{entry}");
    assert_eq!(num(&entry["fitness"]), 97.5, "the mean of 90 and 105");
    f.assert_rebuilds_the_same(T0 + 103);
}

#[test]
fn the_contributors_who_reported_last_are_kept() {
    let owner = token(100);
    let mut f = F::new(Config::default());
    f.contribute(&owner, &body(&owner, &[(1, 50.0)], json!([])), T0);
    for i in 1..=8u64 {
        f.contribute(&token(i), &body(&token(i), &[], rows(&[(1, 50.0)])), T0 + i);
    }
    // Contributor 1 reports again (the most recent now), then a ninth arrives:
    // contributor 2, who reported least recently, makes room.
    f.contribute(&token(1), &body(&token(1), &[], rows(&[(1, 50.0)])), T0 + 20);
    f.contribute(&token(9), &body(&token(9), &[], rows(&[(1, 50.0)])), T0 + 21);
    let slots: Vec<u16> = f.store.feedback.values().next().unwrap().slots.iter().map(|s| s.who).collect();
    let expect: Vec<u16> = [9, 1, 8, 7, 6, 5, 4, 3].iter().map(|i| tag(&contributor_id(&token(*i)))).collect();
    assert_eq!(slots, expect);
    assert_eq!(slots.len(), MAX_CONTRIBUTORS);
    assert_eq!(f.entry(1)["feedback"]["count"], 10);
    f.assert_rebuilds_the_same(T0 + 22);
}

#[test]
fn a_quota_refuses_a_request_whole_and_starts_over_at_midnight() {
    let quota = Usage { requests: 3, brains: 4, feedback: 5 };
    let mut f = F::new(Config { quota, ..Config::default() });
    let (a, b) = (token(1), token(2));
    let midnight = T0 - T0 % DAY + DAY;
    let now = midnight - 1_500;
    f.contribute(&a, &body(&a, &[(1, 10.0), (2, 10.0), (3, 10.0)], json!([])), now - 10);
    // Two more brains would make 5: refused whole, and nothing is written.
    let before = (f.store.brains.len(), f.store.minutes.clone(), f.store.contributors.clone());
    assert_eq!(f.send(&a, &body(&a, &[(4, 10.0), (5, 10.0)], json!([])), now), Err(Limited { retry_after: 2 }), "1.5 s to midnight");
    assert_eq!((f.store.brains.len(), f.store.minutes.clone(), f.store.contributors.clone()), before);
    // One brain and five rows fit (rows count whether or not they are evidence).
    f.contribute(&a, &body(&a, &[(4, 10.0)], rows(&[(1, 1.0), (2, 1.0), (3, 1.0), (4, 1.0), (9, 1.0)])), now + 1);
    assert!(f.send(&a, &body(&a, &[], rows(&[(1, 2.0)])), now + 2).is_err(), "a sixth row");
    f.contribute(&a, &body(&a, &[], json!([])), now + 3);
    assert_eq!(f.send(&a, &body(&a, &[], json!([])), now + 4).map(|_| ()), Err(Limited { retry_after: 2 }), "a fourth request");
    // Forget works past the quota, and is not counted.
    let used = f.store.contributors[&contributor_id(&a)].used;
    assert_eq!(f.forget(&a)["brains"], 4);
    assert_eq!(f.store.contributors[&contributor_id(&a)].used, used);
    // Another contributor is not affected.
    f.contribute(&b, &body(&b, &[(6, 10.0)], json!([])), now + 6);
    // After midnight the day starts over.
    f.contribute(&a, &body(&a, &[(5, 10.0), (7, 10.0), (8, 10.0), (9, 10.0)], json!([])), midnight);
    assert_eq!(f.store.contributors[&contributor_id(&a)].used, Usage { requests: 1, brains: 4, feedback: 0 });
    assert_eq!(Config::default().quota, QUOTA);
}

#[test]
fn the_contributors_table_holds_today_only() {
    let mut f = F::new(Config::default());
    let midnight = T0 - T0 % DAY + DAY;
    for i in 0..200u64 {
        f.contribute(&token(i), &body(&token(i), &[], json!([])), midnight - 1_000 - i);
    }
    assert_eq!(f.store.contributors.len(), 200);
    f.contribute(&token(999), &body(&token(999), &[], json!([])), midnight + 5);
    assert_eq!(f.store.contributors.len(), 1, "yesterday's contributors are gone");
    assert_eq!(f.brain.stats(midnight + 6, &f.store).unwrap().contributors_today, 1);
}

#[test]
fn forget_takes_a_contributor_out() {
    let (a, b, c) = (token(1), token(2), token(3));
    let mut f = F::new(Config { quota: Usage { requests: 3, ..QUOTA }, ..Config::default() });
    f.contribute(&a, &body(&a, &[(1, 50.0), (2, 40.0)], json!([])), T0);
    f.contribute(&b, &body(&b, &[(3, 45.0), (4, 30.0)], rows(&[(1, 48.0)])), T0 + 1);
    // A reports on both of B's brains (brain 4 only A); C on brain 3.
    f.contribute(&a, &body(&a, &[], rows(&[(3, 44.0), (4, 30.0)])), T0 + 2);
    f.contribute(&c, &body(&c, &[], rows(&[(3, 40.0)])), T0 + 3);
    assert_eq!(f.entry(3)["feedback"]["contributors"], 2);
    let answer = f.forget(&a);
    assert_eq!(answer, json!({"protocol": 1, "brains": 2, "feedback": 2}));
    // A's brains and their feedback are gone; A's values are out of B's brains.
    assert!(!f.brain.contains(&id(1)) && !f.brain.contains(&id(2)));
    assert!(f.store.brains.values().all(|b| b.0.contributor != contributor_id(&a)));
    assert!(f.store.feedback.keys().all(|k| k.0 != id(1) && k.0 != id(2)));
    let three = f.entry(3);
    assert_eq!(three["feedback"]["contributors"], 1);
    assert!((num(&three["feedback"]["weight"]) - (40.0 - 45.0) / 45.0).abs() < 1e-4, "C's alone: {three}");
    assert_eq!(f.entry(4)["feedback"], json!({"weight": 0.0, "count": 0, "contributors": 0}), "a record with no slot left goes");
    assert!(f.store.feedback.keys().all(|k| k.0 != id(4)));
    assert!(f.store.feedback.values().all(|r| r.slots.iter().all(|s| s.id != contributor_id(&a))));
    // The stored context of a rewritten record stays.
    assert!(f.store.feedback.values().all(|r| r.context.as_deref().is_some_and(|c| c.contains("\"t1\""))));
    f.assert_rebuilds_the_same(T0 + 5);
    // Again: nothing left. And forget does not start the quota over.
    assert_eq!(f.forget(&a), json!({"protocol": 1, "brains": 0, "feedback": 0}));
    f.contribute(&a, &body(&a, &[], json!([])), T0 + 7);
    assert!(f.send(&a, &body(&a, &[], json!([])), T0 + 8).is_err(), "the fourth request of the day");
    assert!(f.store.contributors.contains_key(&contributor_id(&a)), "today's count stays until midnight");
}

#[test]
fn a_store_that_fails_mid_forget_reopens_consistently() {
    for fail_after in 0..8 {
        let (a, b) = (token(1), token(2));
        let mut f = F::new(Config::default());
        f.contribute(&a, &body(&a, &[(1, 50.0), (2, 40.0)], json!([])), T0);
        f.contribute(&b, &body(&b, &[(3, 45.0), (4, 30.0)], json!([])), T0 + 1);
        f.contribute(&a, &body(&a, &[], rows(&[(3, 44.0), (4, 30.0)])), T0 + 2);
        f.store.fail_after = Some(fail_after);
        let result = f.brain.forget(&contributor_id(&a), &mut f.store);
        f.store.fail_after = None;
        let reopened = Brain::open(Config::default(), &mut f.store, T0 + 4).unwrap();
        assert_eq!(reopened.len(), f.store.brains.len(), "fail after {fail_after}");
        if result.is_ok() {
            assert_eq!(reopened.len(), 2);
            assert!(f.store.feedback.is_empty());
        }
        // Forgetting again after the failure finishes the job.
        let mut g = F { brain: reopened, store: f.store.clone(), config: Config::default() };
        g.forget(&a);
        assert!(g.store.brains.values().all(|b| b.0.contributor != contributor_id(&a)) && g.store.feedback.is_empty());
    }
}

#[test]
fn eviction_values_trusted_fitness_not_claims() {
    let run = |config: Config| {
        let (a, b, c) = (token(1), token(2), token(3));
        let mut f = F::new(Config { max_brains: 4, keep_per_track: 0, ..config });
        f.contribute(&a, &body(&a, &[(1, 60.0), (2, 50.0)], json!([])), T0);
        f.contribute(&b, &body(&b, &[], rows(&[(1, 58.0), (2, 48.0)])), T0 + 1);
        f.contribute(&c, &body(&c, &[], rows(&[(1, 58.0), (2, 48.0)])), T0 + 2);
        f.contribute(FORGER, &body(FORGER, &[(10, 1e6), (11, 1e6)], json!([])), T0 + 3);
        f.contribute(FORGER, &body(FORGER, &[(12, 1e6), (13, 1e6)], json!([])), T0 + 4);
        [1, 2, 10, 11].map(|s| f.brain.contains(&id(s)))
    };
    assert_eq!(run(Config::default()), [true, true, false, false], "the uncorroborated flood goes first");
    assert_eq!(run(Config { corroborators: 0, ..Config::default() }), [false, false, true, true], "trusting claims, the forged brains would win");
}

#[test]
fn a_flood_from_many_tokens_keeps_the_corroborated_brains() {
    let mut f = F::new(Config { max_brains: 12, keep_per_track: 0, ..Config::default() });
    let owner = token(1);
    f.contribute(&owner, &body(&owner, &[(1, 30.0), (2, 25.0), (3, 20.0)], json!([])), T0);
    for who in [token(2), token(3)] {
        f.contribute(&who, &body(&who, &[], rows(&[(1, 28.0), (2, 22.0), (3, 18.0)])), T0 + 1);
    }
    // 60 forged brains from 30 tokens, 2 a request.
    for i in 0..30u64 {
        let who = token(1_000 + i);
        f.contribute(&who, &body(&who, &[(100 + 2 * i, 1e6), (101 + 2 * i, 1e6)], json!([])), T0 + 10 + i);
    }
    assert_eq!(f.brain.len(), 12);
    assert!([1, 2, 3].iter().all(|s| f.brain.contains(&id(*s))), "the corroborated brains stay");
    // The best of the pool is corroborated: the flood ranks as fitness 0.
    let pool = f.pool();
    assert_eq!(pool["pool"][0]["id"], id(1));
    assert!(pool["pool"].as_array().unwrap().iter().all(|e| num(&e["fitness"]) <= 30.0));
}

/// A token other than `of` whose contributor has the same 16-bit tag.
fn same_tag_as(of: &str) -> String {
    let want = tag(&contributor_id(of));
    (0u64..).map(token).find(|t| t != of && tag(&contributor_id(t)) == want).unwrap()
}

#[test]
fn forget_takes_out_only_the_contributors_own_slots_whatever_their_tag() {
    let (owner, a, c) = (token(1), token(2), token(3));
    let stranger = same_tag_as(&a);
    let mut f = F::new(Config::default());
    f.contribute(&owner, &body(&owner, &[(1, 50.0)], json!([])), T0);
    f.contribute(&a, &body(&a, &[], rows(&[(1, 48.0)])), T0 + 1);
    f.contribute(&c, &body(&c, &[], rows(&[(1, 49.0)])), T0 + 2);
    assert_eq!(num(&f.entry(1)["fitness"]), 48.5, "corroborated");
    // A token with the same tag as A, that never reported, forgets: nothing of A's goes.
    assert_eq!(f.forget(&stranger), json!({"protocol": 1, "brains": 0, "feedback": 0}));
    assert_eq!(f.entry(1)["feedback"]["contributors"], 2);
    assert_eq!(num(&f.entry(1)["fitness"]), 48.5);
    // A forgets: only A's slot goes.
    assert_eq!(f.forget(&a)["feedback"], 1);
    let slots = &f.store.feedback.values().next().unwrap().slots;
    assert_eq!(slots.iter().map(|s| s.id.clone()).collect::<Vec<_>>(), vec![contributor_id(&c)]);
    f.assert_rebuilds_the_same(T0 + 3);
}

#[test]
fn feedback_brings_a_brain_back_to_neutral_at_most() {
    // Two tokens reporting its offspring at -1e6 corroborate an honest brain
    // at -1e6 as far as the trimmed mean goes: it is served as 0, not below.
    let (owner, a, b) = (token(1), token(2), token(3));
    let mut f = F::new(Config::default());
    f.contribute(&owner, &body(&owner, &[(1, 60.0), (2, -30.0)], json!([])), T0);
    for who in [&a, &b] {
        f.contribute(who, &body(who, &[], rows(&[(1, -1e6), (2, -1e6)])), T0 + 1);
    }
    assert_eq!(num(&f.entry(1)["fitness"]), 0.0);
    assert_eq!(num(&f.entry(2)["fitness"]), -30.0, "a claim below 0 is its own floor");
    f.assert_rebuilds_the_same(T0 + 2);
}

#[test]
fn its_own_context_cannot_be_locked_by_junk_contexts() {
    // Tokens fill the brain's 8 contexts with junk (each context from two of
    // them, reported twice): honest reports in its own context still count.
    let owner = token(1);
    let mut f = F::new(Config::default());
    f.contribute(&owner, &body(&owner, &[(1, 50.0)], json!([])), T0);
    let junk: Vec<Value> = (0..8).map(|i| json!({"id": id(1), "context": {"profile": "wild", "track": format!("junk{i}")}, "meanFitness": 1, "count": 1})).collect();
    for (i, who) in [token(900), token(901)].iter().enumerate() {
        for round in 0..2u64 {
            f.contribute(who, &body(who, &[], json!(junk)), T0 + 1 + 2 * i as u64 + round);
        }
    }
    for (i, who) in [token(2), token(3)].iter().enumerate() {
        let answer = f.contribute(who, &body(who, &[], rows(&[(1, 49.0)])), T0 + 10 + i as u64);
        assert_eq!(answer["feedbackAccepted"], 1, "{answer}");
    }
    assert_eq!(num(&f.entry(1)["fitness"]), 49.0, "corroborated all the same");
}

#[test]
fn a_track_of_its_own_protects_no_uncorroborated_brain() {
    // Each track's best brains are kept only when corroborated: brains alone
    // on tracks of their own make no room for themselves.
    let owner = token(1);
    let mut f = F::new(Config { max_brains: 8, ..Config::default() });
    f.contribute(&owner, &body(&owner, &[(1, 30.0), (2, 25.0), (3, 20.0)], json!([])), T0);
    for who in [token(2), token(3)] {
        f.contribute(&who, &body(&who, &[], rows(&[(1, 28.0), (2, 22.0), (3, 18.0)])), T0 + 1);
    }
    // 12 flood brains, 3 on each of 4 tracks of their own.
    for i in 0..4u64 {
        let who = token(500 + i);
        let brains: Vec<Value> = (0..3u64)
            .map(|j| json!({"vector": encode_f32(&brain(200 + 3 * i + j)), "fitness": 1e6, "track": 0,
                "meta": {"learning": {"context": context(), "styleScore": 0.5}}}))
            .collect();
        let mut r = stream(7_000 + i);
        let t: Vec<f32> = (0..wire::TRACK_DIM).map(|_| r()).collect();
        let n = t.iter().map(|x| x * x).sum::<f32>().sqrt();
        let t: Vec<f32> = t.iter().map(|x| x / n).collect();
        let b = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": who, "tracks": [encode_f32(&t)], "brains": brains})).unwrap();
        f.contribute(&who, &b, T0 + 10 + i);
    }
    assert_eq!(f.brain.len(), 8);
    assert!([1, 2, 3].iter().all(|s| f.brain.contains(&id(*s))), "the corroborated brains stay");
}

#[test]
fn forget_pages_through_every_record_a_contributor_is_in() {
    // 160 brains, each reported by A in 8 contexts: 1 280 records, more than
    // a few (256, read by key) and more than one page (500) of them.
    let (owner, a, c) = (token(1), token(2), token(3));
    let mut f = F::new(Config::default());
    for chunk in 0..10u64 {
        let brains: Vec<(u64, f64)> = (0..16).map(|i| (1_000 + chunk * 16 + i, 10.0)).collect();
        f.contribute(&owner, &body(&owner, &brains, json!([])), T0 + chunk);
    }
    let ctx = |i: u64| if i == 0 { context() } else { json!({"profile": "wild", "track": format!("p{i}")}) };
    for chunk in 0..(160 * 8 / 50 + 1) {
        let rows: Vec<Value> = (chunk * 50..((chunk + 1) * 50).min(160 * 8))
            .map(|n| json!({"id": id(1_000 + n / 8), "context": ctx(n % 8), "meanFitness": 9, "count": 2}))
            .collect();
        if rows.is_empty() {
            break;
        }
        let answer = f.contribute(&a, &body(&a, &[], json!(rows)), T0 + 100 + chunk);
        assert!(answer["feedbackRejected"].as_array().unwrap().is_empty(), "{answer}");
    }
    // C shares one of the records, which stays.
    f.contribute(&c, &body(&c, &[], rows(&[(1_000, 9.5)])), T0 + 500);
    assert_eq!(f.store.feedback.len(), 1_280);
    assert_eq!(f.forget(&a), json!({"protocol": 1, "brains": 0, "feedback": 1_280}));
    assert_eq!(f.store.feedback.len(), 1, "C's record stays, without A");
    assert!(f.store.feedback.values().all(|r| r.slots.iter().all(|s| s.id != contributor_id(&a))));
    f.assert_rebuilds_the_same(T0 + 501);
}

#[test]
fn what_a_forget_reads_is_bounded_by_the_records() {
    // A reports on 400 brains (400 records, more than a few); C on 3.
    let (owner, a, c) = (token(1), token(2), token(3));
    let mut f = F::new(Config::default());
    for chunk in 0..25u64 {
        let brains: Vec<(u64, f64)> = (0..16).map(|i| (2_000 + chunk * 16 + i, 10.0)).collect();
        f.contribute(&owner, &body(&owner, &brains, json!([])), T0 + chunk);
    }
    for chunk in 0..8u64 {
        let list: Vec<(u64, f64)> = (0..50).map(|i| (2_000 + chunk * 50 + i, 9.0)).collect();
        f.contribute(&a, &body(&a, &[], rows(&list)), T0 + 100 + chunk);
    }
    f.contribute(&c, &body(&c, &[], rows(&[(2_000, 9.0), (2_001, 9.0), (2_002, 9.0)])), T0 + 200);
    let total = f.store.feedback.len();
    assert_eq!(total, 400);
    // (records read, queries, records forgotten)
    let reads = |f: &mut F, who: &str| {
        f.store.records_read.set(0);
        f.store.queries.set(0);
        let answer = f.forget(who);
        (f.store.records_read.get(), f.store.queries.get(), answer["feedback"].as_u64().unwrap())
    };
    // A token that reported nothing, with a tag nobody has: nothing read.
    let fresh = (1_000u64..).map(token).find(|t| f.store.feedback.values().all(|r| r.slots.iter().all(|s| s.who != tag(&contributor_id(t))))).unwrap();
    assert_eq!(reads(&mut f, &fresh), (0, 0, 0));
    // A token made to share A's tag: one pass over the records (one query a
    // page), not a query a record, and nothing forgotten.
    let (read, queries, forgot) = reads(&mut f, &same_tag_as(&a));
    assert!(read <= total && queries == 1 && forgot == 0, "{read} records read of {total} in {queries} queries");
    // C: its 3 records, read by key.
    assert_eq!(reads(&mut f, &c), (3, 3, 3));
    // A: every record once.
    let (read, queries, forgot) = reads(&mut f, &a);
    assert!(read <= total && queries == 1 && forgot == 400, "{read} read in {queries} queries, {forgot} forgotten");
    f.assert_rebuilds_the_same(T0 + 300);
}
