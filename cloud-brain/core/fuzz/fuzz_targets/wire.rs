//! Any bytes through the request parsers (CB1's rules, core/src/wire.rs, and
//! X1's verification and leaderboard query): none panics, and whatever one
//! accepts holds what the wire format promises (crash maps, X4, too). A track a verification
//! accepts is driven on for a few seconds: the simulator never panics on it.

#![no_main]

use libfuzzer_sys::fuzz_target;
use serde_json::Value;
use vectorvroom_brain_core::wire::{self, limits, Context, PROFILES};
use vectorvroom_sim as sim;

/// No -0 anywhere in a value (outputs never hold one).
fn no_negative_zero(v: &Value) -> bool {
    match v {
        Value::Number(n) => n.as_f64().map_or(true, |x| !(x == 0.0 && x.is_sign_negative())),
        Value::Array(items) => items.iter().all(no_negative_zero),
        Value::Object(map) => map.values().all(no_negative_zero),
        _ => true,
    }
}

fn clean(c: &Context) {
    assert!(PROFILES.contains(&c.profile.as_str()), "{c:?}");
    assert!(c.track.len() <= limits::TRACK_KEY && c.track.bytes().all(|b| (0x20..=0x7e).contains(&b)), "{c:?}");
    assert!((1.0..=100.0).contains(&c.max_speed) && (0.0..=1.0).contains(&c.traction) && (1.0..=600.0).contains(&c.seconds), "{c:?}");
    let label = c.collisions.as_str();
    assert!(label.len() <= 40, "{c:?}");
    assert!(
        label == "off" || label == "unknown" || label.split('/').all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())),
        "{c:?}"
    );
    assert!(no_negative_zero(&serde_json::to_value(c).unwrap()));
}

fn unit(v: &[f32], dim: usize) {
    assert!(v.len() == dim && v.iter().all(|x| x.is_finite()) && wire::is_unit(v));
}

