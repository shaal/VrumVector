//! The CB1 fixtures (tests/fixtures/cloud-brain/, made by
//! scripts/cloud-brain-fixtures.mjs), run against the Rust parsers: every
//! request fixture must give the result the browser's wire.js gives. Answer
//! fixtures are the browser's alone.

use base64::Engine as _;
use serde_json::{json, Value};
use std::path::PathBuf;
use vectorvroom_brain_core::wire::{self, Reason};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/cloud-brain")
}

fn load(kind: &str) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = std::fs::read_dir(root().join(kind))
        .expect("fixtures")
        .map(|e| {
            let path = e.unwrap().path();
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            (name, serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap())
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn body(fixture: &Value) -> Vec<u8> {
    match (fixture.get("body"), fixture.get("bodyBase64")) {
        (Some(Value::String(text)), None) => text.as_bytes().to_vec(),
        (None, Some(Value::String(b64))) => base64::engine::general_purpose::STANDARD.decode(b64).unwrap(),
        _ => panic!("a fixture has one body"),
    }
}

fn refusal(reason: Reason) -> Value {
    json!({"ok": false, "error": reason.code(), "status": reason.status()})
}

/// What a fixture's route gives, in the shape of its `expect` (as the
/// browser test's run() builds it).
fn run(route: &str, bytes: &[u8], expect: &Value) -> Option<Value> {
    let has = |k: &str| expect.get(k).is_some();
    Some(match route {
        "contribute" => match wire::parse_contribute(bytes) {
            Err(r) => refusal(r),
            Ok(c) => {
                let mut out = json!({
                    "ok": true,
                    "accepted": c.brains.iter().map(|b| b.id.clone()).collect::<Vec<_>>(),
                    "rejected": c.rejected,
                    "feedbackAccepted": c.feedback.len(),
                    "feedbackRejected": c.feedback_rejected,
                });
                let o = out.as_object_mut().unwrap();
                if has("firstMeta") {
                    o.insert("firstMeta".into(), c.brains.first().map_or(Value::Null, |b| json!(b.meta)));
                }
                if has("tracks") {
                    o.insert("tracks".into(), json!(c.brains.iter().map(|b| b.track).collect::<Vec<_>>()));
                }
                if has("fitness") {
                    o.insert("fitness".into(), json!(c.brains.iter().map(|b| b.fitness).collect::<Vec<_>>()));
                }
                if has("feedbackRows") {
                    o.insert("feedbackRows".into(), json!(c.feedback));
                }
                if has("trackPrints") {
                    o.insert("trackPrints".into(), json!(c.tracks.iter().map(|t| wire::brain_id(t)).collect::<Vec<_>>()));
                }
                if has("dynamicsPrints") {
                    let prints: Vec<Option<String>> = c.brains.iter().map(|b| b.dynamics.as_deref().map(wire::brain_id)).collect();
                    o.insert("dynamicsPrints".into(), json!(prints));
                }
                out
            }
        },
        "recall" => match wire::parse_recall(bytes) {
            Err(r) => refusal(r),
            Ok(r) => {
                let mut out = json!({"ok": true, "k": r.k, "dynamics": r.dynamics.is_some(), "context": r.context});
                let o = out.as_object_mut().unwrap();
                if has("trackPrint") {
                    o.insert("trackPrint".into(), json!(wire::brain_id(&r.track)));
                }
                if has("dynamicsPrint") {
                    o.insert("dynamicsPrint".into(), json!(r.dynamics.as_deref().map(wire::brain_id)));
                }
                out
            }
        },
        "forget" => match wire::parse_forget(bytes) {
            Err(r) => refusal(r),
            Ok(_) => json!({"ok": true}),
        },
        "verify" => match wire::parse_verify(bytes) {
            Err(r) => refusal(r),
            Ok(v) => {
                let g = &v.geometry;
                json!({"ok": true, "id": v.id, "context": v.context, "points": [g.inner.len(), g.outer.len(), g.checkpoints.len()]})
            }
        },
        // A leaderboard fixture's body is its query string.
        "leaderboard" => match wire::parse_board(std::str::from_utf8(bytes).ok()?) {
            Err(r) => refusal(r),
            Ok(b) => json!({"ok": true, "track": b.track, "maxSpeed": b.max_speed, "traction": b.traction}),
        },
        _ => return None,
    })
}

/// Deep equality where numbers compare by value, but -0 is not 0 (the
/// fixtures never hold -0, so an output that does fails).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            x == y && x.is_sign_negative() == y.is_sign_negative()
        }
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

#[test]
fn every_request_fixture_gives_its_expected_result() {
    let mut ran = 0;
    let mut failures = Vec::new();
    for kind in ["valid", "invalid"] {
        for (name, fixture) in load(kind) {
            let route = fixture["route"].as_str().unwrap();
            let expect = &fixture["expect"];
            let Some(result) = run(route, &body(&fixture), expect) else { continue };
            ran += 1;
            if !same(&result, expect) {
                failures.push(format!("{kind}/{name}:\n  got      {result}\n  expected {expect}"));
            }
        }
    }
    assert!(failures.is_empty(), "{} of {ran} fixtures differ:\n{}", failures.len(), failures.join("\n"));
    assert!(ran >= 100, "only {ran} request fixtures ran");
}

#[test]
fn contexts_and_meta_clean_as_the_tables_say() {
    let table = |name: &str| -> Vec<Value> { serde_json::from_str(&std::fs::read_to_string(root().join(name)).unwrap()).unwrap() };
    let mut failures = Vec::new();
    for row in table("contexts.json") {
        let got = json!(wire::wire_context(Some(&row["in"])));
        if !same(&got, &row["out"]) {
            failures.push(format!("context {}: got {got}, expected {}", row["in"], row["out"]));
        }
    }
    for row in table("meta.json") {
        let got = json!(wire::clean_brain_meta(Some(&row["in"])));
        if !same(&got, &row["out"]) {
            failures.push(format!("meta {}: got {got}, expected {}", row["in"], row["out"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
