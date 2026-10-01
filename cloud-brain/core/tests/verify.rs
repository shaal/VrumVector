//! Verified laps (X1 of docs/plan/cloud-brain.md): the service runs a brain
//! it holds on the page's track and keeps the result; in the brain's own
//! context that is its fitness (no claim, no quarantine); the leaderboard
//! lists the fastest verified first laps. Brains and tracks come from the
//! simulator's golden traces (tests/fixtures/cloud-brain-sim/traces.json):
//! the service's run must give what the browser's own run gave.

use serde_json::{json, Value};
use vectorvroom_brain_core::brain::{contributor_id, Brain, Config, Limited, MemStore, Refusal, Usage, QUOTA, VERIFIED_PER_BRAIN, VERIFY_PER_MINUTE, VERIFY_WORK_PER_FRAME};
use vectorvroom_brain_core::presets::presets;
use vectorvroom_brain_core::wire::{self, encode_f32, geometry_digest, geometry_key, js_number, parse_board, parse_contribute, parse_recall, parse_verify, Reason};

const T0: u64 = 1_790_000_000_000;
const OWNER: &str = "0123456789abcdef0123456789abcdef";
const ASKER: &str = "fedcba9876543210fedcba9876543210";

fn traces() -> Value {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/cloud-brain-sim/traces.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}
fn vector(c: &Value) -> Vec<f32> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(c["vector"].as_str().unwrap()).unwrap();
    bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}
/// The track as the page sends it.
fn geometry(t: &Value) -> Value {
    json!({"width": t["width"], "height": t["height"], "inner": t["inner"], "outer": t["outer"], "checkpoints": t["checkpoints"]})
}
fn context(key: &str, s: &Value) -> Value {
    json!({"profile": s["profile"], "track": key, "maxSpeed": s["maxSpeed"], "traction": s["traction"], "seconds": s["seconds"], "collisions": "off"})
}
fn verify_body(token: &str, v: &[f32], track: &Value, ctx: &Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": token, "vector": encode_f32(v), "track": geometry(track), "context": ctx})).unwrap()
}
fn contribute_body(v: &[f32], fitness: f64, ctx: &Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": OWNER,
        "brains": [{"vector": encode_f32(v), "fitness": fitness, "meta": {"learning": {"context": ctx, "styleScore": 0}}}]})).unwrap()
}

struct F {
    brain: Brain,
    store: MemStore,
}
impl F {
    fn new(config: Config) -> F {
        let mut store = MemStore::default();
        F { brain: Brain::open(config, &mut store, T0).unwrap(), store }
    }
    fn contribute(&mut self, body: &[u8]) {
        let c = parse_contribute(body).unwrap();
        self.brain.contribute(c, &contributor_id(OWNER), T0, &mut self.store).unwrap().unwrap();
    }
    fn verify(&mut self, token: &str, body: &[u8], now: u64) -> Result<Value, Refusal> {
        let v = parse_verify(body).unwrap();
        self.brain.verify(v, &contributor_id(token), now, &mut self.store).unwrap().map(|a| json!(a))
    }
    fn served(&self, id: &str, ctx: &Value) -> f64 {
        let track = { let mut v = vec![0f32; 512]; v[0] = 1.0; v };
        let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "track": encode_f32(&track), "context": ctx, "k": 64})).unwrap();
        let pool = json!(self.brain.recall(&parse_recall(&body).unwrap(), &self.store).unwrap());
        pool["pool"].as_array().unwrap().iter().find(|e| e["id"] == id).expect("in the pool")["fitness"].as_f64().unwrap()
    }
}

/// A case of the traces whose brain laps, in its own settings.
fn lapping(t: &Value) -> Vec<&Value> {
    t["cases"].as_array().unwrap().iter().filter(|c| c["outcome"]["laps"].as_u64().unwrap() > 0 && c["settings"]["seconds"] == 20).collect()
}

#[test]
fn the_track_key_is_the_pages() {
    let t = traces();
    for (name, track) in t["tracks"].as_object().unwrap() {
        let g = parse_verify(&verify_body(OWNER, &[0.0; 244], track, &context("x", &json!({"profile": "balanced", "maxSpeed": 15, "traction": 0.5, "seconds": 20})))).unwrap().geometry;
        assert_eq!(geometry_key(&g), track["key"].as_str().unwrap(), "{name}");
    }
    for pair in t["numbers"].as_array().unwrap() {
        assert_eq!(js_number(pair[0].as_f64().unwrap()), pair[1].as_str().unwrap(), "{pair}");
    }
}

