//! Everyone's crash map (X4 of docs/plan/cloud-brain.md): pages send where
//! their cars crashed on a track (a 16 × 9 map, car contact left out) and the
//! gate layout they were measured with; a recall gives the crash map of the
//! nearest tracks, one vote a contributor, and the best layouts for the walls.

use serde_json::{json, Value};
use vectorvroom_brain_core::brain::{contributor_id, Brain, Config, MemStore, Usage, CRASH_CONTRIBUTORS, CRASH_LAYOUTS, CRASH_MODES, QUOTA};
use vectorvroom_brain_core::wire::{self, decode_f32, encode_f32, parse_crash_recall, parse_crashes, Reason, CRASH_DIM, TRACK_DIM};

const T0: u64 = 1_790_000_000_000;

fn token(i: usize) -> String {
    format!("{:032x}", 0xc0ffee + i)
}
/// A unit track embedding near `axis` (tilt 0: exactly it).
fn track(axis: usize, tilt: f32) -> Vec<f32> {
    tilted(axis, axis + 1, tilt)
}
/// `axis` tilted toward `toward`: as alike to `track(axis, 0.0)` as
/// 1/sqrt(1 + tilt²).
fn tilted(axis: usize, toward: usize, tilt: f32) -> Vec<f32> {
    let mut v = vec![0f32; TRACK_DIM];
    v[axis] = 1.0;
    v[toward % TRACK_DIM] = tilt;
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / n).collect()
}
/// A crash map with deaths in these cells (log1p, length 1, as crashMapCodec.js).
fn map(cells: &[(usize, f32)]) -> Vec<f32> {
    let mut m = vec![0f32; CRASH_DIM];
    for (i, n) in cells {
        m[*i] = (1.0 + n).ln();
    }
    let norm = m.iter().map(|x| x * x).sum::<f32>().sqrt();
    m.iter().map(|x| x / norm).collect()
}
fn body(t: &str, track: &[f32], m: &[f32], extra: Value) -> Vec<u8> {
    let mut b = json!({"protocol": 1, "token": t, "track": encode_f32(track), "map": encode_f32(m), "deaths": 12});
    for (k, v) in extra.as_object().unwrap() {
        b[k] = v.clone();
    }
    serde_json::to_vec(&b).unwrap()
}
fn layout(geometry: &str, survival: f64, x: f64) -> Value {
    json!({"geometry": geometry, "survival": survival, "gates": [[[x, 300], [x, 700]], [[2000, 300], [2000, 700]]]})
}

struct W {
    brain: Brain,
    store: MemStore,
}
impl W {
    fn new(config: Config) -> W {
        let mut store = MemStore::default();
        W { brain: Brain::open(config, &mut store, T0).unwrap(), store }
    }
    fn send(&mut self, t: &str, track: &[f32], m: &[f32], extra: Value, now: u64) -> Value {
        let c = parse_crashes(&body(t, track, m, extra)).unwrap();
        match self.brain.crashes(c, &contributor_id(t), now, &mut self.store).unwrap() {
            Ok(a) => json!(a),
            Err(limited) => json!({"limited": limited.retry_after}),
        }
    }
    fn recall(&self, track: &[f32], extra: Value) -> Value {
        let mut b = json!({"protocol": 1, "track": encode_f32(track)});
        for (k, v) in extra.as_object().unwrap() {
            b[k] = v.clone();
        }
        json!(self.brain.crash_recall(&parse_crash_recall(&serde_json::to_vec(&b).unwrap()).unwrap(), &self.store).unwrap())
    }
}
fn decoded(answer: &Value) -> Vec<f32> {
    decode_f32(Some(&answer["map"]), CRASH_DIM).expect("a map")
}
fn close(a: &[f32], b: &[f32]) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5)
}

