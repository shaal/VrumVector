//! The wire format, protocol 1: the Rust side of `AI-Car-Racer/cloud/wire.js`.
//! The same rules in the same order (docs/validation/cloud-brain.md, CB1), and
//! the same fixtures (`tests/fixtures/cloud-brain/`, run by `tests/fixtures.rs`).
//!
//! Every parser takes the body's bytes and never panics: a refusal is a
//! [`Reason`]. Types are strict: a number must be a JSON number, a string a
//! JSON string. An integer is any number with an integral value, `null` means
//! absent, and no output holds -0.

use base64::Engine as _;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const PROTOCOL: u32 = 1;
/// `BRAIN_SCHEMA_VERSION` of the browser's brainCodec.js.
pub const BRAIN_SCHEMA: u32 = 6;
pub const BRAIN_DIM: usize = 244;
pub const TRACK_DIM: usize = 512;
pub const DYNAMICS_DIM: usize = 64;

/// The limits of protocol 1 (`LIMITS` in wire.js).
pub mod limits {
    pub const REQUEST_BYTES: usize = 65_536;
    pub const RESPONSE_BYTES: usize = 262_144;
    pub const DEPTH: usize = 32;
    pub const TRACKS_PER_REQUEST: usize = 4;
    pub const BRAINS_PER_REQUEST: usize = 16;
    pub const FEEDBACK_PER_REQUEST: usize = 50;
    pub const RECALL_K: usize = 64;
    pub const RECALL_DEFAULT_K: usize = 50;
    pub const MAX_WEIGHT: f32 = 16.0;
    pub const NORM_TOLERANCE: f64 = 1e-3;
    pub const FITNESS: f64 = 1e6;
    pub const COUNT: f64 = 1e6;
    pub const GENERATION: f64 = 1e9;
    pub const PARENT_IDS: usize = 8;
    pub const TRACK_KEY: usize = 180;
    /// A verification's track (X1): the game's canvas (main.js: 3200 × 1800;
    /// its sides are walls, and the sensors' side inputs scale by its
    /// diagonal, so it is part of the track), points a wall loop, gates, the
    /// size of a coordinate; and the longest run it simulates.
    pub const CANVAS_WIDTH: f64 = 3_200.0;
    pub const CANVAS_HEIGHT: f64 = 1_800.0;
    pub const LOOP_POINTS: usize = 256;
    pub const GATES: usize = 64;
    pub const COORDINATE: f64 = 100_000.0;
    pub const VERIFY_SECONDS: f64 = 120.0;
}
use limits::*;

/// Why a body, or one item of it, is refused. Its code is the wire string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    NotJson,
    BodyTooLarge,
    Shape,
    Protocol,
    BrainSchema,
    Token,
    TooManyTracks,
    TooManyBrains,
    TooManyFeedback,
    Track,
    Dynamics,
    Context,
    K,
    BrainEncoding,
    BrainNotFinite,
    BrainWeightRange,
    BrainFitness,
    BrainTrack,
    BrainDynamics,
    BrainDuplicate,
    FeedbackId,
    FeedbackContext,
    FeedbackNumbers,
    /// A feedback row about a brain the shared brain does not hold (never
    /// contributed, or evicted). Given by the service only.
    FeedbackUnknown,
    /// A second feedback row for the same brain and context in one request
    /// (the first counts, as the browser counts one outcome per brain).
    /// Given by the service only.
    FeedbackDuplicate,
    /// A row in a new context for a brain whose 8 contexts cannot be
    /// replaced (each reported more than once in the last 7 days, or in this
    /// request). Given by the service only.
    FeedbackFull,
    /// A verification's track: its size, walls or gates are not a track
    /// (X1).
    TrackGeometry,
    /// A verification's context cannot be simulated alone: collisions on,
    /// or over 120 seconds (X1).
    VerifyContext,
    /// A verification of a brain the shared brain does not hold (X1). Given
    /// by the service only.
    BrainUnknown,
    /// A leaderboard query without a track key, or with numbers that do
    /// not read (X1).
    LeaderboardQuery,
    /// A crash map that is not 144 finite, non-negative numbers of length 1,
    /// or a count of deaths out of range (X4).
    CrashMap,
    /// A shared gate layout that does not read: its walls' signature, gates
    /// or survival (X4).
    CrashLayout,
    RateLimited,
    Disabled,
    ServerError,
}