#[test]
fn the_ten_presets_are_pinned_to_their_geometries_when_the_brain_opens() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/presets.json");
    let json: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let json = json.as_object().unwrap();
    assert_eq!((json.len(), presets().len()), (10, 10));
    let probe = json!({"profile": "balanced", "track": "", "maxSpeed": 15, "traction": 0.5, "seconds": 20});
    for (name, p) in json {
        let g = parse_verify(&verify_body(OWNER, &[0.0; 244], p, &probe)).unwrap().geometry;
        let (key, digest) = (geometry_key(&g), geometry_digest(&g));
        // The page's key and the digest of the text it hashes (Node's).
        assert_eq!((key.as_str(), digest.as_str()), (p["key"].as_str().unwrap(), p["digest"].as_str().unwrap()), "{name}");
        assert!(presets().iter().any(|q| q.name == *name && q.key == key && q.digest == digest), "{name}");
    }
    let f = F::new(Config::default());
    assert_eq!(f.store.pins.len(), 10);
    assert!(presets().iter().all(|p| f.store.pins.get(&p.key) == Some(&p.digest)));
}

#[test]
fn a_track_key_runs_only_the_geometry_it_was_first_run_with() {
    let t = traces();
    let c = lapping(&t)[0];
    let rect = &t["tracks"]["Rectangle"];
    let v = vector(c);
    let mut f = F::new(Config::default());
    let ctx = context(rect["key"].as_str().unwrap(), &c["settings"]);
    f.contribute(&contribute_body(&v, 1.0, &ctx));
    // A preset: its pin is its own geometry.
    f.verify(ASKER, &verify_body(ASKER, &v, rect, &ctx), T0 + 1).unwrap();
    // A track of a player's own (Rectangle without its last gate): pinned at
    // its first run, run again as often as asked.
    let mut own = rect.clone();
    own["checkpoints"].as_array_mut().unwrap().pop();
    let g = parse_verify(&verify_body(ASKER, &v, &own, &ctx)).unwrap().geometry;
    let key = geometry_key(&g);
    assert!(!f.store.pins.contains_key(&key));
    f.verify(ASKER, &verify_body(ASKER, &v, &own, &ctx), T0 + 2).unwrap();
    assert_eq!(f.store.pins.get(&key), Some(&geometry_digest(&g)));
    f.verify(ASKER, &verify_body(ASKER, &v, &own, &ctx), T0 + 3).unwrap();
    // Another geometry under a pinned key (as one made to share it would be;
    // here the pin is made to differ): refused, not run, not counted.
    let used = f.store.contributors[&contributor_id(ASKER)].used.requests;
    for k in [key.as_str(), rect["key"].as_str().unwrap()] {
        f.store.pins.insert(k.to_string(), "0".repeat(64));
    }
    let runs = f.store.verified.len();
    assert_eq!(f.verify(ASKER, &verify_body(ASKER, &v, &own, &ctx), T0 + 4), Err(Refusal::Reason(Reason::TrackGeometry)));
    assert_eq!(f.verify(ASKER, &verify_body(ASKER, &v, rect, &ctx), T0 + 5), Err(Refusal::Reason(Reason::TrackGeometry)));
    assert_eq!((f.store.verified.len(), f.store.contributors[&contributor_id(ASKER)].used.requests), (runs, used));
    // A rebuild leaves pins as they are (the presets' included).
    let pins = f.store.pins.clone();
    f.brain = Brain::open(Config::default(), &mut f.store, T0 + 6).unwrap();
    assert_eq!(f.store.pins, pins);
}

#[test]
fn the_service_runs_a_brain_as_the_browser_did_and_its_run_is_its_fitness() {
    let t = traces();
    let cases = lapping(&t);
    assert!(cases.len() >= 3, "{} lapping cases", cases.len());
    for c in cases {
        let track = &t["tracks"][c["track"].as_str().unwrap()];
        let key = track["key"].as_str().unwrap();
        let ctx = context(key, &c["settings"]);
        let v = vector(c);
        let id = wire::brain_id(&v);
        let mut f = F::new(Config::default());
        // A claim of 1e6: served as 0 until verified.
        f.contribute(&contribute_body(&v, 1e6, &ctx));
        assert_eq!(f.served(&id, &ctx), 0.0);
        // From the service's own start pose (the browser's was V8's).
        let answer = f.verify(ASKER, &verify_body(ASKER, &v, track, &ctx), T0 + 1).unwrap();
        let js = &c["outcome"];
        assert_eq!(answer["fitness"].as_f64(), js["fitness"].as_f64(), "{}", c["track"]);
        assert_eq!(answer["laps"], js["laps"]);
        assert_eq!(answer["lapFrames"], js["lapFrames"]);
        assert_eq!(answer["crashedAt"], js["crashedAt"]);
        assert_eq!(answer["frames"], js["frames"]);
        assert_eq!((answer["track"].as_str(), answer["matched"].as_bool()), (Some(key), Some(true)));
        // Its own context: its fitness is the service's run, not its claim.
        assert_eq!(f.served(&id, &ctx), js["fitness"].as_f64().unwrap());
        // After a rebuild too.
        let reopened = Brain::open(Config::default(), &mut f.store, T0 + 2).unwrap();
        f.brain = reopened;
        assert_eq!(f.served(&id, &ctx), js["fitness"].as_f64().unwrap());
    }
}

