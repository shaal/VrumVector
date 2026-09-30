//! Any bytes through the three request parsers (CB1's rules, core/src/wire.rs):
//! none panics, and whatever one accepts holds what the wire format promises.

#![no_main]

use libfuzzer_sys::fuzz_target;
use serde_json::Value;
use vectorvroom_brain_core::wire::{self, limits, Context, PROFILES};

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
});