impl Reason {
    pub fn code(self) -> &'static str {
        use Reason::*;
        match self {
            NotJson => "not-json",
            BodyTooLarge => "body-too-large",
            Shape => "shape",
            Protocol => "protocol",
            BrainSchema => "brain-schema",
            Token => "token",
            TooManyTracks => "too-many-tracks",
            TooManyBrains => "too-many-brains",
            TooManyFeedback => "too-many-feedback",
            Track => "track",
            Dynamics => "dynamics",
            Context => "context",
            K => "k-range",
            BrainEncoding => "brain-encoding",
            BrainNotFinite => "brain-not-finite",
            BrainWeightRange => "brain-weight-range",
            BrainFitness => "brain-fitness",
            BrainTrack => "brain-track",
            BrainDynamics => "brain-dynamics",
            BrainDuplicate => "brain-duplicate",
            FeedbackId => "feedback-id",
            FeedbackContext => "feedback-context",
            FeedbackNumbers => "feedback-numbers",
            FeedbackUnknown => "feedback-unknown",
            FeedbackDuplicate => "feedback-duplicate",
            FeedbackFull => "feedback-full",
            TrackGeometry => "track-geometry",
            VerifyContext => "verify-context",
            BrainUnknown => "brain-unknown",
            LeaderboardQuery => "leaderboard-query",
            CrashMap => "crash-map",
            CrashLayout => "crash-layout",
            RateLimited => "rate-limited",
            Disabled => "disabled",
            ServerError => "server-error",
        }
    }

    /// The HTTP status of an error answer with this reason.
    pub fn status(self) -> u16 {
        match self {
            Reason::BodyTooLarge => 413,
            Reason::RateLimited => 429,
            Reason::Disabled => 503,
            Reason::ServerError => 500,
            _ => 400,
        }
    }
}

impl Serialize for Reason {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.code())
    }
}

// ─── values ──────────────────────────────────────────────────────────────────

/// -0 becomes 0: no output holds -0.
pub fn plain(x: f64) -> f64 {
    x + 0.0
}
fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}
fn is_num(v: Option<&Value>, lo: f64, hi: f64) -> Option<f64> {
    num(v).filter(|x| *x >= lo && *x <= hi).map(plain)
}
fn is_int(v: Option<&Value>, lo: f64, hi: f64) -> Option<f64> {
    is_num(v, lo, hi).filter(|x| x.fract() == 0.0)
}
fn absent(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}
fn string(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}
/// `Math.max(lo, Math.min(hi, Number(n) || 0))` for a number: -0 is 0.
pub fn clamp(n: f64, lo: f64, hi: f64) -> f64 {
    let x = if n == 0.0 || n.is_nan() { 0.0 } else { n };
    plain(lo.max(hi.min(x)))
}
fn printable(s: &str) -> bool {
    s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}