#[test]
fn a_recall_gives_everyones_map_on_this_track_and_its_near_neighbours_one_vote_a_contributor() {
    let mut w = W::new(Config::default());
    let here = track(3, 0.0);
    // Two contributors on this track, one on a near one (similarity ~0.98),
    // one on a far one, one in another collision mode.
    w.send(&token(1), &here, &map(&[(10, 5.0)]), json!({}), T0);
    w.send(&token(2), &here, &map(&[(20, 5.0)]), json!({}), T0);
    w.send(&token(3), &track(3, 0.2), &map(&[(30, 5.0)]), json!({}), T0);
    w.send(&token(4), &track(200, 0.0), &map(&[(40, 5.0)]), json!({}), T0);
    w.send(&token(5), &here, &map(&[(50, 5.0)]), json!({"collisions": "solid/k8"}), T0);
    let a = w.recall(&here, json!({}));
    assert_eq!((a["contributors"].as_u64(), a["tracks"].as_u64()), (Some(3), Some(2)), "{a}");
    let m = decoded(&a);
    assert!(m[10] > 0.0 && m[20] > 0.0 && m[30] > 0.0, "theirs");
    assert_eq!((m[40], m[50]), (0.0, 0.0), "not the far track's, nor another mode's");
    assert!((m[10] - m[20]).abs() < 1e-6 && m[30] < m[10], "the near track's weighs by its likeness");
    assert!((m.iter().map(|x| x * x).sum::<f32>().sqrt() - 1.0).abs() < 1e-5, "length 1");
    // In the solid mode: only that one.
    let solid = w.recall(&here, json!({"collisions": "solid/k8"}));
    assert!(close(&decoded(&solid), &map(&[(50, 5.0)])));
    // A contributor's latest replaces theirs: one vote, however often they send.
    for i in 0..5 {
        w.send(&token(1), &here, &map(&[(60 + i, 5.0)]), json!({}), T0 + 1 + i as u64);
    }
    let a = w.recall(&here, json!({}));
    assert_eq!(a["contributors"].as_u64(), Some(3));
    let m = decoded(&a);
    assert!(m[10] == 0.0 && m[64] > 0.0 && m[60] == 0.0, "their latest only");
    // Nobody here yet: no map.
    let none = w.recall(&track(400, 0.0), json!({}));
    assert_eq!((none["map"].clone(), none["contributors"].as_u64()), (Value::Null, Some(0)));
    // A rebuild serves the same (the maps live in the store).
    let before = w.recall(&here, json!({}));
    w.brain = Brain::open(Config::default(), &mut w.store, T0 + 10).unwrap();
    assert_eq!(w.recall(&here, json!({})), before);
}

#[test]
fn a_track_keeps_its_16_most_recent_contributors_and_maps_go_with_their_track() {
    let mut w = W::new(Config { max_tracks: 2, ..Config::default() });
    let here = track(7, 0.0);
    for i in 0..CRASH_CONTRIBUTORS + 3 {
        w.send(&token(i), &here, &map(&[(i, 5.0)]), json!({}), T0 + i as u64);
    }
    let a = w.recall(&here, json!({}));
    assert_eq!(a["contributors"].as_u64(), Some(CRASH_CONTRIBUTORS as u64));
    let m = decoded(&a);
    assert!(m[0] == 0.0 && m[2] == 0.0 && m[3] > 0.0 && m[CRASH_CONTRIBUTORS + 2] > 0.0, "the 3 least recent went");
    // Two more tracks with no brains: the oldest (this one) makes room, its maps with it.
    w.send(&token(90), &track(100, 0.0), &map(&[(1, 5.0)]), json!({}), T0 + 100);
    w.send(&token(91), &track(300, 0.0), &map(&[(1, 5.0)]), json!({}), T0 + 101);
    assert!(w.store.crashes.iter().all(|r| r.map.len() == CRASH_DIM));
    assert_eq!(w.recall(&here, json!({}))["map"], Value::Null);
    assert_eq!(w.store.crashes.len(), 2);
}