#[test]
fn a_run_in_another_context_or_on_another_key_does_not_decide_its_standing() {
    let t = traces();
    let c = lapping(&t)[0];
    let track = &t["tracks"][c["track"].as_str().unwrap()];
    let key = track["key"].as_str().unwrap();
    let own = context(key, &c["settings"]);
    let v = vector(c);
    let id = wire::brain_id(&v);
    let mut f = F::new(Config::default());
    f.contribute(&contribute_body(&v, 50.0, &own));
    // Other physics: stored, not its standing.
    let other = json!({"profile": "balanced", "track": key, "maxSpeed": 12, "traction": 0.5, "seconds": 20});
    f.verify(ASKER, &verify_body(ASKER, &v, track, &other), T0 + 1).unwrap();
    assert_eq!(f.served(&id, &own), 0.0);
    // A context that names another track key: matched false, not its standing.
    let wrong = json!({"profile": c["settings"]["profile"], "track": "1-2-3", "maxSpeed": c["settings"]["maxSpeed"],
        "traction": c["settings"]["traction"], "seconds": 20});
    let answer = f.verify(ASKER, &verify_body(ASKER, &v, track, &wrong), T0 + 2).unwrap();
    assert_eq!(answer["matched"], false);
    // The run is under the geometry's own key: that is the brain's own context.
    assert_eq!(answer["track"], key);
    assert_eq!(f.served(&id, &own), c["outcome"]["fitness"].as_f64().unwrap());
    // A rebuild takes only the own context's run as its standing.
    let mut store = MemStore::default();
    let mut g = F { brain: Brain::open(Config::default(), &mut store, T0).unwrap(), store };
    g.contribute(&contribute_body(&v, 50.0, &own));
    g.verify(ASKER, &verify_body(ASKER, &v, track, &other), T0 + 1).unwrap();
    g.brain = Brain::open(Config::default(), &mut g.store, T0 + 2).unwrap();
    assert_eq!(g.served(&id, &own), 0.0);
}

#[test]
fn the_leaderboard_lists_the_fastest_first_laps_of_brains_held() {
    let t = traces();
    let mut f = F::new(Config::default());
    let mut expected: Vec<(u64, String)> = Vec::new();
    let mut key = String::new();
    for c in t["cases"].as_array().unwrap().iter().filter(|c| c["track"] == "Rectangle") {
        let track = &t["tracks"]["Rectangle"];
        key = track["key"].as_str().unwrap().to_string();
        // Every Rectangle brain, run at 15 and 0.5 for 40 s.
        let ctx = json!({"profile": "balanced", "track": key, "maxSpeed": 15, "traction": 0.5, "seconds": 40});
        let v = vector(c);
        let id = wire::brain_id(&v);
        if f.brain.contains(&id) {
            continue;
        }
        f.contribute(&contribute_body(&v, 1.0, &ctx));
        let a = f.verify(ASKER, &verify_body(ASKER, &v, track, &ctx), T0 + 1).unwrap();
        if let Some(first) = a["lapFrames"][0].as_u64() {
            expected.push((first, id));
        }
    }
    assert!(!expected.is_empty(), "a Rectangle brain laps");
    expected.sort();
    let board = parse_board(&format!("track={key}&maxSpeed=15&traction=0.5")).unwrap();
    let answer = json!(f.brain.leaderboard(&board, &f.store).unwrap());
    let got: Vec<(u64, String)> = answer["entries"].as_array().unwrap().iter().map(|e| (e["lapFrames"].as_u64().unwrap(), e["id"].as_str().unwrap().to_string())).collect();
    assert_eq!(got, expected);
    assert_eq!((answer["maxSpeed"].as_f64(), answer["traction"].as_f64()), (Some(15.0), Some(0.5)));
    // Other physics: another board.
    assert!(json!(f.brain.leaderboard(&parse_board(&format!("track={key}&maxSpeed=14")).unwrap(), &f.store).unwrap())["entries"].as_array().unwrap().is_empty());
    // An evicted brain leaves the board with its runs.
    let (_, first) = &expected[0];
    f.store.fail_after = None;
    let mut store = f.store.clone();
    vectorvroom_brain_core::brain::Store::delete_brain(&mut store, first).unwrap();
    let reopened = Brain::open(Config::default(), &mut store, T0 + 3).unwrap();
    let answer = json!(reopened.leaderboard(&board, &store).unwrap());
    assert!(answer["entries"].as_array().unwrap().iter().all(|e| e["id"] != first.as_str()));
    assert!(store.verified.iter().all(|r| r.brain != *first));
}