fn is_token(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// A cloud brain id: `brain_` and 32 lowercase hex digits.
pub fn is_brain_id(s: &str) -> bool {
    s.len() == 38 && s.starts_with("brain_") && is_token(&s[6..])
}

// ─── vectors ─────────────────────────────────────────────────────────────────

fn le_bytes(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// Float32 values as padded base64 of their little-endian bytes.
pub fn encode_f32(values: &[f32]) -> String {
    base64::engine::general_purpose::STANDARD.encode(le_bytes(values))
}

/// Canonical padded base64 of exactly `len` little-endian Float32 values
/// (the standard alphabet, the only text that encodes these bytes), or None.
pub fn decode_f32(v: Option<&Value>, len: usize) -> Option<Vec<f32>> {
    let text = string(v)?;
    if text.len() != 4 * (len * 4).div_ceil(3) {
        return None;
    }
    // STANDARD requires canonical padding and refuses nonzero unused bits.
    let bytes = base64::engine::general_purpose::STANDARD.decode(text).ok()?;
    if bytes.len() != len * 4 {
        return None;
    }
    Some(bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

/// `prefix` and the first 128 bits (32 hex digits) of SHA-256 of the
/// vector's little-endian bytes: a brain's content id (`brain_`), or a
/// fingerprint of any vector.
pub fn fingerprint(prefix: &str, values: &[f32]) -> String {
    let digest = Sha256::digest(le_bytes(values));
    let mut out = String::with_capacity(prefix.len() + 32);
    out.push_str(prefix);
    for b in &digest[..16] {
        out.push_str(&format!("{b:02x}"));
    }
    out
}
pub fn brain_id(values: &[f32]) -> String {
    fingerprint("brain_", values)
}

/// | ‖v‖ − 1 | ≤ 1e-3, the squares summed in double precision in index order.
pub fn is_unit(values: &[f32]) -> bool {
    let sum: f64 = values.iter().map(|x| f64::from(*x) * f64::from(*x)).sum();
    (sum.sqrt() - 1.0).abs() <= NORM_TOLERANCE
}
fn unit_vector(v: Option<Vec<f32>>, dim: usize) -> Option<Vec<f32>> {
    v.filter(|v| v.len() == dim && v.iter().all(|x| x.is_finite()) && is_unit(v))
}

/// A brain's 244 weights: why they are refused, if they are.
pub fn brain_problem(v: Option<&[f32]>) -> Option<Reason> {
    let Some(v) = v.filter(|v| v.len() == BRAIN_DIM) else { return Some(Reason::BrainEncoding) };
    if !v.iter().all(|x| x.is_finite()) {
        return Some(Reason::BrainNotFinite);
    }
    if v.iter().any(|x| x.abs() > MAX_WEIGHT) {
        return Some(Reason::BrainWeightRange);
    }
    None
}

// ─── contexts and meta ───────────────────────────────────────────────────────

/// The driving profiles, `balanced` first (the default).
pub const PROFILES: [&str; 5] = ["balanced", "calm", "careful", "wild", "reckless"];

/// A learning context, cleaned as the app's `cleanContext` does.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub version: u32,
    pub profile: String,
    pub track: String,
    pub max_speed: f64,
    pub traction: f64,
    pub seconds: f64,
    pub collisions: String,
}

impl Context {
    /// One string per context: two contexts with the same key are the same
    /// conditions (the app's `contextKey`, in another spelling).
    pub fn key(&self) -> String {
        format!(
            "1|{}|{}|{}|{}|{}|{}",
            self.profile,
            self.track,
            self.max_speed.to_bits(),
            self.traction.to_bits(),
            self.seconds.to_bits(),
            self.collisions
        )
    }
}

/// A collision label, as the app's `collisionsLabel` treats a string of
/// printable ASCII: 'off', or lowercased, `solid/k<digits>` rewritten with the
/// number (capped at 65 536), and kept when it is at most 40 characters of
/// 1 to 5 `/`-joined `[a-z0-9]` segments; else 'unknown'.
pub fn collisions_label(label: &str) -> String {
    if label.is_empty() || label == "off" {
        return "off".into();
    }
    let mut text = label.to_ascii_lowercase();
    if let Some(rest) = text.strip_prefix("solid/k") {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 {
            let number = rest[..digits].trim_start_matches('0');
            let k = if number.len() > 5 { 65_536 } else { number.parse::<u32>().unwrap_or(0).min(65_536) };
            text = format!("solid/k{k}{}", &rest[digits..]);
        }
    }
    let segments: Vec<&str> = text.split('/').collect();
    let ok = text.len() <= 40
        && segments.len() <= 5
        && segments.iter().all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    if ok { text } else { "unknown".into() }
}

/// A learning context from the wire: typed fields only, then `cleanContext`'s
/// defaults and clamps. Not an object → None.
pub fn wire_context(raw: Option<&Value>) -> Option<Context> {
    let raw = raw?.as_object()?;
    let profile = string(raw.get("profile")).filter(|p| PROFILES.contains(p)).unwrap_or("balanced");
    let track = match string(raw.get("track")) {
        Some(t) if printable(t) => t[..t.len().min(TRACK_KEY)].to_string(),
        _ => String::new(),
    };
    let max_speed = match num(raw.get("maxSpeed")) {
        Some(x) if x != 0.0 => clamp(x, 1.0, 100.0),
        _ => 15.0,
    };
    let traction = num(raw.get("traction")).map_or(0.5, |x| clamp(x, 0.0, 1.0));
    let seconds = match num(raw.get("seconds")) {
        Some(x) if x != 0.0 => clamp(x, 1.0, 600.0),
        _ => 20.0,
    };
    let collisions = match string(raw.get("collisions")) {
        Some(c) if printable(c) => collisions_label(c),
        Some(_) => "unknown".into(),
        None => "off".into(),
    };
    Some(Context { version: 1, profile: profile.into(), track, max_speed, traction, seconds, collisions })
}

/// How a brain drove (the app's `cleanLearning` driving stats).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Driving {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_wall_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slide_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoothness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steering_changes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alive_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crashed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub car_contact: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_car_rate: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Learning {
    pub context: Context,
    pub style_score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driving: Option<Driving>,
}

fn wire_learning(raw: Option<&Value>) -> Option<Learning> {
    let raw = raw?.as_object()?;
    let context = wire_context(raw.get("context"))?;
    let style_score = clamp(num(raw.get("styleScore")).unwrap_or(0.0), 0.0, 1.0);
    let driving = raw.get("driving").and_then(Value::as_object).map(|d| {
        let unit = |k: &str| num(d.get(k)).map(|x| clamp(x, 0.0, 1.0));
        let big = |k: &str| num(d.get(k)).map(|x| clamp(x, 0.0, 1e9));
        let flag = |k: &str| d.get(k).and_then(Value::as_bool);
        Driving {
            average_speed: unit("averageSpeed"),
            near_wall_rate: unit("nearWallRate"),
            slide_rate: unit("slideRate"),
            smoothness: unit("smoothness"),
            steering_changes: big("steeringChanges"),
            alive_seconds: big("aliveSeconds"),
            crashed: flag("crashed"),
            car_contact: flag("carContact"),
            near_car_rate: unit("nearCarRate"),
        }
    });
    Some(Learning { context, style_score, driving })
}

pub const SOURCES: [&str; 3] = ["evolved", "demonstration", "cloud"];

/// The meta a brain may carry, cleaned: known keys, typed and bounded.
/// Unknown keys and bad values are dropped, never refused.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fastest_lap: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub learning: Option<Learning>,
}

pub fn clean_brain_meta(meta: Option<&Value>) -> Meta {
    let empty = Map::new();
    let m = meta.and_then(Value::as_object).unwrap_or(&empty);
    let parent_ids = m.get("parentIds").and_then(Value::as_array).and_then(|list| {
        let mut ids: Vec<String> = Vec::new();
        for id in list.iter().filter_map(Value::as_str).filter(|s| is_brain_id(s)) {
            if !ids.iter().any(|x| x == id) {
                ids.push(id.to_string());
            }
        }
        ids.truncate(PARENT_IDS);
        (!ids.is_empty()).then_some(ids)
    });
    Meta {
        generation: is_int(m.get("generation"), 0.0, GENERATION).map(|g| g as u64),
        parent_ids,
        fastest_lap: num(m.get("fastestLap")).filter(|x| *x > 0.0 && *x <= FITNESS),
        source: string(m.get("source")).filter(|s| SOURCES.contains(s)).map(String::from),
        learning: wire_learning(m.get("learning")),
    }
}

// ─── reading a body ──────────────────────────────────────────────────────────

/// Containers nested at most 32 deep (the body is depth 1; numbers and
/// strings add nothing). serde_json has already refused non-finite numbers
/// and lone surrogates.
fn depth_ok(v: &Value, depth: usize) -> bool {
    match v {
        Value::Array(items) => depth <= DEPTH && items.iter().all(|x| depth_ok(x, depth + 1)),
        Value::Object(map) => depth <= DEPTH && map.values().all(|x| depth_ok(x, depth + 1)),
        _ => true,
    }
}

/// Size, strict UTF-8, JSON, depth, shape, protocol, and (when asked) the
/// brain format, in that order.
pub fn read(bytes: &[u8], max_bytes: usize, schema: bool) -> Result<Map<String, Value>, Reason> {
    if bytes.len() > max_bytes {
        return Err(Reason::BodyTooLarge);
    }
    // A byte-order mark stays in the text, and JSON refuses it.
    let text = std::str::from_utf8(bytes).map_err(|_| Reason::NotJson)?;
    let body: Value = serde_json::from_str(text).map_err(|_| Reason::NotJson)?;
    if !depth_ok(&body, 1) {
        return Err(Reason::NotJson);
    }
    let Value::Object(body) = body else { return Err(Reason::Shape) };
    if num(body.get("protocol")) != Some(f64::from(PROTOCOL)) {
        return Err(Reason::Protocol);
    }
    if schema && num(body.get("brainSchema")) != Some(f64::from(BRAIN_SCHEMA)) {
        return Err(Reason::BrainSchema);
    }
    Ok(body)
}

fn list(v: Option<&Value>) -> Result<&[Value], Reason> {
    match v {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(Reason::Shape),
    }
}
fn token(body: &Map<String, Value>) -> Result<String, Reason> {
    string(body.get("token")).filter(|t| is_token(t)).map(String::from).ok_or(Reason::Token)
}

// ─── requests ────────────────────────────────────────────────────────────────

/// One brain of a contribution, checked.
#[derive(Clone, Debug)]
pub struct BrainIn {
    pub id: String,
    pub vector: Vec<f32>,
    pub fitness: f64,
    /// Index into the contribution's tracks.
    pub track: Option<usize>,
    pub dynamics: Option<Vec<f32>>,
    pub meta: Meta,
}

/// One feedback row: how the offspring of brain `id` did in `context`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackIn {
    /// Its index in the request's feedback list.
    #[serde(skip)]
    pub index: usize,
    pub id: String,
    pub context: Context,
    pub mean_fitness: f64,
    pub count: u64,
}

