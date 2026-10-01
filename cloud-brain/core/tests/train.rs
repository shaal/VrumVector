//! Cloud training (X2 of docs/plan/cloud-brain.md): while nobody plays, the
//! service drives children of the best brains on the busiest preset and
//! keeps one that drove better than every seed, as a brain of its own
//! (source `cloud`), its run its verified run. Brains come from the
//! simulator's golden traces (tests/fixtures/cloud-brain-sim/traces.json):
//! the Rectangle brain the game's learning loop evolved there laps.

use serde_json::{json, Value};
use vectorvroom_brain_core::brain::{contributor_id, Brain, BrainRow, Config, MemStore, Store, Training, CLOUD_BRAINS, CLOUD_CONTRIBUTOR, TRAIN_SEEDS};
use vectorvroom_brain_core::presets::presets;
use vectorvroom_brain_core::wire::{self, encode_f32, parse_contribute, parse_recall, parse_verify};

const T0: u64 = 1_790_000_000_000;
const MINUTE: u64 = 60_000;
const OWNER: &str = "0123456789abcdef0123456789abcdef";
const OTHER: &str = "fedcba9876543210fedcba9876543210";

fn traces() -> Value {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/cloud-brain-sim/traces.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}
fn vector(c: &Value) -> Vec<f32> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(c["vector"].as_str().unwrap()).unwrap();
    bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}
fn rectangle_key() -> String {
    presets().iter().find(|p| p.name == "Rectangle").unwrap().key.clone()
}
/// The Rectangle, balanced, 15 and 0.5, 20 s: the evolved brain's context.
fn context(track: &str) -> Value {
    json!({"profile": "balanced", "track": track, "maxSpeed": 15, "traction": 0.5, "seconds": 20, "collisions": "off"})
}
fn contribute(brain: &mut Brain, store: &mut MemStore, token: &str, vectors: &[Vec<f32>], ctx: &Value, now: u64) {
    let brains: Vec<Value> = vectors.iter().map(|v| json!({"vector": encode_f32(v), "fitness": 1, "meta": {"generation": 3, "learning": {"context": ctx, "styleScore": 0}}})).collect();
    let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": token, "brains": brains})).unwrap();
    brain.contribute(parse_contribute(&body).unwrap(), &contributor_id(token), now, store).unwrap().unwrap();
}
fn pool(brain: &Brain, store: &MemStore, ctx: &Value) -> Vec<Value> {
    let track = {
        let mut v = vec![0f32; 512];
        v[0] = 1.0;
        v
    };
    let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "track": encode_f32(&track), "context": ctx, "k": 64})).unwrap();
    json!(brain.recall(&parse_recall(&body).unwrap(), store).unwrap())["pool"].as_array().unwrap().clone()
}
/// The evolved Rectangle brain that laps, and the random ones traced there
/// (two distinct): three brains.
fn seeds() -> Vec<Vec<f32>> {
    let t = traces();
    let lapping = t["cases"].as_array().unwrap().iter().find(|c| c["track"] == "Rectangle" && c["outcome"]["laps"].as_u64() > Some(0)).unwrap();
    let mut out = vec![vector(lapping)];
    out.extend(t["cases"].as_array().unwrap().iter().filter(|c| c["track"] == "Rectangle" && c["brain"].as_str().unwrap().starts_with("random")).map(vector));
    out.dedup();
    out
}
fn world() -> (Brain, MemStore) {
    let mut store = MemStore::default();
    let mut brain = Brain::open(Config::default(), &mut store, T0).unwrap();
    contribute(&mut brain, &mut store, OWNER, &seeds(), &context(&rectangle_key()), T0);
    (brain, store)
}
const TRAINING: Training = Training { frames: 60_000, idle_minutes: 10 };