#[test]
fn the_leaderboard_orders_by_first_lap_then_fitness_then_age_and_lists_a_brain_once() {
    use vectorvroom_brain_core::brain::{Store, VerifiedRow, BOARD_SIZE};
    let t = traces();
    let mut f = F::new(Config::default());
    let key = t["tracks"]["Rectangle"]["key"].as_str().unwrap().to_string();
    let ctx = json!({"profile": "balanced", "track": key, "maxSpeed": 15, "traction": 0.5, "seconds": 20});
    // Every brain of the traces (more than a board holds), held.
    let mut ids: Vec<String> = Vec::new();
    for c in t["cases"].as_array().unwrap() {
        let v = vector(c);
        let id = wire::brain_id(&v);
        if !ids.contains(&id) {
            f.contribute(&contribute_body(&v, 1.0, &ctx));
            ids.push(id);
        }
    }
    assert!(ids.len() > BOARD_SIZE, "{} brains", ids.len());
    let run = |brain: &str, profile: &str, lap: Option<u64>, fitness: f64, created: u64| VerifiedRow {
        brain: brain.into(), track: key.clone(), profile: profile.into(), max_speed: 15.0, traction: 0.5, seconds: 20.0, fitness,
        laps: u64::from(lap.is_some()), lap_frames: lap, frames: 1200, contributor: String::new(), created,
    };
    let rows = [
        run(&ids[0], "balanced", Some(900), 6.0, 1),
        run(&ids[1], "balanced", Some(800), 5.0, 2),
        run(&ids[2], "balanced", Some(800), 7.0, 4),
        run(&ids[3], "balanced", Some(800), 7.0, 3),
        // A brain with two runs: listed once, at its best.
        run(&ids[0], "wild", Some(700), 4.0, 5),
        // No lap: not listed.
        run(&ids[4], "balanced", None, 3.0, 6),
    ];
    for r in &rows {
        f.store.put_verified(r).unwrap();
    }
    let board = parse_board(&format!("track={key}")).unwrap();
    let order = |f: &F| -> Vec<(String, u64, String)> {
        json!(f.brain.leaderboard(&board, &f.store).unwrap())["entries"].as_array().unwrap().iter()
            .map(|e| (e["id"].as_str().unwrap().to_string(), e["lapFrames"].as_u64().unwrap(), e["profile"].as_str().unwrap().to_string())).collect()
    };
    let expect = |i: usize, lap: u64, p: &str| (ids[i].clone(), lap, p.to_string());
    assert_eq!(order(&f), vec![expect(0, 700, "wild"), expect(3, 800, "balanced"), expect(2, 800, "balanced"), expect(1, 800, "balanced")]);
    // At most 20 brains, however many runs.
    for (i, id) in ids.iter().enumerate() {
        for (j, p) in ["calm", "careful", "reckless"].iter().enumerate() {
            f.store.put_verified(&run(id, p, Some(1_000 + i as u64), 1.0, 10 + j as u64)).unwrap();
        }
    }
    let all = order(&f);
    assert_eq!(all.len(), BOARD_SIZE);
    assert!(all.windows(2).all(|w| w[0].0 != w[1].0) && all.iter().map(|e| &e.0).collect::<std::collections::HashSet<_>>().len() == all.len());
}

#[test]
fn a_run_on_a_track_anyone_can_make_up_counts_only_in_its_own_context() {
    // Rectangle's walls with only its first gate: a car parked on it laps
    // every frame (the game counts so too). Its contributor makes it their
    // brain's own context and verifies it.
    let t = traces();
    let rect = &t["tracks"]["Rectangle"];
    let mut fake = rect.clone();
    fake["checkpoints"] = json!([rect["checkpoints"][0]]);
    let probe = json!({"profile": "balanced", "track": "", "maxSpeed": 15, "traction": 0.5, "seconds": 20});
    let fake_key = geometry_key(&parse_verify(&verify_body(OWNER, &[0.0; 244], &fake, &probe)).unwrap().geometry);
    let mut parked = vec![0.0f32; 244];
    parked[176..180].fill(1.0);
    let id = wire::brain_id(&parked);
    let own = json!({"profile": "balanced", "track": fake_key, "maxSpeed": 15, "traction": 0.5, "seconds": 20});
    let real = json!({"profile": "balanced", "track": rect["key"], "maxSpeed": 15, "traction": 0.5, "seconds": 20});
    let mut f = F::new(Config::default());
    f.contribute(&contribute_body(&parked, 1e6, &own));
    let answer = f.verify(OWNER, &verify_body(OWNER, &parked, &fake, &own), T0 + 1).unwrap();
    assert!(answer["fitness"].as_f64().unwrap() > 1_000.0, "{answer}");
    // Served so in its own context (the made-up track) only.
    assert_eq!(f.served(&id, &own), answer["fitness"].as_f64().unwrap());
    assert_eq!(f.served(&id, &real), 0.0, "on the real Rectangle: its claim, quarantined");
    let mut wild = real.clone();
    wild["profile"] = json!("wild");
    assert_eq!(f.served(&id, &wild), 0.0);
    // After a rebuild too.
    f.brain = Brain::open(Config::default(), &mut f.store, T0 + 2).unwrap();
    assert_eq!(f.served(&id, &real), 0.0);
    assert_eq!(f.served(&id, &own), answer["fitness"].as_f64().unwrap());
    // It protects nothing: with room for one brain, an honest brain whose
    // claim two others corroborated stays, and the made-up one goes.
    let mut f = F::new(Config { max_brains: 2, keep_per_track: 1, ..Config::default() });
    f.contribute(&contribute_body(&parked, 1e6, &own));
    f.verify(OWNER, &verify_body(OWNER, &parked, &fake, &own), T0 + 1).unwrap();
    let c = lapping(&t)[0];
    let honest = vector(c);
    let honest_ctx = context(rect["key"].as_str().unwrap(), &c["settings"]);
    f.contribute(&contribute_body(&honest, 6.0, &honest_ctx));
    for who in [ASKER, "00112233445566778899aabbccddeeff"] {
        let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": who,
            "feedback": [{"id": wire::brain_id(&honest), "context": honest_ctx, "meanFitness": 6, "count": 3}]})).unwrap();
        f.brain.contribute(parse_contribute(&body).unwrap(), &contributor_id(who), T0 + 2, &mut f.store).unwrap().unwrap();
    }
    let third = vector(&t["cases"][0]);
    f.contribute(&contribute_body(&third, 1.0, &honest_ctx));
    assert!(f.brain.contains(&wire::brain_id(&honest)), "the corroborated brain stays");
    assert!(!f.brain.contains(&id), "the brain verified on a made-up track goes first");
}