#[test]
fn layouts_are_each_contributors_best_for_the_walls_and_mode_the_best_survival_first() {
    let mut w = W::new(Config::default());
    let here = track(9, 0.0);
    let m = map(&[(1, 3.0)]);
    for (i, survival) in [0.4, 0.9, 0.6, 0.7, 0.5].into_iter().enumerate() {
        w.send(&token(i), &here, &m, json!({"layout": layout("g1a2b", survival, 1000.0 + i as f64)}), T0 + i as u64);
    }
    // A worse layout from a contributor keeps their better one; a better
    // replaces it; a map with no layout keeps theirs.
    w.send(&token(1), &here, &m, json!({"layout": layout("g1a2b", 0.1, 5.0)}), T0 + 10);
    w.send(&token(0), &here, &m, json!({"layout": layout("g1a2b", 0.95, 77.0)}), T0 + 11);
    w.send(&token(0), &here, &m, json!({}), T0 + 12);
    // An equal one replaces theirs (the latest measurement).
    w.send(&token(3), &here, &m, json!({"layout": layout("g1a2b", 0.7, 33.0)}), T0 + 13);
    // Other walls, another mode.
    w.send(&token(7), &here, &m, json!({"layout": layout("gffff", 0.99, 1.0)}), T0 + 14);
    w.send(&token(8), &here, &m, json!({"layout": layout("g1a2b", 0.99, 1.0), "collisions": "solid/k8"}), T0 + 15);
    let a = w.recall(&here, json!({"geometry": "g1a2b"}));
    let got: Vec<(f64, f64)> = a["layouts"].as_array().unwrap().iter().map(|l| (l["survival"].as_f64().unwrap(), l["gates"][0][0][0].as_f64().unwrap())).collect();
    assert_eq!(got, vec![(0.95, 77.0), (0.9, 1001.0), (0.7, 33.0), (0.6, 1002.0)]);
    assert_eq!(got.len(), CRASH_LAYOUTS);
    assert_eq!(w.recall(&here, json!({}))["layouts"], json!([]), "no walls asked: none");
    assert_eq!(w.recall(&here, json!({"geometry": "g1a2b", "collisions": "solid/k8"}))["layouts"].as_array().unwrap().len(), 1);
    assert_eq!(w.recall(&here, json!({"geometry": "g0"}))["layouts"], json!([]), "walls nobody shared for");
    // From the neighbourhood too, each contributor's best once: theirs on a
    // near track beats theirs here.
    w.send(&token(4), &track(9, 0.2), &m, json!({"layout": layout("g1a2b", 0.97, 44.0)}), T0 + 16);
    w.send(&token(2), &track(9, 0.2), &m, json!({"layout": layout("g1a2b", 0.2, 22.0)}), T0 + 17);
    let a = w.recall(&here, json!({"geometry": "g1a2b"}));
    let got: Vec<(f64, f64)> = a["layouts"].as_array().unwrap().iter().map(|l| (l["survival"].as_f64().unwrap(), l["gates"][0][0][0].as_f64().unwrap())).collect();
    assert_eq!(got, vec![(0.97, 44.0), (0.95, 77.0), (0.9, 1001.0), (0.7, 33.0)]);
    // Ties: the contributor's id decides, the same after a rebuild.
    let mut ties = W::new(Config::default());
    for i in [5, 2, 9, 1, 7] {
        ties.send(&token(i), &here, &m, json!({"layout": layout("g1a2b", 0.5, i as f64)}), T0 + i as u64);
    }
    let first = ties.recall(&here, json!({"geometry": "g1a2b"}));
    assert_eq!(first["layouts"].as_array().unwrap().len(), CRASH_LAYOUTS);
    ties.brain = Brain::open(Config::default(), &mut ties.store, T0 + 99).unwrap();
    assert_eq!(ties.recall(&here, json!({"geometry": "g1a2b"})), first);
}