#[test]
fn sessions_breed_better_brains_on_the_busiest_preset_and_keep_them_as_the_services() {
    let (mut brain, mut store) = world();
    let ctx = context(&rectangle_key());
    let mut now = T0 + 11 * MINUTE;
    let mut archived = Vec::new();
    let mut first = None;
    let mut best = f64::MIN;
    // Sessions seeded 1000 to 1011: of ten such sets of twelve sessions, nine
    // beat the seeds (to 7 to 11), one did not (docs/validation).
    for session in 1_000..1_012u64 {
        let report = brain.train(TRAINING, now, session, &mut store).unwrap().expect("a session");
        assert_eq!((report.track.as_str(), report.context.profile.as_str(), report.context.seconds), ("Rectangle", "balanced", 20.0));
        assert!(report.frames <= TRAINING.frames && report.runs as u64 * 1200 == report.frames, "{report:?}");
        assert!(report.seeds.len() <= TRAIN_SEEDS);
        first.get_or_insert(report.seed_fitness);
        if let Some(id) = &report.archived {
            assert!(report.best_fitness >= report.seed_fitness, "{report:?}");
            archived.push(id.clone());
        }
        best = best.max(report.best_fitness);
        now += 30 * MINUTE;
    }
    let first = first.unwrap();
    eprintln!("12 sessions: the seeds' best {first}, the best {best}, {} archived", archived.len());
    assert_eq!(first, 6.0, "the evolved brain's own run");
    assert!(!archived.is_empty() && best > first, "a session beat the seeds: {best} vs {first}");
    // The last brain archived: the service's, source cloud, its lineage, its
    // run verified, served in its context at that run.
    let id = archived.last().unwrap();
    let (row, held) = store.brains[id].clone();
    assert_eq!(row.contributor, CLOUD_CONTRIBUTOR);
    let meta: Value = serde_json::from_str(&row.meta).unwrap();
    assert_eq!(meta["source"], "cloud");
    assert_eq!(meta["learning"]["context"]["track"], rectangle_key());
    assert!(wire::is_brain_id(meta["parentIds"][0].as_str().unwrap()));
    assert!(meta["generation"].as_u64().unwrap() >= 4);
    let run = store.verified.iter().find(|r| r.brain == *id).expect("its run").clone();
    assert_eq!(run.fitness, row.fitness);
    let entry = pool(&brain, &store, &ctx).into_iter().find(|e| e["id"] == id.as_str()).expect("served");
    assert_eq!((entry["fitness"].as_f64(), entry["meta"]["source"].as_str()), (Some(row.fitness), Some("cloud")));
    // Elsewhere its fitness is a claim, quarantined as a player's (CB4): the
    // track and context it ran in were its seeds', the players' to choose.
    let mut other = ctx.clone();
    other["profile"] = json!("wild");
    assert_eq!(pool(&brain, &store, &other).into_iter().find(|e| e["id"] == id.as_str()).unwrap()["fitness"].as_f64(), Some(0.0));
    // Anyone verifying it gets the same run.
    let rect = &presets().iter().find(|p| p.name == "Rectangle").unwrap().geometry;
    let track = json!({"width": rect.width, "height": rect.height, "inner": rect.inner, "outer": rect.outer, "checkpoints": rect.checkpoints});
    let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": OTHER, "vector": encode_f32(&held), "track": track, "context": ctx})).unwrap();
    let answer = json!(brain.verify(parse_verify(&body).unwrap(), &contributor_id(OTHER), now, &mut store).unwrap().unwrap());
    assert_eq!(answer["fitness"].as_f64(), Some(row.fitness));
    // On the Rectangle's leaderboard, at its first lap.
    let board = json!(brain.leaderboard(&wire::parse_board(&format!("track={}", rectangle_key())).unwrap(), &store).unwrap());
    assert!(board["entries"].as_array().unwrap().iter().any(|e| e["id"] == id.as_str() && e["lapFrames"].as_u64() == run.lap_frames));
    // Its meta's fastest lap is car.js's for its run; its parent is the seed
    // it descends from (nearer its weights than any other brain held: later
    // sessions breed from earlier sessions' brains too).
    let lap = {
        use vectorvroom_sim as sim;
        let pt = |p: &[f64; 2]| sim::Point { x: p[0], y: p[1] };
        let gates: Vec<sim::Segment> = rect.checkpoints.iter().map(|c| [pt(&c[0]), pt(&c[1])]).collect();
        let t = sim::Track::new(rect.width, rect.height, &rect.inner.iter().map(pt).collect::<Vec<_>>(), &rect.outer.iter().map(pt).collect::<Vec<_>>(), &gates);
        let settings = sim::Settings { max_speed: 15.0, traction: 0.5, profile: sim::Profile::from_id("balanced") };
        sim::run(&t, t.start().unwrap(), sim::Brain::from_flat(&held).unwrap(), settings, 1_200, |_, _| {}).fastest_lap()
    };
    assert!(lap.is_some());
    assert_eq!(meta["fastestLap"].as_f64(), lap);
    let distance = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| f64::from(x - y).powi(2)).sum::<f64>();
    let parent = meta["parentIds"][0].as_str().unwrap();
    let nearest = store.brains.iter().filter(|(other, _)| *other != id).min_by(|a, b| distance(&a.1 .1, &held).total_cmp(&distance(&b.1 .1, &held))).unwrap().0;
    assert_eq!(parent, nearest);
    // The seeds' runs were kept: each seed driven is verified in its context.
    for seed in seeds() {
        assert!(store.verified.iter().any(|r| r.brain == wire::brain_id(&seed) && r.contributor == CLOUD_CONTRIBUTOR), "seed run kept");
    }
    // A rebuild keeps it as it was. Forgetting an unrelated token leaves it;
    // forgetting its seeds' contributor takes every brain bred from theirs.
    let served = entry["fitness"].clone();
    let mut reopened = Brain::open(Config::default(), &mut store, now).unwrap();
    assert_eq!(pool(&reopened, &store, &ctx).into_iter().find(|e| e["id"] == id.as_str()).unwrap()["fitness"], served);
    reopened.forget(&contributor_id(OTHER), &mut store).unwrap();
    assert!(store.brains.contains_key(id));
    let cloud = store.brains.values().filter(|(r, _)| r.contributor == CLOUD_CONTRIBUTOR).count();
    let answer = reopened.forget(&contributor_id(OWNER), &mut store).unwrap();
    assert_eq!(store.brains.values().filter(|(r, _)| r.contributor == CLOUD_CONTRIBUTOR).count(), 0, "none bred from theirs is left");
    assert_eq!(json!(answer)["brains"].as_u64(), Some((seeds().len() + cloud) as u64));
}