#[test]
fn feedback_on_a_verified_brain_is_measured_against_its_run() {
    // A claim made low on purpose (every offspring beats it: weight 1), then
    // a verification: in its own context the weight is how the offspring
    // compare with the service's run.
    let t = traces();
    let c = lapping(&t)[0];
    let track = &t["tracks"][c["track"].as_str().unwrap()];
    let ctx = context(track["key"].as_str().unwrap(), &c["settings"]);
    let v = vector(c);
    let id = wire::brain_id(&v);
    let fitness = c["outcome"]["fitness"].as_f64().unwrap();
    let mut f = F::new(Config::default());
    f.contribute(&contribute_body(&v, -1e6, &ctx));
    let report = |f: &mut F, who: &str, mean: f64, now: u64| {
        let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": who,
            "feedback": [{"id": id, "context": ctx, "meanFitness": mean, "count": 3}]})).unwrap();
        f.brain.contribute(parse_contribute(&body).unwrap(), &contributor_id(who), now, &mut f.store).unwrap().unwrap();
    };
    report(&mut f, ASKER, fitness, T0 + 1);
    report(&mut f, "00112233445566778899aabbccddeeff", fitness, T0 + 2);
    let weight = |f: &F| -> f64 {
        let track = { let mut v = vec![0f32; 512]; v[0] = 1.0; v };
        let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "track": encode_f32(&track), "context": ctx, "k": 64})).unwrap();
        let pool = json!(f.brain.recall(&parse_recall(&body).unwrap(), &f.store).unwrap());
        pool["pool"].as_array().unwrap().iter().find(|e| e["id"] == id.as_str()).unwrap()["feedback"]["weight"].as_f64().unwrap()
    };
    assert_eq!(weight(&f), 1.0, "against the claim of -1e6");
    f.verify(ASKER, &verify_body(ASKER, &v, track, &ctx), T0 + 3).unwrap();
    assert_eq!(f.served(&id, &ctx), fitness);
    assert!(weight(&f).abs() < 0.01, "offspring as good as its run: {}", weight(&f));
    // After a rebuild, and for rows after it (one of the two reports
    // offspring twice as good: the mean of 0 and theirs).
    f.brain = Brain::open(Config::default(), &mut f.store, T0 + 4).unwrap();
    assert!(weight(&f).abs() < 0.01);
    report(&mut f, ASKER, fitness * 2.0, T0 + 5);
    assert!(weight(&f) > 0.0 && weight(&f) < 1.0, "{}", weight(&f));
}

#[test]
fn verification_is_refused_for_a_brain_not_held_and_counted_against_the_quota() {
    let t = traces();
    let c = lapping(&t)[0];
    let track = &t["tracks"][c["track"].as_str().unwrap()];
    let ctx = context(track["key"].as_str().unwrap(), &c["settings"]);
    let v = vector(c);
    let mut f = F::new(Config { quota: Usage { requests: 3, brains: 2, ..QUOTA }, ..Config::default() });
    assert_eq!(f.verify(ASKER, &verify_body(ASKER, &v, track, &ctx), T0), Err(Refusal::Reason(Reason::BrainUnknown)));
    assert!(f.store.contributors.is_empty(), "a refused verification is not counted");
    f.contribute(&contribute_body(&v, 1.0, &ctx));
    f.verify(ASKER, &verify_body(ASKER, &v, track, &ctx), T0 + 1).unwrap();
    f.verify(ASKER, &verify_body(ASKER, &v, track, &ctx), T0 + 2).unwrap();
    assert!(matches!(f.verify(ASKER, &verify_body(ASKER, &v, track, &ctx), T0 + 3), Err(Refusal::Limited(_))), "a verification counts a brain");
    assert_eq!(f.store.contributors[&contributor_id(ASKER)].used, Usage { requests: 2, brains: 2, feedback: 0 });
}