#[test]
fn forget_takes_a_contributors_maps_and_layouts_and_a_send_counts_on_the_quota() {
    let mut w = W::new(Config { quota: Usage { requests: 3, ..QUOTA }, ..Config::default() });
    let here = track(11, 0.0);
    w.send(&token(1), &here, &map(&[(5, 4.0)]), json!({"layout": layout("g1", 0.5, 10.0)}), T0);
    w.send(&token(2), &here, &map(&[(6, 4.0)]), json!({"layout": layout("g1", 0.6, 20.0)}), T0);
    w.send(&token(1), &here, &map(&[(5, 4.0)]), json!({"collisions": "solid/k8"}), T0);
    let forgot = w.brain.forget(&contributor_id(&token(1)), &mut w.store).unwrap();
    assert_eq!((forgot.brains, forgot.crashes), (0, 2), "both their maps, with the layout");
    assert_eq!(w.brain.forget(&contributor_id(&token(1)), &mut w.store).unwrap().crashes, 0);
    let a = w.recall(&here, json!({"geometry": "g1"}));
    assert_eq!(a["contributors"].as_u64(), Some(1));
    assert!(close(&decoded(&a), &map(&[(6, 4.0)])));
    assert_eq!(a["layouts"].as_array().unwrap().len(), 1);
    // Three requests a day for this token: the fourth is refused, nothing kept.
    let t = token(2);
    for i in 0..2 {
        assert_eq!(w.send(&t, &here, &map(&[(7, 4.0)]), json!({}), T0 + 1 + i)["accepted"], true);
    }
    let refused = w.send(&t, &here, &map(&[(8, 4.0)]), json!({}), T0 + 5);
    assert!(refused["limited"].as_u64().unwrap() > 0, "{refused}");
    assert!(close(&decoded(&w.recall(&here, json!({}))), &map(&[(7, 4.0)])));
}

#[test]
fn the_neighbourhood_is_the_tracks_at_least_0_9_alike_and_counts_a_contributor_once() {
    let mut w = W::new(Config::default());
    let here = track(20, 0.0);
    // 0.912 alike (in), 0.887 alike (out), in different directions so they
    // stay tracks of their own.
    w.send(&token(1), &tilted(20, 21, 0.45), &map(&[(1, 5.0)]), json!({}), T0);
    w.send(&token(2), &tilted(20, 22, 0.52), &map(&[(2, 5.0)]), json!({}), T0);
    let a = w.recall(&here, json!({}));
    assert_eq!((a["contributors"].as_u64(), a["tracks"].as_u64()), (Some(1), Some(1)), "{a}");
    assert!(close(&decoded(&a), &map(&[(1, 5.0)])));
    // Closer to the line: 0.9005 alike is in, 0.8995 is out.
    let mut edge = W::new(Config::default());
    edge.send(&token(1), &tilted(20, 24, 0.4829), &map(&[(1, 5.0)]), json!({}), T0);
    edge.send(&token(2), &tilted(20, 25, 0.4857), &map(&[(2, 5.0)]), json!({}), T0);
    assert!(close(&decoded(&edge.recall(&here, json!({}))), &map(&[(1, 5.0)])));
    // A contributor who drove here and on the near track votes once, with
    // the map of the nearest track they sent one on.
    w.send(&token(1), &here, &map(&[(3, 5.0)]), json!({}), T0 + 1);
    let a = w.recall(&here, json!({}));
    assert_eq!((a["contributors"].as_u64(), a["tracks"].as_u64()), (Some(1), Some(1)), "{a}");
    assert!(close(&decoded(&a), &map(&[(3, 5.0)])), "this track's, not the near one's");
    // Seen from the near track, theirs there is the nearest.
    assert!(close(&decoded(&w.recall(&tilted(20, 21, 0.45), json!({}))), &map(&[(1, 5.0)])));
    // A track with maps in another mode only is not counted.
    w.send(&token(3), &tilted(20, 23, 0.3), &map(&[(4, 5.0)]), json!({"collisions": "solid/k8"}), T0 + 2);
    let a = w.recall(&here, json!({}));
    assert_eq!((a["contributors"].as_u64(), a["tracks"].as_u64()), (Some(1), Some(1)), "{a}");
    let solid = w.recall(&here, json!({"collisions": "solid/k8"}));
    assert_eq!((solid["contributors"].as_u64(), solid["tracks"].as_u64()), (Some(1), Some(1)), "{solid}");
}

