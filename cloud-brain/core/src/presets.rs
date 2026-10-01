//! The game's ten track presets (trackPresets.js) as a verification sends
//! them: the service pins their track keys to their geometries (X1) and
//! trains on them (X2). presets.json is written by
//! `node scripts/cloud-brain-sim-traces.mjs --presets`, with the page's own
//! key and digest of each (core/tests/verify.rs checks them against these).

use crate::wire::{self, Geometry};
use serde_json::Value;
use std::sync::OnceLock;

pub struct Preset {
    pub name: String,
    pub geometry: Geometry,
    /// `wire::geometry_key`: the learning context's `track`.
    pub key: String,
    /// `wire::geometry_digest`.
    pub digest: String,
}

/// The presets, by name.
pub fn presets() -> &'static [Preset] {
    static PRESETS: OnceLock<Vec<Preset>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        let all: Value = serde_json::from_str(include_str!("presets.json")).expect("presets.json reads");
        let point = |p: &Value| [p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)];
        let points = |v: &Value| v.as_array().map(|a| a.iter().map(point).collect()).unwrap_or_default();
        let mut out: Vec<Preset> = all
            .as_object()
            .map(|m| {
                m.iter()
                    .map(|(name, p)| {
                        let geometry = Geometry {
                            width: p["width"].as_f64().unwrap_or(wire::limits::CANVAS_WIDTH),
                            height: p["height"].as_f64().unwrap_or(wire::limits::CANVAS_HEIGHT),
                            inner: points(&p["inner"]),
                            outer: points(&p["outer"]),
                            checkpoints: p["checkpoints"].as_array().map(|a| a.iter().map(|g| [point(&g[0]), point(&g[1])]).collect()).unwrap_or_default(),
                        };
                        Preset { name: name.clone(), key: wire::geometry_key(&geometry), digest: wire::geometry_digest(&geometry), geometry }
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    })
}

/// The preset whose track key this is.
pub fn by_key(key: &str) -> Option<&'static Preset> {
    presets().iter().find(|p| p.key == key)
}