#[test]
fn nobody_trains_while_people_play_and_a_session_stays_within_its_frames() {
    let (mut brain, mut store) = world();
    // The contribution at T0: playing for 10 minutes.
    assert_eq!(brain.train(TRAINING, T0 + 9 * MINUTE, 1, &mut store).unwrap(), None);
    let report = brain.train(TRAINING, T0 + 10 * MINUTE, 1, &mut store).unwrap().unwrap();
    assert_eq!(report.frames, 60_000);
    // A budget under one run of the context (20 s): nothing driven.
    assert_eq!(brain.train(Training { frames: 1_199, idle_minutes: 0 }, T0 + 20 * MINUTE, 1, &mut store).unwrap(), None);
    // Enough for the seeds only: driven, no child, nothing archived.
    let seeds = report.seeds.len() as u64;
    let r = brain.train(Training { frames: seeds * 1_200, idle_minutes: 0 }, T0 + 21 * MINUTE, 1, &mut store).unwrap().unwrap();
    assert_eq!((r.runs as u64, r.archived), (seeds, None));
}

#[test]
fn a_session_is_the_same_for_a_seed() {
    let ((mut a, mut sa), (mut b, mut sb)) = (world(), world());
    let now = T0 + 11 * MINUTE;
    for seed in [1, 2, 3] {
        assert_eq!(a.train(TRAINING, now, seed, &mut sa).unwrap(), b.train(TRAINING, now, seed, &mut sb).unwrap());
    }
}