/// A refused item: its index in its list, and why.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Refused {
    pub index: usize,
    pub reason: Reason,
}

#[derive(Clone, Debug)]
pub struct Contribution {
    pub token: String,
    pub tracks: Vec<Vec<f32>>,
    pub brains: Vec<BrainIn>,
    pub feedback: Vec<FeedbackIn>,
    pub rejected: Vec<Refused>,
    pub feedback_rejected: Vec<Refused>,
}

/// POST /v1/contribute. In order: the body, token, the three lists (a
/// non-list is `shape`), their counts, each listed track; then each brain and
/// each feedback row alone.
pub fn parse_contribute(bytes: &[u8]) -> Result<Contribution, Reason> {
    let body = read(bytes, REQUEST_BYTES, true)?;
    let token = token(&body)?;
    let (tracks, brains, feedback) = (list(body.get("tracks")), list(body.get("brains")), list(body.get("feedback")));
    let (tracks, brains, feedback) = (tracks?, brains?, feedback?);
    if tracks.len() > TRACKS_PER_REQUEST {
        return Err(Reason::TooManyTracks);
    }
    if brains.len() > BRAINS_PER_REQUEST {
        return Err(Reason::TooManyBrains);
    }
    if feedback.len() > FEEDBACK_PER_REQUEST {
        return Err(Reason::TooManyFeedback);
    }
    let mut track_vecs = Vec::with_capacity(tracks.len());
    for t in tracks {
        track_vecs.push(unit_vector(decode_f32(Some(t), TRACK_DIM), TRACK_DIM).ok_or(Reason::Track)?);
    }
    let mut accepted: Vec<BrainIn> = Vec::new();
    let mut rejected = Vec::new();
    for (index, raw) in brains.iter().enumerate() {
        match brain_item(raw, track_vecs.len()) {
            Err(reason) => rejected.push(Refused { index, reason }),
            Ok(b) if accepted.iter().any(|a| a.id == b.id) => rejected.push(Refused { index, reason: Reason::BrainDuplicate }),
            Ok(b) => accepted.push(b),
        }
    }
    let mut rows = Vec::new();
    let mut feedback_rejected = Vec::new();
    for (index, raw) in feedback.iter().enumerate() {
        match feedback_item(raw, index) {
            Ok(row) => rows.push(row),
            Err(reason) => feedback_rejected.push(Refused { index, reason }),
        }
    }
    Ok(Contribution { token, tracks: track_vecs, brains: accepted, feedback: rows, rejected, feedback_rejected })
}