#[test]
fn at_most_30_verifications_a_minute_run_for_everyone_together() {
    let t = traces();
    let c = lapping(&t)[0];
    let track = &t["tracks"][c["track"].as_str().unwrap()];
    let ctx = context(track["key"].as_str().unwrap(), &c["settings"]);
    let v = vector(c);
    let mut f = F::new(Config::default());
    f.contribute(&contribute_body(&v, 1.0, &ctx));
    // T0 is 20 s into its minute.
    let minute = T0 - T0 % 60_000;
    let token = |i: u32| format!("{:032x}", 0xbeef + i);
    for i in 0..VERIFY_PER_MINUTE {
        f.verify(&token(i), &verify_body(&token(i), &v, track, &ctx), T0 + u64::from(i)).unwrap();
    }
    let late = token(99);
    assert_eq!(f.verify(&late, &verify_body(&late, &v, track, &ctx), minute + 59_001), Err(Refusal::Limited(Limited { retry_after: 1 })));
    assert!(!f.store.contributors.contains_key(&contributor_id(&late)), "not counted against their quota");
    // Nor is a track it was asked about pinned.
    let mut other = track.clone();
    other["checkpoints"].as_array_mut().unwrap().pop();
    assert!(matches!(f.verify(&late, &verify_body(&late, &v, &other, &ctx), minute + 59_002), Err(Refusal::Limited(_))));
    let probe = parse_verify(&verify_body(&late, &v, &other, &ctx)).unwrap().geometry;
    assert!(!f.store.pins.contains_key(&geometry_key(&probe)));
    f.verify(&late, &verify_body(&late, &v, track, &ctx), minute + 60_000).unwrap();
}

#[test]
fn a_brain_keeps_its_latest_runs_and_always_the_one_that_decides_its_standing() {
    let t = traces();
    let c = lapping(&t)[0];
    let track = &t["tracks"][c["track"].as_str().unwrap()];
    let key = track["key"].as_str().unwrap();
    let own = context(key, &c["settings"]);
    let v = vector(c);
    let id = wire::brain_id(&v);
    let mut f = F::new(Config::default());
    f.contribute(&contribute_body(&v, 1.0, &own));
    f.verify(ASKER, &verify_body(ASKER, &v, track, &own), T0 + 1).unwrap();
    for (i, max_speed) in [5, 6, 7, 8, 9, 10].iter().enumerate() {
        let other = json!({"profile": "balanced", "track": key, "maxSpeed": max_speed, "traction": 0.5, "seconds": 20});
        f.verify(ASKER, &verify_body(ASKER, &v, track, &other), T0 + 10 + i as u64).unwrap();
    }
    let runs: Vec<f64> = f.store.verified.iter().filter(|r| r.brain == id).map(|r| r.max_speed).collect();
    assert_eq!(runs.len(), VERIFIED_PER_BRAIN);
    assert!(runs.contains(&c["settings"]["maxSpeed"].as_f64().unwrap()), "its own run stays: {runs:?}");
    assert!(runs.contains(&10.0) && runs.contains(&9.0) && runs.contains(&8.0), "then the latest: {runs:?}");
    assert_eq!(f.served(&id, &own), c["outcome"]["fitness"].as_f64().unwrap());
}

#[test]
fn forget_deletes_a_contributors_verified_brains_and_takes_their_id_off_their_runs() {
    let t = traces();
    let c = lapping(&t)[0];
    let track = &t["tracks"][c["track"].as_str().unwrap()];
    let ctx = context(track["key"].as_str().unwrap(), &c["settings"]);
    let v = vector(c);
    let id = wire::brain_id(&v);
    let mut f = F::new(Config::default());
    f.contribute(&contribute_body(&v, 1.0, &ctx));
    f.verify(ASKER, &verify_body(ASKER, &v, track, &ctx), T0 + 1).unwrap();
    // The asker forgets: the run stays (the service's own), without their id.
    f.brain.forget(&contributor_id(ASKER), &mut f.store).unwrap();
    assert_eq!(f.store.verified.len(), 1);
    assert_eq!(f.store.verified[0].contributor, "");
    assert_eq!(f.served(&id, &ctx), c["outcome"]["fitness"].as_f64().unwrap());
    // The brain's contributor forgets: brain and run go.
    f.brain.forget(&contributor_id(OWNER), &mut f.store).unwrap();
    assert!(f.store.verified.is_empty() && !f.brain.contains(&id));
}