#[test]
fn only_presets_are_trained_on_and_sessions_take_turns_on_the_busiest_contexts() {
    let mut store = MemStore::default();
    let mut brain = Brain::open(Config::default(), &mut store, T0).unwrap();
    let seeds = seeds();
    // A player's own track (not a preset), and contexts the service cannot
    // run alone: nothing to train.
    contribute(&mut brain, &mut store, OWNER, &seeds, &context("1-2-3"), T0);
    let mut solid = context(&rectangle_key());
    solid["collisions"] = json!("solid/k8");
    contribute(&mut brain, &mut store, OTHER, &[seeds[0].iter().map(|w| w * 0.5).collect()], &solid, T0);
    assert_eq!(brain.train(Training { frames: 60_000, idle_minutes: 0 }, T0 + MINUTE, 1, &mut store).unwrap(), None);
    // A context over 120 s (the service runs at most that), the busiest:
    // never trained on.
    let mut long = context(&rectangle_key());
    long["seconds"] = json!(150);
    contribute(&mut brain, &mut store, "00112233445566778899aabbccddeeff", &[seeds[0].iter().map(|w| w * 0.95).collect()], &long, T0);
    contribute(&mut brain, &mut store, "ffeeddccbbaa99887766554433221100", &[seeds[0].iter().map(|w| w * 0.96).collect()], &long, T0);
    contribute(&mut brain, &mut store, "aaaabbbbccccddddeeeeffff00001111", &[seeds[0].iter().map(|w| w * 0.97).collect()], &long, T0);
    // Monaco with one brain, the Rectangle in wild with two.
    let monaco = presets().iter().find(|p| p.name == "Monaco").unwrap().key.clone();
    contribute(&mut brain, &mut store, OWNER, &[seeds[1].iter().map(|w| w * 0.9).collect()], &context(&monaco), T0);
    let mut wild = context(&rectangle_key());
    wild["profile"] = json!("wild");
    contribute(&mut brain, &mut store, OTHER, &[seeds[1].iter().map(|w| w * 0.8).collect(), seeds[2].iter().map(|w| w * 0.8).collect()], &wild, T0);
    // Sessions take turns on the busiest contexts, the busiest first.
    let r = brain.train(Training { frames: 6_000, idle_minutes: 0 }, T0 + MINUTE, 0, &mut store).unwrap().unwrap();
    assert_eq!((r.track.as_str(), r.context.profile.as_str(), r.seeds.len()), ("Rectangle", "wild", 2));
    let r = brain.train(Training { frames: 6_000, idle_minutes: 0 }, T0 + MINUTE, 1, &mut store).unwrap().unwrap();
    assert_eq!((r.track.as_str(), r.seeds.len()), ("Monaco", 1));
}

#[test]
#[ignore = "a timing probe: cargo test --release -p vectorvroom-brain-core --test train -- --ignored --nocapture"]
fn how_long_a_session_takes() {
    let (mut brain, mut store) = world();
    let started = std::time::Instant::now();
    let r = brain.train(Training { frames: 120_000, idle_minutes: 0 }, T0 + MINUTE, 7, &mut store).unwrap().unwrap();
    eprintln!("{} runs, {} frames in {:.0} ms", r.runs, r.frames, started.elapsed().as_secs_f64() * 1e3);
}

/// A contribution of brains filed on a track (its embedding, seeded).
fn contribute_on(brain: &mut Brain, store: &mut MemStore, token: &str, vectors: &[Vec<f32>], ctx: &Value, track: u64, now: u64) {
    let mut t = vec![0f32; 512];
    t[track as usize % 512] = 1.0;
    let brains: Vec<Value> = vectors.iter().map(|v| json!({"vector": encode_f32(v), "fitness": 1, "track": 0, "meta": {"learning": {"context": ctx, "styleScore": 0}}})).collect();
    let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": token, "tracks": [encode_f32(&t)], "brains": brains})).unwrap();
    brain.contribute(parse_contribute(&body).unwrap(), &contributor_id(token), now, store).unwrap().unwrap();
}