#[test]
fn a_track_keeps_4_collision_modes_the_one_with_the_fewest_contributors_goes_whole() {
    let mut w = W::new(Config::default());
    let here = track(30, 0.0);
    let m = map(&[(1, 5.0)]);
    assert_eq!(CRASH_MODES, 4);
    // The players': 3 in normal driving, 2 with solid cars.
    for i in 0..3 {
        w.send(&token(i), &here, &m, json!({}), T0);
    }
    for i in 3..5 {
        w.send(&token(i), &here, &m, json!({"collisions": "solid/k8/rays"}), T0 + 1);
    }
    // One token's made-up modes push out each other (the least recently
    // sent to among the smallest), never the players'.
    for (i, mode) in ["a", "b", "c", "d", "e"].iter().enumerate() {
        w.send(&token(9), &here, &m, json!({"collisions": mode}), T0 + 2 + i as u64);
    }
    let count = |w: &W, mode: &str| w.recall(&here, json!({"collisions": mode}))["contributors"].as_u64().unwrap();
    let modes = |w: &W| ["off", "solid/k8/rays", "a", "b", "c", "d", "e", "f"].map(|mode| count(w, mode));
    assert_eq!(modes(&w), [3, 2, 0, 0, 0, 1, 1, 0]);
    // A contributor already held in a mode never pushes a mode out.
    w.send(&token(0), &here, &m, json!({}), T0 + 10);
    w.send(&token(10), &here, &m, json!({"collisions": "d"}), T0 + 11);
    assert_eq!(modes(&w), [3, 2, 0, 0, 0, 2, 1, 0]);
    // The smallest goes even when sent to more recently than the others.
    w.send(&token(11), &here, &m, json!({"collisions": "f"}), T0 + 12);
    assert_eq!(modes(&w), [3, 2, 0, 0, 0, 2, 0, 1]);
    let mut held: Vec<&str> = w.store.crashes.iter().map(|r| r.mode.as_str()).collect();
    held.sort();
    held.dedup();
    assert_eq!(held, ["d", "f", "off", "solid/k8/rays"]);
    assert_eq!(w.store.crashes.len(), 8);
}

#[test]
fn ties_between_tracks_go_by_contributor_and_a_layout_for_other_walls_replaces_theirs() {
    let mut w = W::new(Config::default());
    let here = track(40, 0.0);
    let near = track(40, 0.2);
    let m = map(&[(1, 3.0)]);
    // Five contributors at the same survival, the two of them first by id on
    // the near track: the 4 by id, wherever they sent from.
    let mut ids: Vec<(String, usize)> = (0..5).map(|i| (contributor_id(&token(i)), i)).collect();
    ids.sort();
    for (rank, (_, i)) in ids.iter().enumerate() {
        let on = if rank < 2 { &near } else { &here };
        w.send(&token(*i), on, &m, json!({"layout": layout("g1a2b", 0.5, *i as f64)}), T0 + rank as u64);
    }
    let xs = |a: &Value| a["layouts"].as_array().unwrap().iter().map(|l| l["gates"][0][0][0].as_f64().unwrap() as usize).collect::<Vec<_>>();
    let a = w.recall(&here, json!({"geometry": "g1a2b"}));
    assert_eq!(xs(&a), ids.iter().take(CRASH_LAYOUTS).map(|(_, i)| *i).collect::<Vec<_>>());
    // A contributor with equal layouts on two tracks: the nearest track's.
    let (_, first) = ids[0];
    w.send(&token(first), &here, &m, json!({"layout": layout("g1a2b", 0.5, 99.0)}), T0 + 10);
    assert_eq!(xs(&w.recall(&here, json!({"geometry": "g1a2b"})))[0], 99);
    assert_eq!(xs(&w.recall(&near, json!({"geometry": "g1a2b"})))[0], first);
    // A worse layout for other walls replaces theirs: survivals of other
    // walls do not compare.
    w.send(&token(first), &here, &m, json!({"layout": layout("gffff", 0.1, 7.0)}), T0 + 11);
    assert_eq!(xs(&w.recall(&here, json!({"geometry": "gffff"}))), [7]);
    assert_eq!(xs(&w.recall(&here, json!({"geometry": "g1a2b"})))[0], first, "theirs from the near track now");
}