// One brain: encoding, finite, weight range, fitness, track index, dynamics.
fn brain_item(raw: &Value, track_count: usize) -> Result<BrainIn, Reason> {
    let raw = raw.as_object().ok_or(Reason::BrainEncoding)?;
    let vector = decode_f32(raw.get("vector"), BRAIN_DIM);
    if let Some(problem) = brain_problem(vector.as_deref()) {
        return Err(problem);
    }
    let vector = vector.unwrap_or_default();
    let fitness = is_num(raw.get("fitness"), -FITNESS, FITNESS).ok_or(Reason::BrainFitness)?;
    let track = match raw.get("track") {
        t if absent(t) => None,
        // Any index below the number of tracks (none when there are none).
        t => Some(is_int(t, 0.0, f64::INFINITY).filter(|i| *i < track_count as f64).ok_or(Reason::BrainTrack)? as usize),
    };
    let dynamics = match raw.get("dynamics") {
        d if absent(d) => None,
        d => Some(unit_vector(decode_f32(d, DYNAMICS_DIM), DYNAMICS_DIM).ok_or(Reason::BrainDynamics)?),
    };
    Ok(BrainIn { id: brain_id(&vector), vector, fitness, track, dynamics, meta: clean_brain_meta(raw.get("meta")) })
}

// One feedback row: id, context, numbers.
fn feedback_item(raw: &Value, index: usize) -> Result<FeedbackIn, Reason> {
    let raw = raw.as_object().ok_or(Reason::FeedbackId)?;
    let id = string(raw.get("id")).filter(|id| is_brain_id(id)).ok_or(Reason::FeedbackId)?;
    let context = wire_context(raw.get("context")).ok_or(Reason::FeedbackContext)?;
    let mean_fitness = is_num(raw.get("meanFitness"), -FITNESS, FITNESS);
    let count = is_int(raw.get("count"), 1.0, COUNT);
    match (mean_fitness, count) {
        (Some(mean_fitness), Some(count)) => Ok(FeedbackIn { index, id: id.into(), context, mean_fitness, count: count as u64 }),
        _ => Err(Reason::FeedbackNumbers),
    }
}