#[test]
fn one_token_neither_picks_the_context_nor_files_what_is_bred() {
    let mut store = MemStore::default();
    let mut brain = Brain::open(Config::default(), &mut store, T0).unwrap();
    let seeds = seeds();
    let rect = context(&rectangle_key());
    let mut wild = rect.clone();
    wild["profile"] = json!("wild");
    // One token, five brains in wild, filed on track 7; two players, one
    // brain each in balanced, on track 3; a third player's on track 7.
    let five: Vec<Vec<f32>> = (1..=5).map(|i| seeds[1].iter().map(|w| w * (0.5 + 0.05 * i as f32)).collect()).collect();
    contribute_on(&mut brain, &mut store, OTHER, &five, &wild, 7, T0);
    contribute_on(&mut brain, &mut store, OWNER, &seeds[..1], &rect, 3, T0);
    contribute_on(&mut brain, &mut store, "00112233445566778899aabbccddeeff", &seeds[1..2], &rect, 3, T0);
    contribute_on(&mut brain, &mut store, "ffeeddccbbaa99887766554433221100", &seeds[2..3], &rect, 7, T0);
    // The context of more players first, though one token holds more brains.
    let mut archived = None;
    for session in (0..40).step_by(2) {
        let r = brain.train(Training { frames: 60_000, idle_minutes: 0 }, T0 + MINUTE, session, &mut store).unwrap().unwrap();
        assert_eq!(r.context.profile, "balanced", "{r:?}");
        if r.archived.is_some() {
            archived = r.archived;
            break;
        }
    }
    let id = archived.expect("a session beat the seeds");
    // Filed on the track two players use, not the one a single token chose.
    let three = store.brains.values().find(|(row, _)| row.contributor == contributor_id(OWNER)).unwrap().0.track.clone();
    assert_eq!(store.brains[&id].0.track, three);
}

#[test]
fn the_service_keeps_at_most_its_quota_of_brains_the_weakest_go_first() {
    let (_, mut store) = world();
    // CLOUD_BRAINS weak brains of the service's (as a store would hold them).
    let ctx = context(&rectangle_key());
    for i in 0..CLOUD_BRAINS {
        let v: Vec<f32> = seeds()[1].iter().map(|w| w * (0.3 + i as f32 * 0.001)).collect();
        let meta = json!({"source": "cloud", "learning": {"context": ctx, "styleScore": 0}}).to_string();
        let row = BrainRow { id: wire::brain_id(&v), fitness: -1.0 - i as f64, track: None, dynamics: None, meta, contributor: CLOUD_CONTRIBUTOR.into(), created: T0 };
        store.put_brain(&row, &v).unwrap();
    }
    let mut brain = Brain::open(Config::default(), &mut store, T0).unwrap();
    let weakest = store.brains.iter().filter(|(_, (r, _))| r.contributor == CLOUD_CONTRIBUTOR).min_by(|a, b| a.1 .0.fitness.total_cmp(&b.1 .0.fitness)).unwrap().0.clone();
    let mut archived = None;
    for session in 0..20u64 {
        if let Some(id) = brain.train(TRAINING, T0 + 11 * MINUTE, session, &mut store).unwrap().unwrap().archived {
            archived = Some(id);
            break;
        }
    }
    let id = archived.expect("a session beat the seeds");
    let held = store.brains.values().filter(|(r, _)| r.contributor == CLOUD_CONTRIBUTOR).count();
    assert_eq!(held, CLOUD_BRAINS);
    assert!(store.brains.contains_key(&id) && !store.brains.contains_key(&weakest));
}