#[test]
fn a_run_depends_on_the_brain_track_and_context_only() {
    let t = traces();
    let c = lapping(&t)[0];
    let track = &t["tracks"][c["track"].as_str().unwrap()];
    let ctx = context(track["key"].as_str().unwrap(), &c["settings"]);
    let v = vector(c);
    let mut f = F::new(Config::default());
    f.contribute(&contribute_body(&v, 1.0, &ctx));
    let honest = f.verify(OWNER, &verify_body(OWNER, &v, track, &ctx), T0 + 1).unwrap();
    let id = wire::brain_id(&v);
    let served = f.served(&id, &ctx);
    // Another token runs it again, with a start pose in the body (not read:
    // the service finds the pose from the gates): the same run, the same
    // standing. Nothing in a request but the brain, the track and the
    // context changes what it does (the canvas is the game's, or refused).
    for start in [json!({"x": c["start"]["x"].as_f64().unwrap() + 100.0, "y": c["start"]["y"], "heading": c["start"]["angle"]}),
        json!({"x": c["start"]["x"], "y": c["start"]["y"], "heading": c["start"]["angle"].as_f64().unwrap() + 0.3}), json!(null)] {
        let mut body: Value = serde_json::from_slice(&verify_body(ASKER, &v, track, &ctx)).unwrap();
        body["start"] = start;
        let answer = f.verify(ASKER, &serde_json::to_vec(&body).unwrap(), T0 + 2).unwrap();
        assert_eq!(answer, honest);
        assert_eq!(f.served(&id, &ctx), served);
    }
    for (side, size) in [("width", 3201.0), ("height", 1.0)] {
        let mut body: Value = serde_json::from_slice(&verify_body(ASKER, &v, track, &ctx)).unwrap();
        body["track"][side] = json!(size);
        assert_eq!(parse_verify(&serde_json::to_vec(&body).unwrap()).err(), Some(Reason::TrackGeometry), "{side} {size}");
    }
}

/// The costliest tracks a verification accepts (cloud-brain/sim/tests/cost.rs).
fn costly_tracks() -> [Value; 2] {
    let zigzag = |y: f64| (0..256).map(|i| json!([if i % 2 == 0 { 0.0 } else { 3200.0 }, y + i as f64 * 0.01])).collect::<Vec<_>>();
    let mut gates = vec![json!([[1600, 400], [1600, 600]]), json!([[1700, 400], [1700, 600]])];
    gates.extend((0..62).map(|i| json!([[1300 + i * 10, 420], [1300 + i * 10, 440]])));
    let zigzags = json!({"width": 3200, "height": 1800, "inner": zigzag(300.0), "outer": zigzag(700.0), "checkpoints": gates});
    let far = 99_900.0;
    let diagonal = |i: usize, flip: f64| {
        let t = i as f64 / 255.0;
        if i % 2 == 0 { json!([-far, flip * (-far + t)]) } else { json!([far, flip * (far + t)]) }
    };
    let mut gates = vec![json!([[2600, 300], [2600, 301]]), json!([[2601, 300], [2601, 301]])];
    gates.extend((0..62).map(|i| json!([[-far, -far + i as f64], [far, far + i as f64]])));
    let diagonals = json!({"width": 3200, "height": 1800, "inner": (0..256).map(|i| diagonal(i, 1.0)).collect::<Vec<_>>(),
        "outer": (0..256).map(|i| diagonal(i, -1.0)).collect::<Vec<_>>(), "checkpoints": gates});
    [zigzags, diagonals]
}

#[test]
fn a_track_made_to_be_costly_is_stopped_and_refused() {
    let mut parked = vec![0.0f32; 244];
    parked[176..180].fill(1.0);
    let ctx = json!({"profile": "balanced", "track": "", "maxSpeed": 15, "traction": 0.5, "seconds": 120});
    let mut f = F::new(Config::default());
    f.contribute(&contribute_body(&parked, 1.0, &ctx));
    let key = |track: &Value| geometry_key(&parse_verify(&verify_body(ASKER, &parked, track, &ctx)).unwrap().geometry);
    for track in costly_tracks() {
        // Accepted by the parser, stopped past 600 segments a frame on average.
        assert!(parse_verify(&verify_body(ASKER, &parked, &track, &ctx)).is_ok());
        assert_eq!(f.verify(ASKER, &verify_body(ASKER, &parked, &track, &ctx), T0 + 1), Err(Refusal::Reason(Reason::TrackGeometry)));
        assert!(f.store.verified.is_empty(), "nothing kept");
        assert!(!f.store.pins.contains_key(&key(&track)), "its key not pinned");
    }
    // Asked and run (up to the budget): counted.
    assert_eq!(f.store.contributors[&contributor_id(ASKER)].used.requests, 2);
    // Near the budget: walls zigzagging in the sensors' reach, about 6
    // segments a frame a point: 90 points a loop take ~543 a frame (run),
    // 110 take ~663 (stopped).
    assert_eq!(VERIFY_WORK_PER_FRAME, 600);
    let zigzags = |n: usize| {
        let zigzag = |y: f64| (0..n).map(|i| json!([if i % 2 == 0 { 0.0 } else { 3200.0 }, y + i as f64 * 0.01])).collect::<Vec<_>>();
        json!({"width": 3200, "height": 1800, "inner": zigzag(300.0), "outer": zigzag(700.0), "checkpoints": [[[1600, 400], [1600, 600]], [[1700, 400], [1700, 600]]]})
    };
    let short = json!({"profile": "balanced", "track": "", "maxSpeed": 15, "traction": 0.5, "seconds": 20});
    let answer = f.verify(ASKER, &verify_body(ASKER, &parked, &zigzags(90), &short), T0 + 2).unwrap();
    assert_eq!((answer["frames"].as_u64(), answer["crashedAt"].as_u64()), (Some(1200), None));
    assert!(f.store.pins.contains_key(&key(&zigzags(90))));
    assert_eq!(f.verify(ASKER, &verify_body(ASKER, &parked, &zigzags(110), &short), T0 + 3), Err(Refusal::Reason(Reason::TrackGeometry)));
    assert!(!f.store.pins.contains_key(&key(&zigzags(110))));
}