#[derive(Clone, Debug)]
pub struct Recall {
    pub track: Vec<f32>,
    pub dynamics: Option<Vec<f32>>,
    pub context: Context,
    pub k: usize,
}

/// POST /v1/recall. In order: the body, track, dynamics, context, k.
pub fn parse_recall(bytes: &[u8]) -> Result<Recall, Reason> {
    let body = read(bytes, REQUEST_BYTES, true)?;
    let track = unit_vector(decode_f32(body.get("track"), TRACK_DIM), TRACK_DIM).ok_or(Reason::Track)?;
    let dynamics = match body.get("dynamics") {
        d if absent(d) => None,
        d => Some(unit_vector(decode_f32(d, DYNAMICS_DIM), DYNAMICS_DIM).ok_or(Reason::Dynamics)?),
    };
    let context = wire_context(body.get("context")).ok_or(Reason::Context)?;
    let k = match body.get("k") {
        k if absent(k) => RECALL_DEFAULT_K,
        k => is_int(k, 1.0, RECALL_K as f64).ok_or(Reason::K)? as usize,
    };
    Ok(Recall { track, dynamics, context, k })
}

/// POST /v1/forget: the body (no brain format) and the token.
pub fn parse_forget(bytes: &[u8]) -> Result<String, Reason> {
    token(&read(bytes, REQUEST_BYTES, false)?)
}

// ─── verification (X1) ──────────────────────────────────────────────────────

/// A track as the page draws it: the canvas, the inner and outer wall loops,
/// the gates in order.
#[derive(Clone, Debug, PartialEq)]
pub struct Geometry {
    pub width: f64,
    pub height: f64,
    pub inner: Vec<[f64; 2]>,
    pub outer: Vec<[f64; 2]>,
    pub checkpoints: Vec<[[f64; 2]; 2]>,
}

#[derive(Clone, Debug)]
pub struct Verify {
    pub token: String,
    pub id: String,
    pub vector: Vec<f32>,
    pub geometry: Geometry,
    /// The learning context the brain is run in (profile and physics).
    pub context: Context,
}

fn coordinate(v: &Value) -> Option<[f64; 2]> {
    let pair = v.as_array().filter(|a| a.len() == 2)?;
    let (x, y) = (pair[0].as_f64()?, pair[1].as_f64()?);
    (x.abs() <= COORDINATE && y.abs() <= COORDINATE).then_some([plain(x), plain(y)])
}
fn wall_loop(v: Option<&Value>) -> Option<Vec<[f64; 2]>> {
    let items = v?.as_array().filter(|a| (3..=LOOP_POINTS).contains(&a.len()))?;
    items.iter().map(coordinate).collect()
}
fn geometry(v: Option<&Value>) -> Option<Geometry> {
    let g = v?.as_object()?;
    let side = |k: &str, size: f64| is_num(g.get(k), size, size);
    let checkpoints = g.get("checkpoints")?.as_array().filter(|a| (1..=GATES).contains(&a.len()))?;
    let checkpoints = checkpoints
        .iter()
        .map(|gate| {
            let ends = gate.as_array().filter(|a| a.len() == 2)?;
            Some([coordinate(&ends[0])?, coordinate(&ends[1])?])
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Geometry { width: side("width", CANVAS_WIDTH)?, height: side("height", CANVAS_HEIGHT)?, inner: wall_loop(g.get("inner"))?, outer: wall_loop(g.get("outer"))?, checkpoints })
}

/// POST /v1/verify (X1). In order: the body, token, the brain's vector
/// (encoding, finite, weight range), the track (the game's canvas, 3 to 256
/// points a wall loop, 1 to 64 gates, coordinates within ±100 000), the
/// context (an object; then collisions off and at most 120 seconds). The
/// service finds the start pose from the gates itself.
pub fn parse_verify(bytes: &[u8]) -> Result<Verify, Reason> {
    let body = read(bytes, REQUEST_BYTES, true)?;
    let token = token(&body)?;
    let vector = decode_f32(body.get("vector"), BRAIN_DIM);
    if let Some(problem) = brain_problem(vector.as_deref()) {
        return Err(problem);
    }
    let vector = vector.unwrap_or_default();
    let geometry = geometry(body.get("track")).ok_or(Reason::TrackGeometry)?;
    let context = wire_context(body.get("context")).ok_or(Reason::Context)?;
    if context.collisions != "off" || context.seconds > VERIFY_SECONDS {
        return Err(Reason::VerifyContext);
    }
    Ok(Verify { token, id: brain_id(&vector), vector, geometry, context })
}

/// A number as JavaScript writes it (`Number.prototype.toString`, which
/// `JSON.stringify` uses): the shortest digits that read back, the even
/// one of two equally near, an exponent below 1e-6 and from 1e21, no
/// trailing `.0`; -0 is `0` (the `ryu-js` crate: Rust's own formatting
/// breaks those ties the other way).
pub fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    ryu_js::Buffer::new().format(x).to_string()
}