#[test]
fn a_brain_the_service_drove_on_a_preset_is_kept_by_its_run_the_services_and_the_players_alike() {
    // Room for 6 brains: the 4 seeds, then one the service breeds, and a
    // player's brain verified on the Rectangle at its run.
    let mut store = MemStore::default();
    let mut brain = Brain::open(Config { max_brains: 6, keep_per_track: 0, ..Config::default() }, &mut store, T0).unwrap();
    let ctx = context(&rectangle_key());
    contribute(&mut brain, &mut store, OWNER, &seeds(), &ctx, T0);
    let mut archived = None;
    for session in 0..20u64 {
        if let Some(id) = brain.train(TRAINING, T0 + 11 * MINUTE, session, &mut store).unwrap().unwrap().archived {
            archived = Some(id);
            break;
        }
    }
    let cloud = archived.expect("a session beat the seeds");
    let cloud_fitness = store.brains[&cloud].0.fitness;
    // Players' brains with no run (quarantined claims) go before it.
    let filler: Vec<Vec<f32>> = (0..3).map(|i| seeds()[1].iter().map(|w| w * (0.4 + 0.01 * i as f32)).collect()).collect();
    contribute(&mut brain, &mut store, OTHER, &filler, &ctx, T0 + 12 * MINUTE);
    assert!(store.brains.contains_key(&cloud), "kept by its run");
    // The evolved seed (verified at 6 by a player) outlives a weaker run.
    let evolved = wire::brain_id(&seeds()[0]);
    let rect = &presets().iter().find(|p| p.name == "Rectangle").unwrap().geometry;
    let track = json!({"width": rect.width, "height": rect.height, "inner": rect.inner, "outer": rect.outer, "checkpoints": rect.checkpoints});
    let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": OTHER, "vector": encode_f32(&seeds()[0]), "track": track, "context": ctx})).unwrap();
    brain.verify(parse_verify(&body).unwrap(), &contributor_id(OTHER), T0 + 13 * MINUTE, &mut store).unwrap().unwrap();
    contribute(&mut brain, &mut store, OTHER, &[seeds()[2].iter().map(|w| w * 0.45).collect()], &ctx, T0 + 14 * MINUTE);
    assert!(store.brains.contains_key(&evolved), "verified at 6, kept");
    assert!(cloud_fitness >= 6.0 && store.brains.contains_key(&cloud));
}

#[test]
fn the_services_own_brains_do_not_make_a_context_busy_and_what_it_breeds_is_kept_in_the_room_there_is() {
    // The service's brains in wild (one player there too), and two players in
    // balanced: balanced is the busiest (the service is no player).
    let mut store = MemStore::default();
    let rect = context(&rectangle_key());
    let mut wild = rect.clone();
    wild["profile"] = json!("wild");
    for i in 0..3 {
        let v: Vec<f32> = seeds()[1].iter().map(|w| w * (0.6 + i as f32 * 0.01)).collect();
        let meta = json!({"source": "cloud", "learning": {"context": wild, "styleScore": 0}}).to_string();
        store.put_brain(&BrainRow { id: wire::brain_id(&v), fitness: 1.0, track: None, dynamics: None, meta, contributor: CLOUD_CONTRIBUTOR.into(), created: T0 }, &v).unwrap();
    }
    // Room for exactly the brains held when the session archives: one goes.
    let mut brain = Brain::open(Config { max_brains: 6, keep_per_track: 0, ..Config::default() }, &mut store, T0).unwrap();
    contribute(&mut brain, &mut store, OTHER, &[seeds()[2].iter().map(|w| w * 0.7).collect()], &wild, T0);
    contribute(&mut brain, &mut store, OWNER, &seeds()[..1], &rect, T0);
    contribute(&mut brain, &mut store, "00112233445566778899aabbccddeeff", &seeds()[1..2], &rect, T0);
    assert_eq!(store.brains.len(), 6);
    let mut archived = None;
    for session in (0..60).step_by(2) {
        let r = brain.train(Training { frames: 60_000, idle_minutes: 0 }, T0 + MINUTE, session, &mut store).unwrap().unwrap();
        assert_eq!(r.context.profile, "balanced");
        if r.archived.is_some() {
            archived = r.archived;
            break;
        }
    }
    assert!(archived.is_some(), "a session beat the seeds");
    assert_eq!(store.brains.len(), 6, "one brain made room");
}