#[test]
fn hostile_crash_maps_and_recalls_are_refused_with_reasons() {
    let here = track(1, 0.0);
    let good = map(&[(3, 4.0)]);
    let reason = |b: Vec<u8>| parse_crashes(&b).err();
    assert!(reason(body(&token(1), &here, &good, json!({}))).is_none());
    assert_eq!(reason(body("x", &here, &good, json!({}))), Some(Reason::Token));
    assert_eq!(reason(body(&token(1), &here[..10], &good, json!({}))), Some(Reason::Track));
    assert_eq!(reason(body(&token(1), &here.iter().map(|x| x * 2.0).collect::<Vec<_>>(), &good, json!({}))), Some(Reason::Track));
    let negative: Vec<f32> = good.iter().enumerate().map(|(i, x)| if i == 3 { -x } else { *x }).collect();
    assert_eq!(reason(body(&token(1), &here, &negative, json!({}))), Some(Reason::CrashMap));
    assert_eq!(reason(body(&token(1), &here, &good.iter().map(|x| x * 3.0).collect::<Vec<_>>(), json!({}))), Some(Reason::CrashMap));
    assert_eq!(reason(body(&token(1), &here, &good[..100], json!({}))), Some(Reason::CrashMap));
    assert_eq!(reason(body(&token(1), &here, &vec![0.0; CRASH_DIM], json!({}))), Some(Reason::CrashMap), "no deaths at all");
    assert_eq!(reason(body(&token(1), &here, &good, json!({"deaths": 2}))), Some(Reason::CrashMap));
    assert_eq!(reason(body(&token(1), &here, &good, json!({"deaths": 3.5}))), Some(Reason::CrashMap));
    for bad in [json!({"geometry": "G12"}), json!({"geometry": "g123456789"}), json!({"geometry": "g1", "survival": 1.5, "gates": [[[0, 0], [1, 1]]]}),
        json!({"geometry": "g1", "survival": 0.5, "gates": []}), json!({"geometry": "g1", "survival": 0.5, "gates": vec![json!([[0, 0], [1, 1]]); 65]}),
        json!({"geometry": "g1", "survival": 0.5, "gates": [[[0, 0], [1e6, 1]]]}), json!("g1")] {
        assert_eq!(reason(body(&token(1), &here, &good, json!({"layout": bad}))), Some(Reason::CrashLayout), "{bad}");
    }
    let c = parse_crashes(&body(&token(1), &here, &good, json!({"collisions": 3}))).unwrap();
    assert_eq!(c.collisions, "unknown", "a mode that is not a label");
    assert_eq!(parse_crashes(&body(&token(1), &here, &good, json!({"collisions": "SOLID/K08"}))).unwrap().collisions, "solid/k8");
    let recall = |b: Value| parse_crash_recall(&serde_json::to_vec(&b).unwrap()).err();
    assert!(recall(json!({"protocol": 1, "track": encode_f32(&here)})).is_none());
    assert_eq!(recall(json!({"protocol": 1, "track": "AAAA"})), Some(Reason::Track));
    assert_eq!(recall(json!({"protocol": 1, "track": encode_f32(&here), "geometry": "nope"})), Some(Reason::CrashLayout));
    assert_eq!(recall(json!({"protocol": 2, "track": encode_f32(&here)})), Some(Reason::Protocol));
    assert!(wire::is_geometry_sig("g0") && wire::is_geometry_sig("gdeadbeef") && !wire::is_geometry_sig("g") && !wire::is_geometry_sig("gDEAD"));
}