/// `JSON.stringify([inner, outer, checkpoints])` as the page writes it
/// (graphics/state.js `trackKey`), points as `{x, y}` objects.
fn geometry_text(g: &Geometry) -> String {
    let point = |p: &[f64; 2]| format!("{{\"x\":{},\"y\":{}}}", js_number(p[0]), js_number(p[1]));
    let list = |ps: &[[f64; 2]]| format!("[{}]", ps.iter().map(point).collect::<Vec<_>>().join(","));
    let gates = format!("[{}]", g.checkpoints.iter().map(|gate| list(gate)).collect::<Vec<_>>().join(","));
    format!("[{},{},{}]", list(&g.inner), list(&g.outer), gates)
}

/// The SHA-256 (hex) of the text the track key hashes: what pins a key to
/// one geometry (the key is two 32-bit hashes, not a digest).
pub fn geometry_digest(g: &Geometry) -> String {
    Sha256::digest(geometry_text(g).as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The page's own track key (graphics/state.js `geometryKey`): two 32-bit
/// hashes and the length of `geometry_text`.
pub fn geometry_key(g: &Geometry) -> String {
    let text = geometry_text(g);
    let (mut a, mut b) = (2_166_136_261u32, 5381u32);
    // The text is ASCII: its UTF-16 units are its bytes.
    for c in text.bytes() {
        a = (a ^ u32::from(c)).wrapping_mul(16_777_619);
        b = b.wrapping_mul(33) ^ u32::from(c);
    }
    format!("{a:x}-{b:x}-{}", text.len())
}

/// A track key as `geometry_key` writes it.
pub fn is_track_key(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let hex = |p: &str| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    parts.len() == 3 && hex(parts[0]) && hex(parts[1]) && (1..=9).contains(&parts[2].len()) && parts[2].bytes().all(|b| b.is_ascii_digit())
}

/// GET /v1/leaderboard: a track key, and the physics (cleaned as a
/// context's: maxSpeed 15 and traction 0.5 when absent).
#[derive(Clone, Debug, PartialEq)]
pub struct Board {
    pub track: String,
    pub max_speed: f64,
    pub traction: f64,
}

/// `track=<key>&maxSpeed=<n>&traction=<n>` (in any order; other keys are
/// ignored; a key given twice keeps its last value).
pub fn parse_board(query: &str) -> Result<Board, Reason> {
    let mut map = Map::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let value = match k {
            "track" => Value::String(v.to_string()),
            "maxSpeed" | "traction" => {
                let n = v.parse::<f64>().ok().filter(|n| n.is_finite() && !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit() || b == b'.' || b == b'-' || b == b'e' || b == b'E' || b == b'+'));
                Value::from(n.ok_or(Reason::LeaderboardQuery)?)
            }
            _ => continue,
        };
        map.insert(k.to_string(), value);
    }
    let track = string(map.get("track")).filter(|t| is_track_key(t)).ok_or(Reason::LeaderboardQuery)?.to_string();
    let context = wire_context(Some(&Value::Object(map))).ok_or(Reason::LeaderboardQuery)?;
    Ok(Board { track, max_speed: context.max_speed, traction: context.traction })
}

// ─── answers ─────────────────────────────────────────────────────────────────

/// An error answer's body; its HTTP status is `reason.status()`.
pub fn error_body(reason: Reason) -> String {
    serde_json::json!({"protocol": PROTOCOL, "error": reason.code()}).to_string()
}

// ─── crash maps (X4) ────────────────────────────────────────────────────────

/// A crash map: where cars died on a track, 16 × 9 cells over the canvas
/// (crashMapCodec.js: log1p of the deaths in each cell, then length 1; car
/// contact deaths left out).
pub const CRASH_DIM: usize = 144;
/// Deaths a crash map may count (the app needs 3 to make one).
pub const CRASH_DEATHS: (f64, f64) = (3.0, 1_000_000.0);