#[test]
fn a_brain_never_driven_gets_its_turn_whatever_the_claims_around_it() {
    // The evolved brain (it laps: 6) among ten others claiming more, with
    // lower ids, none driven yet: within a few sessions it is a seed, and
    // its run is its standing there.
    let mut store = MemStore::default();
    let mut brain = Brain::open(Config::default(), &mut store, T0).unwrap();
    let ctx = context(&rectangle_key());
    let others: Vec<Vec<f32>> = (0..10).map(|i| seeds()[1].iter().map(|w| w * (0.5 + 0.03 * i as f32)).collect()).collect();
    let claim = |vectors: &[Vec<f32>], fitness: f64| -> Vec<u8> {
        let brains: Vec<Value> = vectors.iter().map(|v| json!({"vector": encode_f32(v), "fitness": fitness, "meta": {"learning": {"context": ctx, "styleScore": 0}}})).collect();
        serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": OTHER, "brains": brains})).unwrap()
    };
    brain.contribute(parse_contribute(&claim(&others, 50.0)).unwrap(), &contributor_id(OTHER), T0, &mut store).unwrap().unwrap();
    contribute(&mut brain, &mut store, OWNER, &seeds()[..1], &ctx, T0);
    let evolved = wire::brain_id(&seeds()[0]);
    let mut sessions = 0;
    while !store.verified.iter().any(|r| r.brain == evolved) {
        brain.train(Training { frames: 6_000, idle_minutes: 0 }, T0 + MINUTE, sessions, &mut store).unwrap().unwrap();
        sessions += 1;
        assert!(sessions <= 11, "every brain is tried within as many sessions as there are");
    }
    let r = brain.train(Training { frames: 6_000, idle_minutes: 0 }, T0 + MINUTE, 99, &mut store).unwrap().unwrap();
    assert!(r.seeds.contains(&evolved) && r.seed_fitness == 6.0, "{r:?}");
}

#[test]
fn what_is_bred_names_the_seed_it_descends_from() {
    // A random brain claiming 50 and the evolved one claiming 1, neither
    // driven yet: the claim of 50 is the first seed, and only the evolved
    // one's children can beat its 6. A first session that archives one
    // names the evolved brain.
    let ctx = context(&rectangle_key());
    for session in 1_000..1_060u64 {
        let mut store = MemStore::default();
        let mut brain = Brain::open(Config::default(), &mut store, T0).unwrap();
        let brains = vec![json!({"vector": encode_f32(&seeds()[1]), "fitness": 50, "meta": {"learning": {"context": ctx, "styleScore": 0}}}),
            json!({"vector": encode_f32(&seeds()[0]), "fitness": 1, "meta": {"learning": {"context": ctx, "styleScore": 0}}})];
        let body = serde_json::to_vec(&json!({"protocol": 1, "brainSchema": 6, "token": OWNER, "brains": brains})).unwrap();
        brain.contribute(parse_contribute(&body).unwrap(), &contributor_id(OWNER), T0, &mut store).unwrap().unwrap();
        let r = brain.train(Training { frames: 120_000, idle_minutes: 0 }, T0 + MINUTE, session, &mut store).unwrap().unwrap();
        assert_eq!(r.seeds[0], wire::brain_id(&seeds()[1]), "the claim of 50 ranks first");
        if let Some(id) = r.archived {
            let meta: Value = serde_json::from_str(&store.brains[&id].0.meta).unwrap();
            assert_eq!(meta["parentIds"][0], wire::brain_id(&seeds()[0]), "bred from the evolved one");
            return;
        }
    }
    panic!("no first session beat the seeds");
}

#[test]
fn twelve_sessions_are_pinned_change_the_search_on_purpose_then_this() {
    // Sessions 1000 to 1011 on the Rectangle world: what the search does
    // now (each session's best fitness and what it archived). A change to
    // the search (seeds, parents, rates, the pool) changes this.
    let (mut brain, mut store) = world();
    let mut now = T0 + 11 * MINUTE;
    let mut summary = Vec::new();
    for session in 1_000..1_012u64 {
        let r = brain.train(TRAINING, now, session, &mut store).unwrap().unwrap();
        summary.push(format!("{}:{}", r.best_fitness, r.archived.as_deref().map_or("-", |id| &id[6..14])));
        now += 30 * MINUTE;
    }
    let summary = summary.join(" ");
    eprintln!("pinned: {summary}");
    assert_eq!(summary, PINNED);
}
const PINNED: &str = "7:bbea40df 7:- 8:c959e870 8:- 8:- 8:- 8:- 8:- 9:a143f48c 9:- 9:- 9:c268fb45";