fuzz_target!(|data: &[u8]| {
    match wire::parse_contribute(data) {
        Ok(c) => {
            assert!(data.len() <= limits::REQUEST_BYTES);
            assert!(c.token.len() == 32 && c.token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            assert!(c.tracks.len() <= limits::TRACKS_PER_REQUEST);
            assert!(c.brains.len() + c.rejected.len() <= limits::BRAINS_PER_REQUEST);
            assert!(c.feedback.len() + c.feedback_rejected.len() <= limits::FEEDBACK_PER_REQUEST);
            c.tracks.iter().for_each(|t| unit(t, wire::TRACK_DIM));
            for (i, b) in c.brains.iter().enumerate() {
                assert!(wire::brain_problem(Some(&b.vector)).is_none());
                assert_eq!(b.id, wire::brain_id(&b.vector));
                assert!(c.brains[..i].iter().all(|a| a.id != b.id), "a duplicate accepted");
                assert!(b.fitness.abs() <= limits::FITNESS && !(b.fitness == 0.0 && b.fitness.is_sign_negative()));
                assert!(b.track.map_or(true, |t| t < c.tracks.len()));
                if let Some(d) = &b.dynamics {
                    unit(d, wire::DYNAMICS_DIM);
                }
                let meta = serde_json::to_value(&b.meta).unwrap();
                assert!(no_negative_zero(&meta));
                if let Some(l) = &b.meta.learning {
                    clean(&l.context);
                }
                assert!(b.meta.parent_ids.as_ref().map_or(true, |p| !p.is_empty() && p.len() <= limits::PARENT_IDS && p.iter().all(|id| wire::is_brain_id(id))));
            }
            for r in &c.feedback {
                assert!(wire::is_brain_id(&r.id) && r.index < limits::FEEDBACK_PER_REQUEST);
                assert!(r.mean_fitness.abs() <= limits::FITNESS && (1..=1_000_000).contains(&r.count));
                clean(&r.context);
            }
            assert!(c.rejected.iter().all(|r| r.index < limits::BRAINS_PER_REQUEST));
            assert!(c.feedback_rejected.iter().all(|r| r.index < limits::FEEDBACK_PER_REQUEST));
        }
        Err(reason) => assert!(reason.status() >= 400),
    }
    if let Ok(r) = wire::parse_recall(data) {
        unit(&r.track, wire::TRACK_DIM);
        if let Some(d) = &r.dynamics {
            unit(d, wire::DYNAMICS_DIM);
        }
        clean(&r.context);
        assert!((1..=limits::RECALL_K).contains(&r.k));
    }
    if let Ok(token) = wire::parse_forget(data) {
        assert!(token.len() == 32 && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }
    if let Ok(v) = wire::parse_verify(data) {
        assert!(v.token.len() == 32 && wire::brain_problem(Some(&v.vector)).is_none());
        assert_eq!(v.id, wire::brain_id(&v.vector));
        clean(&v.context);
        assert!(v.context.collisions == "off" && v.context.seconds <= limits::VERIFY_SECONDS);
        let g = &v.geometry;
        let fine = |p: &[f64; 2]| p.iter().all(|x| x.is_finite() && x.abs() <= limits::COORDINATE && !(*x == 0.0 && x.is_sign_negative()));
        assert!(g.width == limits::CANVAS_WIDTH && g.height == limits::CANVAS_HEIGHT);
        assert!([&g.inner, &g.outer].iter().all(|l| (3..=limits::LOOP_POINTS).contains(&l.len()) && l.iter().all(fine)));
        assert!((1..=limits::GATES).contains(&g.checkpoints.len()) && g.checkpoints.iter().flatten().all(fine));
        assert!(wire::is_track_key(&wire::geometry_key(g)));
        // Two seconds on it, alone, from its start pose (when it has one).
        let pt = |p: &[f64; 2]| sim::Point { x: p[0], y: p[1] };
        let gates: Vec<sim::Segment> = g.checkpoints.iter().map(|c| [pt(&c[0]), pt(&c[1])]).collect();
        let inner: Vec<sim::Point> = g.inner.iter().map(pt).collect();
        let outer: Vec<sim::Point> = g.outer.iter().map(pt).collect();
        let track = sim::Track::new(g.width, g.height, &inner, &outer, &gates);
        if let (Some(pose), Some(brain)) = (track.start(), sim::Brain::from_flat(&v.vector)) {
            let settings = sim::Settings { max_speed: v.context.max_speed, traction: v.context.traction, profile: sim::Profile::from_id(&v.context.profile) };
            let o = sim::run_within(&track, pose, brain, settings, 120, 120 * 600, |_, _| {});
            assert!(o.frames <= 120 && o.fitness.is_finite() && o.lap_frames.len() == o.laps as usize);
            // Stopped within a frame's work of its budget.
            assert!(o.work <= 120 * 600 + 10 * (g.inner.len() + g.outer.len() + g.checkpoints.len() + 4) as u64, "{}", o.work);
            assert!(o.lap_frames.windows(2).all(|w| w[0] < w[1]) && o.crashed_at.map_or(true, |f| f == o.frames));
        }
    }
    if let Ok(c) = wire::parse_crashes(data) {
        assert!(c.token.len() == 32);
        unit(&c.track, wire::TRACK_DIM);
        assert!(c.map.len() == wire::CRASH_DIM && c.map.iter().all(|x| x.is_finite() && *x >= 0.0 && !(*x == 0.0 && x.is_sign_negative())) && wire::is_unit(&c.map));
        assert!((3..=1_000_000).contains(&c.deaths));
        assert!(c.collisions == "off" || c.collisions == "unknown" || c.collisions.split('/').all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())));
        if let Some(l) = &c.layout {
            assert!(wire::is_geometry_sig(&l.geometry) && (0.0..=1.0).contains(&l.survival) && (1..=limits::GATES).contains(&l.gates.len()));
            assert!(l.gates.iter().flatten().flatten().all(|x| x.is_finite() && x.abs() <= limits::COORDINATE));
        }
    }
    if let Ok(r) = wire::parse_crash_recall(data) {
        unit(&r.track, wire::TRACK_DIM);
        assert!(r.geometry.as_deref().map_or(true, wire::is_geometry_sig));
    }
    if let Ok(b) = wire::parse_board(&String::from_utf8_lossy(data)) {
        assert!(wire::is_track_key(&b.track));
        assert!((1.0..=100.0).contains(&b.max_speed) && (0.0..=1.0).contains(&b.traction));
    }
});