/// A gate layout adaptive gates settled on (X4): the walls it is for
/// (adaptiveGates.js `geometrySignature`: `g` and up to 8 hex digits), its
/// gates and the share of cars that survived with them.
#[derive(Clone, Debug, PartialEq)]
pub struct CrashLayout {
    pub geometry: String,
    pub gates: Vec<[[f64; 2]; 2]>,
    pub survival: f64,
}

/// POST /v1/crashes.
#[derive(Clone, Debug)]
pub struct Crashes {
    pub token: String,
    pub track: Vec<f32>,
    pub map: Vec<f32>,
    pub deaths: u64,
    /// The collision mode the cars drove in (`collisions_label`).
    pub collisions: String,
    pub layout: Option<CrashLayout>,
}

/// POST /v1/crashes/recall.
#[derive(Clone, Debug)]
pub struct CrashRecall {
    pub track: Vec<f32>,
    pub collisions: String,
    /// The page's walls (`geometrySignature`): its shared layouts.
    pub geometry: Option<String>,
}

/// adaptiveGates.js `geometrySignature`: `g` and 1 to 8 lowercase hex digits.
pub fn is_geometry_sig(s: &str) -> bool {
    s.len() >= 2 && s.len() <= 9 && s.starts_with('g') && s[1..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn collisions_of(v: Option<&Value>) -> String {
    match v {
        v if absent(v) => "off".into(),
        Some(Value::String(label)) if printable(label) => collisions_label(label),
        _ => "unknown".into(),
    }
}

fn crash_layout(v: &Value) -> Option<CrashLayout> {
    let l = v.as_object()?;
    let geometry = string(l.get("geometry")).filter(|g| is_geometry_sig(g))?.to_string();
    let survival = is_num(l.get("survival"), 0.0, 1.0)?;
    let gates = l.get("gates")?.as_array().filter(|a| (1..=GATES).contains(&a.len()))?;
    let gates = gates
        .iter()
        .map(|gate| {
            let ends = gate.as_array().filter(|a| a.len() == 2)?;
            Some([coordinate(&ends[0])?, coordinate(&ends[1])?])
        })
        .collect::<Option<Vec<_>>>()?;
    Some(CrashLayout { geometry, gates, survival: plain(survival) })
}

/// POST /v1/crashes (X4). In order: the body (no brain format), token, the
/// track (a unit embedding), the crash map (144 finite, non-negative numbers
/// of length 1) and its deaths (3 to 1 000 000), the collision mode (a
/// label; absent is off), the layout when given.
pub fn parse_crashes(bytes: &[u8]) -> Result<Crashes, Reason> {
    let body = read(bytes, REQUEST_BYTES, false)?;
    let token = token(&body)?;
    let track = unit_vector(decode_f32(body.get("track"), TRACK_DIM), TRACK_DIM).ok_or(Reason::Track)?;
    let map = decode_f32(body.get("map"), CRASH_DIM)
        .filter(|m| m.iter().all(|x| x.is_finite() && *x >= 0.0) && is_unit(m))
        .ok_or(Reason::CrashMap)?;
    let deaths = is_int(body.get("deaths"), CRASH_DEATHS.0, CRASH_DEATHS.1).ok_or(Reason::CrashMap)? as u64;
    let collisions = collisions_of(body.get("collisions"));
    let layout = match body.get("layout") {
        l if absent(l) => None,
        Some(l) => Some(crash_layout(l).ok_or(Reason::CrashLayout)?),
        None => None,
    };
    Ok(Crashes { token, track, map: map.into_iter().map(|x| x + 0.0).collect(), deaths, collisions, layout })
}

/// POST /v1/crashes/recall (X4): the body (no brain format), the track, the
/// collision mode, the walls' signature when given.
pub fn parse_crash_recall(bytes: &[u8]) -> Result<CrashRecall, Reason> {
    let body = read(bytes, REQUEST_BYTES, false)?;
    let track = unit_vector(decode_f32(body.get("track"), TRACK_DIM), TRACK_DIM).ok_or(Reason::Track)?;
    let collisions = collisions_of(body.get("collisions"));
    let geometry = match body.get("geometry") {
        g if absent(g) => None,
        g => Some(string(g).filter(|g| is_geometry_sig(g)).ok_or(Reason::CrashLayout)?.to_string()),
    };
    Ok(CrashRecall { track, collisions, geometry })
}