#[test]
fn runs_that_differ_only_in_length_are_two_runs() {
    let t = traces();
    let c = lapping(&t)[0];
    let track = &t["tracks"][c["track"].as_str().unwrap()];
    let own = context(track["key"].as_str().unwrap(), &c["settings"]);
    let v = vector(c);
    let id = wire::brain_id(&v);
    let mut f = F::new(Config::default());
    f.contribute(&contribute_body(&v, 1.0, &own));
    f.verify(ASKER, &verify_body(ASKER, &v, track, &own), T0 + 1).unwrap();
    let served = f.served(&id, &own);
    let mut longer = own.clone();
    longer["seconds"] = json!(own["seconds"].as_f64().unwrap() + 20.0);
    f.verify(ASKER, &verify_body(ASKER, &v, track, &longer), T0 + 2).unwrap();
    assert_eq!(f.store.verified.iter().filter(|r| r.brain == id).count(), 2);
    f.brain = Brain::open(Config::default(), &mut f.store, T0 + 3).unwrap();
    assert_eq!(f.served(&id, &own), served, "its own run stays its standing");
}

#[test]
fn hostile_verifications_and_queries_are_refused_with_reasons() {
    let t = traces();
    let track = &t["tracks"]["Rectangle"];
    let ctx = context("k", &json!({"profile": "balanced", "maxSpeed": 15, "traction": 0.5, "seconds": 20}));
    let good: Value = serde_json::from_slice(&verify_body(OWNER, &[0.5; 244], track, &ctx)).unwrap();
    let with = |path: &[&str], value: Value| {
        let mut b = good.clone();
        let mut at = &mut b;
        for p in &path[..path.len() - 1] {
            at = &mut at[*p];
        }
        at[path[path.len() - 1]] = value;
        parse_verify(&serde_json::to_vec(&b).unwrap()).err()
    };
    assert!(parse_verify(&serde_json::to_vec(&good).unwrap()).is_ok());
    assert_eq!(with(&["token"], json!("x")), Some(Reason::Token));
    assert_eq!(with(&["vector"], json!("AAAA")), Some(Reason::BrainEncoding));
    assert_eq!(with(&["track", "width"], json!(0)), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track", "width"], json!(10_001)), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track", "width"], json!(3199.5)), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track", "height"], json!(1801)), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track", "height"], json!("1800")), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track", "inner"], json!([[0, 0], [1, 1]])), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track", "inner"], json!(vec![[0, 0]; 257])), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track", "outer"], json!([[0, 0], [1, 1], [1e6, 0]])), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track", "checkpoints"], json!([])), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track", "checkpoints"], json!([[[0, 0]]])), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track", "checkpoints"], json!(vec![[[0, 0], [1, 1]]; 65])), Some(Reason::TrackGeometry));
    assert_eq!(with(&["track"], json!("rect")), Some(Reason::TrackGeometry));
    assert_eq!(with(&["context"], json!(1)), Some(Reason::Context));
    assert_eq!(with(&["context", "collisions"], json!("solid/k8")), Some(Reason::VerifyContext));
    assert_eq!(with(&["context", "seconds"], json!(121)), Some(Reason::VerifyContext));
    assert_eq!(with(&["start"], json!({"x": 1, "y": 2})), None, "a start pose is not read");
    assert_eq!(with(&["brainSchema"], json!(5)), Some(Reason::BrainSchema));
    for q in ["", "maxSpeed=15", "track=ABC-1-2", "track=1-2-3&maxSpeed=fast", "track=1-2-3&traction=NaN", "track=123456789-1-1"] {
        assert_eq!(parse_board(q).err(), Some(Reason::LeaderboardQuery), "{q}");
    }
    let b = parse_board("track=e9755c3b-fb81e227-361&traction=2&x=1").unwrap();
    assert_eq!((b.max_speed, b.traction), (15.0, 1.0), "cleaned as a context");
}
