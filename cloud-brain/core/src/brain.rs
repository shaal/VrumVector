//! The shared brain: what it holds, how a contribution enters it, how a
//! recall is ranked, what is evicted when it is full, and what it trusts.
//! Storage is behind [`Store`] (SQLite in the Durable Object, [`MemStore`]
//! in tests); the indexes are ruvector-core `VectorDB`s (memory-only, a flat
//! index), rebuilt from the store by [`Brain::open`].
//!
//! Brain weights and meta stay in the store: a recall reads only the k it
//! returns. In memory: the track index (512 floats a track), the dynamics
//! index (64 a brain), and for each brain its fitness, track, owner, what
//! the context match compares (`Match`), and its feedback as fixed-size
//! records. Everything held is capped (brains, tracks, contexts a brain,
//! contributors a context), so memory stays bounded whatever the requests.
//!
//! Trust (CB4, D7): a brain's claimed fitness counts for ranking only after
//! other contributors' offspring corroborate it (`Brain::trusted_fitness`);
//! feedback is kept per contributor and combined by a trimmed mean; a
//! contributor's reports about their own brains are not evidence. Each
//! contributor has a daily quota (`Config::quota`).
//!
//! Verified runs (X1): the service drives a brain on a track a page sends;
//! in the brain's own context the run is what it is served with
//! (`Brain::served_fitness`), and its feedback there is measured against it.

use crate::presets;
use crate::wire::{self, clamp, plain, Board, Context, Contribution, Learning, Meta, Reason, Recall, Refused, Verify, BRAIN_SCHEMA, PROTOCOL};
use ruvector_core::types::{DbOptions, DistanceMetric, SearchQuery, VectorEntry};
use ruvector_core::VectorDB;
use vectorvroom_sim as sim;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

/// What one contributor sends in a UTC day: requests (contributions and
/// forgets), brains, and feedback rows (the ones that parsed).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub requests: u64,
    pub brains: u64,
    pub feedback: u64,
}

/// Sizes, ranking constants, trust and quotas.
#[derive(Clone, Debug)]
pub struct Config {
    /// Brains kept; over it, the least valuable are evicted.
    pub max_brains: usize,
    /// Tracks kept; a new track over it replaces a track no brain uses.
    pub max_tracks: usize,
    /// The best brains of each track are never evicted.
    pub keep_per_track: usize,
    /// Other contributors whose offspring feedback in a brain's own context
    /// its claimed fitness needs before it counts (D7). 0 counts claims
    /// without it (still no higher than reports, if any, show).
    pub corroborators: usize,
    /// What one contributor may send in a UTC day; a request that would go
    /// past it is refused whole (429 `rate-limited`).
    pub quota: Usage,
}

impl Default for Config {
    fn default() -> Self {
        Self { max_brains: 20_000, max_tracks: 5_000, keep_per_track: 3, corroborators: 2, quota: QUOTA }
    }
}

/// The daily quota of a contributor: enough for a tab that trains all day.
/// A browser sends at most one contribution every 10 s (8 640 in a whole
/// day), one new brain a generation at most and a row per seed it bred from.
pub const QUOTA: Usage = Usage { requests: 10_000, brains: 5_000, feedback: 50_000 };

/// Two track embeddings this close (cosine distance) are the same circuit,
/// as in the browser (ruvectorBridge.js TRACK_DEDUPE_MAX_DIST).
pub const TRACK_DEDUPE_MAX_DIST: f32 = 0.005;
/// Tracks searched for a recall, and dynamics neighbours scored (the
/// browser's _rankSeeds does the same).
const TRACK_HITS: usize = 5;
const DYNAMICS_HITS: usize = 25;
const DYNAMICS_TERM_WEIGHT: f64 = 0.3;
const FEEDBACK_TERM_WEIGHT: f64 = 0.3;
/// Offspring feedback: an exponential moving average, as the browser's
/// observeOffspring (EMA_ALPHA), per contributor.
const EMA_ALPHA: f64 = 0.3;
/// Feedback kept per brain: the contexts most recently reported (a brain is
/// bred in a few; the rest would only grow memory).
pub const MAX_CONTEXTS_PER_BRAIN: usize = 8;
/// Contributors whose values are kept per brain and context: the ones who
/// reported most recently (a ninth replaces the one who reported least
/// recently).
pub const MAX_CONTRIBUTORS: usize = 8;
const DAY_MS: u64 = 86_400_000;
const MINUTE_MS: u64 = 60_000;
/// A context not reported for this long can be replaced however often it was.
const STALE_MS: u64 = 7 * DAY_MS;
/// Contributions are counted by the minute, for the last 24 hours.
const DAY_MINUTES: u64 = 1_440;

#[derive(Debug)]
pub struct StoreError(pub String);
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
pub type Result<T> = std::result::Result<T, StoreError>;
/// A stored brain as a recall reads it: its weights and its meta (JSON).
pub type StoredBrain = (Vec<f32>, String);
/// Feedback records (brain, context key, stored slots), and where the next
/// page starts.
pub type Page = (Vec<(String, String, Vec<Slot>)>, Option<(String, String)>);

/// A request refused for its contributor's daily quota (429
/// `rate-limited`): the seconds until the quota starts over (UTC midnight).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limited {
    pub retry_after: u64,
}

// ─── rows ────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct TrackRow {
    pub id: String,
    pub vector: Vec<f32>,
    pub created: u64,
}

/// A brain as stored. Its 244 weights are stored with it (`Store::put_brain`)
/// but not loaded back: a recall reads them by id.
#[derive(Clone, Debug, PartialEq)]
pub struct BrainRow {
    pub id: String,
    pub fitness: f64,
    pub track: Option<String>,
    pub dynamics: Option<Vec<f32>>,
    /// The cleaned meta, as JSON.
    pub meta: String,
    /// Who contributed it (`contributor_id` of their token).
    pub contributor: String,
    pub created: u64,
}

/// One contributor's feedback about a brain in a context.
#[derive(Clone, Debug, PartialEq)]
pub struct Slot {
    /// `tag` of the contributor.
    pub who: u16,
    /// Their `contributor_id`, kept by the store (so forget finds exactly
    /// theirs). Empty in a row the brain writes for a slot it only knows by
    /// its tag: the store keeps the id it holds for that tag.
    pub id: String,
    /// Their weight in -1..1 (None: their only rows so far set a baseline).
    pub value: Option<f64>,
    /// The mean fitness they reported last (a baseline in another context).
    pub baseline: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FeedbackRow {
    pub brain: String,
    /// `context_key` of the context: 16 hex digits.
    pub context_key: String,
    /// The context, as JSON, written for people: not loaded back. None
    /// keeps what the store holds (forget rewrites a row without it).
    pub context: Option<String>,
    /// The combined weight when it was written (for people: memory
    /// recomputes it from the slots).
    pub weight: f64,
    /// Rows reported, by contributors other than the brain's own.
    pub count: u64,
    /// Up to MAX_CONTRIBUTORS, the most recent reporter first.
    pub slots: Vec<Slot>,
    pub updated: u64,
}

/// A verified run (X1): a brain the service ran itself on a track, in a
/// context (profile and physics, collisions off).
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedRow {
    pub brain: String,
    /// The track key (`wire::geometry_key`) of the geometry it ran on.
    pub track: String,
    pub profile: String,
    pub max_speed: f64,
    pub traction: f64,
    pub seconds: f64,
    /// Gates passed plus laps × gates, as the game scores it.
    pub fitness: f64,
    pub laps: u64,
    /// The frame its first lap ended at (60 a second).
    pub lap_frames: Option<u64>,
    pub frames: u64,
    /// Who asked (`contributor_id`; empty once they are forgotten).
    pub contributor: String,
    pub created: u64,
}

impl VerifiedRow {
    /// The learning context it ran in.
    pub fn context(&self) -> Context {
        Context {
            version: 1,
            profile: self.profile.clone(),
            track: self.track.clone(),
            max_speed: self.max_speed,
            traction: self.traction,
            seconds: self.seconds,
            collisions: "off".into(),
        }
    }
    /// Same brain, track, profile and physics.
    fn same_run(&self, other: &VerifiedRow) -> bool {
        self.brain == other.brain && self.context() == other.context()
    }
}

/// One row as the store loads it back, in this order: every track, every
/// brain, every verified run, every feedback row (by brain, the most
/// recently updated first), then the contribution counts of the last 24
/// hours' minutes.
#[derive(Clone, Debug)]
pub enum Loaded {
    Track(TrackRow),
    Brain(BrainRow),
    Verified(VerifiedRow),
    Feedback(FeedbackRow),
    /// (minute since the epoch, contributions in it)
    Minute(u64, u64),
}

/// Where the brain persists. Each write is one row; `Brain` makes them in an
/// order that leaves the store valid after any prefix (a crash between two
/// writes loses the rest of that request, never consistency).
pub trait Store {
    /// Streams every row (see `Loaded`) to `sink`, the minutes after
    /// `since_minute` only: a rebuild never holds a second copy of the store.
    fn load(&self, since_minute: u64, sink: &mut dyn FnMut(Loaded) -> Result<()>) -> Result<()>;
    fn put_track(&mut self, row: &TrackRow) -> Result<()>;
    fn delete_track(&mut self, id: &str) -> Result<()>;
    fn put_brain(&mut self, row: &BrainRow, vector: &[f32]) -> Result<()>;
    /// The brain, its feedback rows and its verified runs.
    fn delete_brain(&mut self, id: &str) -> Result<()>;
    /// Writes a feedback record. A slot with an empty id keeps the id the
    /// store holds for its tag (an error when it holds none).
    fn put_feedback(&mut self, row: &FeedbackRow) -> Result<()>;
    fn delete_feedback(&mut self, brain: &str, context_key: &str) -> Result<()>;
    /// The stored slots of one feedback record (None when it holds none).
    fn feedback_slots(&self, brain: &str, context_key: &str) -> Result<Option<Vec<Slot>>>;
    /// The feedback records with a slot of this contributor's (by their full
    /// id) among the next `limit` candidates after the record `after`, in
    /// (brain, context key) order, each with its stored slots; and where the
    /// next page starts (None after the last). One pass over the records, a
    /// page at a time.
    fn records_of(&self, contributor: &str, after: Option<&(String, String)>, limit: usize) -> Result<Page>;
    /// Counts a contribution in its minute, dropping the counts of minutes at
    /// or before `prune_minute`.
    fn count_contribution(&mut self, minute: u64, prune_minute: u64) -> Result<()>;
    /// What `contributor` has used on `day` (UTC days since the epoch).
    fn usage(&self, contributor: &str, day: u64) -> Result<Usage>;
    /// Adds `add` to what the contributor used on `day` (a row of another
    /// day starts over) and records when they were last seen. Rows not seen
    /// since `prune_before` are deleted: the table holds today's
    /// contributors.
    fn count_usage(&mut self, contributor: &str, day: u64, add: Usage, at: u64, prune_before: u64) -> Result<()>;
    /// How many contributors were seen at or after `since`.
    fn contributors_since(&self, since: u64) -> Result<usize>;
    /// The weights and meta (JSON) of these brains (None for one the store
    /// does not hold).
    fn brain_rows(&self, ids: &[&str]) -> Result<Vec<Option<StoredBrain>>>;
    /// Deletes every brain `contributor` contributed, their feedback rows and
    /// verified runs; returns their ids.
    fn delete_brains_of(&mut self, contributor: &str) -> Result<Vec<String>>;
    /// Stores a verified run, replacing the brain's earlier run with the same
    /// track, profile and physics.
    fn put_verified(&mut self, row: &VerifiedRow) -> Result<()>;
    fn delete_verified(&mut self, row: &VerifiedRow) -> Result<()>;
    /// A brain's verified runs.
    fn verified_of(&self, brain: &str) -> Result<Vec<VerifiedRow>>;
    /// The best `limit` verified runs with a lap on a track and physics, of
    /// brains the store holds: the fastest first lap first, then the highest
    /// fitness, then the earliest.
    fn board(&self, board: &Board, limit: usize) -> Result<Vec<VerifiedRow>>;
    /// Takes a contributor's id off the runs they asked for.
    fn anonymize_verified(&mut self, contributor: &str) -> Result<()>;
    /// The digest (`wire::geometry_digest`) of the geometry a track key is
    /// pinned to (X1), if it is.
    fn pinned(&self, track: &str) -> Result<Option<String>>;
    /// Pins a track key to a geometry's digest, unless it is pinned already.
    fn pin(&mut self, track: &str, digest: &str, now: u64) -> Result<()>;
    /// The last minute a contribution was counted in (X2: is anyone
    /// playing?), without building the brain.
    fn last_contribution(&self) -> Result<Option<u64>>;
}

/// A contributor's id: 128 bits of SHA-256 of their token. The token itself
/// is never stored.
pub fn contributor_id(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// 64 bits of SHA-256 of a text: how memory holds contexts.
pub fn short(text: &str) -> u64 {
    let digest = Sha256::digest(text.as_bytes());
    u64::from_be_bytes([digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7]])
}

/// 32 bits of SHA-256 of a text: a brain's owner, in memory.
pub fn short32(text: &str) -> u32 {
    let digest = Sha256::digest(text.as_bytes());
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

/// The contributor in a feedback record: the first 16 bits of their id
/// (itself SHA-256 of their token; 8 tags fit a 64-byte record with their
/// values and baselines). Two contributors to one brain and context share a
/// tag about once in 65 536 pairs; they then share one slot. Anything that
/// is not an id is hashed.
pub fn tag(contributor: &str) -> u16 {
    match contributor.get(..4).filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit())) {
        Some(hex) => u16::from_str_radix(hex, 16).unwrap_or(0),
        None => (short32(contributor) >> 16) as u16,
    }
}

/// A context as a feedback key: 64 bits of its `Context::key`.
pub fn context_hash(context: &Context) -> u64 {
    short(&context.key())
}
fn hex_key(hash: u64) -> String {
    format!("{hash:016x}")
}

/// Feedback slots as a store keeps them: `id:value:baseline` (the
/// contributor id, then two numbers or nothing), comma-separated, the most
/// recent first.
pub fn slots_text(slots: &[Slot]) -> String {
    let num = |x: Option<f64>| x.map(|x| x.to_string()).unwrap_or_default();
    slots.iter().map(|s| format!("{}:{}:{}", s.id, num(s.value), num(s.baseline))).collect::<Vec<_>>().join(",")
}

/// `slots_text` read back (each slot's tag from its id); None when any part
/// does not read.
pub fn parse_slots(text: &str) -> Option<Vec<Slot>> {
    let num = |s: &str| -> Option<Option<f64>> {
        if s.is_empty() {
            return Some(None);
        }
        s.parse::<f64>().ok().filter(|x| x.is_finite()).map(Some)
    };
    let is_id = |s: &str| s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    text.split(',')
        .map(|part| {
            let mut fields = part.split(':');
            let (id, value, baseline) = (fields.next()?, fields.next()?, fields.next()?);
            if fields.next().is_some() || !is_id(id) {
                return None;
            }
            Some(Slot { who: tag(id), id: id.to_string(), value: num(value)?, baseline: num(baseline)? })
        })
        .collect()
}

// ─── answers ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct Feedback {
    pub weight: f64,
    pub count: u64,
    pub contributors: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolEntry {
    pub id: String,
    pub vector: String,
    /// Its trusted fitness (`Brain::trusted_fitness`), not its claim; in its
    /// own context, its verified run when it has one (X1). The browser ranks
    /// its replica by this number.
    pub fitness: f64,
    pub score: f64,
    /// The cosine similarity of the query's track to the track the brain was
    /// found on (0 when it came from the every-brain fallback): the browser
    /// files a brain on its own track only when this is high (CB3).
    pub track_sim: f64,
    pub meta: Meta,
    pub feedback: Feedback,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallAnswer {
    pub protocol: u32,
    pub brain_schema: u32,
    pub pool: Vec<PoolEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributeAnswer {
    pub protocol: u32,
    pub accepted: Vec<String>,
    pub rejected: Vec<Refused>,
    pub feedback_accepted: usize,
    pub feedback_rejected: Vec<Refused>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub protocol: u32,
    pub brains: usize,
    pub tracks: usize,
    pub contributors_today: usize,
    pub contributions24h: usize,
}

/// POST /v1/verify (X1): the service's own run of the brain.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyAnswer {
    pub protocol: u32,
    pub id: String,
    /// The track key of the geometry, as the page computes it.
    pub track: String,
    /// Whether it is the context's own track key: only then does the run
    /// count for the brain's standing.
    pub matched: bool,
    pub fitness: f64,
    pub laps: u64,
    /// The frame each lap ended at (60 a second).
    pub lap_frames: Vec<u64>,
    pub crashed_at: Option<u64>,
    pub frames: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardEntry {
    pub id: String,
    pub lap_frames: u64,
    pub laps: u64,
    pub fitness: f64,
    pub profile: String,
    pub verified: u64,
}

/// GET /v1/leaderboard (X1).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardAnswer {
    pub protocol: u32,
    pub track: String,
    pub max_speed: f64,
    pub traction: f64,
    pub entries: Vec<BoardEntry>,
}

/// A verification refused by the service: past the quota, or a brain it
/// does not hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Limited(Limited),
    Reason(Reason),
}

/// Verified runs kept per brain (the most recent; the one that decides its
/// standing is always kept).
pub const VERIFIED_PER_BRAIN: usize = 4;
/// Segments a verification may examine a frame, on average (`sim::Car::work`):
/// the ten presets take at most 37 (cloud-brain/sim/tests/traces.rs); a
/// track made to be costly (every wall in every ray's way) takes 1 500 to
/// 4 200 and is stopped there, refused as `track-geometry`
/// (cloud-brain/sim/tests/cost.rs). So a verification of 120 s examines at
/// most 4.3 million segments: ~35 ms natively.
pub const VERIFY_WORK_PER_FRAME: u64 = 600;
/// Cloud training (X2): how much a session may do, and when.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Training {
    /// Frames driven a session at most (each run counts all its frames).
    pub frames: u64,
    /// A session runs only when nobody has contributed for this long.
    pub idle_minutes: u64,
}

/// What a training session did (`Brain::train`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainReport {
    /// The preset's name.
    pub track: String,
    pub context: Context,
    pub seeds: Vec<String>,
    /// Runs driven (the seeds' included), and their frames.
    pub runs: usize,
    pub frames: u64,
    /// The best seed's fitness, and the best of the session's.
    pub seed_fitness: f64,
    pub best_fitness: f64,
    /// The brain archived, when a child beat every seed.
    pub archived: Option<String>,
}

/// Brains a training session starts from, the best it breeds from (and
/// keeps), and how far a child's weights move toward random ones, in turn.
pub const TRAIN_SEEDS: usize = 4;
const TRAIN_PARENTS: usize = 4;
/// The busiest contexts sessions take turns on.
pub const TRAIN_CONTEXTS: usize = 3;
/// Brains of the service's own held at most.
pub const CLOUD_BRAINS: usize = 50;
const TRAIN_RATES: [f64; 3] = [0.05, 0.1, 0.2];

/// xorshift64*: training's random numbers, the same for a seed natively and
/// in Wasm.
struct Xorshift(u64);
impl Xorshift {
    fn new(seed: u64) -> Self {
        Xorshift(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    /// In [0, 1).
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The service's own contributor id (X2): the brains its training makes.
/// Not a token's (those are 32 hex digits), so no token can pass for it.
pub const CLOUD_CONTRIBUTOR: &str = "cloud";
/// Verifications run a minute, for everyone together: the object answers
/// one request at a time, and one takes up to ~0.1 s under wrangler dev (a
/// usual one ~18 ms), so at most ~3 s of a minute. Past it, `rate-limited`
/// until the next minute (counted in memory: a restart starts over).
pub const VERIFY_PER_MINUTE: u32 = 30;
/// Entries on a leaderboard.
pub const BOARD_SIZE: usize = 20;

/// POST /v1/forget: the brains deleted, and the feedback records the
/// contributor's values were taken out of.
#[derive(Clone, Debug, Serialize)]
pub struct ForgetAnswer {
    pub protocol: u32,
    pub brains: usize,
    pub feedback: usize,
}

// ─── context match (the browser's learning/policy.js) ───────────────────────

/// What the context match compares, from a cleaned context: small enough to
/// hold for every brain (the collision label as a hash).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Match {
    profile: u8,
    max_speed: f64,
    traction: f64,
    seconds: f64,
    collisions: u64,
    solid: bool,
}

impl Match {
    pub fn of(c: &Context) -> Match {
        Match {
            profile: wire::PROFILES.iter().position(|p| *p == c.profile).unwrap_or(0) as u8,
            max_speed: c.max_speed,
            traction: c.traction,
            seconds: c.seconds,
            collisions: short(&c.collisions),
            solid: c.collisions.starts_with("solid/"),
        }
    }
    fn off() -> (u64, bool) {
        (short("off"), false)
    }
}

/// collisionModeFactor on hashed labels.
fn mode_factor(memory: (u64, bool), query: (u64, bool)) -> f64 {
    if memory.0 == query.0 {
        1.0
    } else if memory.1 && query.1 {
        0.9
    } else {
        0.8
    }
}

/// matchContext(...).factor: how well a memory's context fits the query's.
fn factor(memory: Option<&Match>, q: &Match) -> f64 {
    match memory {
        // A memory from before contexts existed is from normal driving.
        None => (if q.profile == 0 { 0.9 } else { 0.6 }) * mode_factor(Match::off(), (q.collisions, q.solid)),
        Some(m) => {
            let profile = m.profile == q.profile;
            let physics = m.max_speed == q.max_speed && m.traction == q.traction;
            let duration = m.seconds == q.seconds;
            (if profile { 1.0 } else { 0.45 })
                * (if physics { 1.0 } else { 0.75 })
                * (if duration { 1.0 } else { 0.85 })
                * mode_factor((m.collisions, m.solid), (q.collisions, q.solid))
        }
    }
}

/// matchContext(...).factor for two cleaned contexts.
pub fn match_factor(memory: Option<&Context>, query: &Context) -> f64 {
    factor(memory.map(Match::of).as_ref(), &Match::of(query))
}

/// offspringFeedback: how much better the offspring did than the baseline,
/// in -1..1.
fn offspring_feedback(mean_fitness: f64, baseline: f64) -> f64 {
    clamp((mean_fitness - baseline) / baseline.abs().max(1.0), -1.0, 1.0)
}

fn fit_term(fitness: f64) -> f64 {
    0.5 + 0.5 * (fitness / 100.0).tanh()
}

// ─── feedback records ────────────────────────────────────────────────────────

/// A slot without a value yet.
const NO_VALUE: i16 = i16::MIN;
/// A slot without a baseline (a bfloat16 NaN; a reported mean is finite).
const NO_BASELINE: u16 = 0x7fc0;

/// A weight in -1..1 as a 16-bit integer (steps of 1/32 767).
fn quantize(v: f64) -> i16 {
    (clamp(v, -1.0, 1.0) * 32_767.0).round() as i16
}
fn dequantize(q: i16) -> f64 {
    f64::from(q) / 32_767.0
}
/// A mean fitness (within ±1e6) as bfloat16: 8 significant bits, so a
/// baseline is within 0.4 % of what was reported. Rounds to nearest even.
fn to_bf16(x: f64) -> u16 {
    let bits = (clamp(x, -wire::limits::FITNESS, wire::limits::FITNESS) as f32).to_bits();
    match (bits.wrapping_add(0x7fff + ((bits >> 16) & 1)) >> 16) as u16 {
        // A tiny negative mean rounds to -0: stored as 0, as it reads back.
        0x8000 => 0,
        h => h,
    }
}
fn from_bf16(h: u16) -> Option<f64> {
    (h != NO_BASELINE).then(|| plain(f64::from(f32::from_bits(u32::from(h) << 16))))
}

/// The mean of up to MAX_CONTRIBUTORS numbers, once there are 3 of them
/// without the lowest and highest quarter (one contributor among 3 or more
/// cannot pull it to their end); None for none. (A 2σ filter cannot drop
/// anything among 5 or fewer: none of them is 2σ from their mean.)
fn trimmed_mean(numbers: impl Iterator<Item = f64>) -> Option<f64> {
    let mut v = [0.0f64; MAX_CONTRIBUTORS];
    let mut n = 0;
    for x in numbers.take(MAX_CONTRIBUTORS) {
        v[n] = x;
        n += 1;
    }
    if n == 0 {
        return None;
    }
    let v = &mut v[..n];
    v.sort_by(f64::total_cmp);
    let trim = if n >= 3 { n.div_ceil(4) } else { 0 };
    let kept = &v[trim..n - trim];
    Some(plain(kept.iter().sum::<f64>() / kept.len() as f64))
}

/// Feedback for one brain in one context, in 64 bytes: per contributor
/// (the most recent reporter first) a tag, a weight and a baseline.
#[derive(Clone, Debug)]
struct Aggregate {
    updated: u64,
    /// Rows reported (by contributors other than the brain's own).
    count: u32,
    who: [u16; MAX_CONTRIBUTORS],
    value: [i16; MAX_CONTRIBUTORS],
    baseline: [u16; MAX_CONTRIBUTORS],
    /// Slots in use.
    counted: u8,
}

// The size the docs state (docs/validation/cloud-brain.md, CB4).
const _: () = assert!(std::mem::size_of::<Aggregate>() == 64);

impl Aggregate {
    fn new(now: u64) -> Self {
        Aggregate {
            updated: now,
            count: 0,
            who: [0; MAX_CONTRIBUTORS],
            value: [NO_VALUE; MAX_CONTRIBUTORS],
            baseline: [NO_BASELINE; MAX_CONTRIBUTORS],
            counted: 0,
        }
    }

    fn from_row(row: &FeedbackRow) -> Option<Aggregate> {
        if row.slots.is_empty() || row.slots.len() > MAX_CONTRIBUTORS {
            return None;
        }
        let mut a = Aggregate::new(row.updated);
        a.count = row.count.min(u64::from(u32::MAX)) as u32;
        for (i, s) in row.slots.iter().enumerate() {
            if a.who[..i].contains(&s.who) || s.who != tag(&s.id) {
                return None;
            }
            a.who[i] = s.who;
            a.value[i] = s.value.map_or(NO_VALUE, quantize);
            a.baseline[i] = s.baseline.map_or(NO_BASELINE, to_bf16);
        }
        a.counted = row.slots.len() as u8;
        Some(a)
    }

    /// The slots, `reporter`'s with its id (the store keeps the others').
    fn slots(&self, reporter: Option<&str>) -> Vec<Slot> {
        let known = reporter.map(|r| (tag(r), r));
        (0..self.counted as usize)
            .map(|i| Slot {
                who: self.who[i],
                id: known.filter(|k| k.0 == self.who[i]).map_or(String::new(), |k| k.1.to_string()),
                value: (self.value[i] != NO_VALUE).then(|| dequantize(self.value[i])),
                baseline: from_bf16(self.baseline[i]),
            })
            .collect()
    }

    fn values(&self) -> impl Iterator<Item = f64> + '_ {
        self.value[..self.counted as usize].iter().filter(|v| **v != NO_VALUE).map(|v| dequantize(*v))
    }

    /// Contributors with a value.
    fn valued(&self) -> usize {
        self.values().count()
    }

    /// The weight: the trimmed mean of the contributors' values. Each
    /// contributor counts once however often they report.
    fn weight(&self) -> f64 {
        trimmed_mean(self.values()).unwrap_or(0.0)
    }

    /// The weight measured against `fitness` (a verified run's, X1): the
    /// trimmed mean, over the contributors with a value, of how their last
    /// mean compares with it. So rows measured against a claim made low on
    /// purpose do not lift a brain once the service has run it.
    fn weight_against(&self, fitness: f64) -> f64 {
        let n = self.counted as usize;
        trimmed_mean((0..n).filter(|i| self.value[*i] != NO_VALUE).filter_map(|i| from_bf16(self.baseline[i])).map(|mean| offspring_feedback(mean, fitness)))
            .unwrap_or(0.0)
    }

    /// What the offspring showed: the trimmed mean of the mean fitness each
    /// contributor with a value reported last (None without one). In a
    /// brain's own context this is what its claim is held to.
    fn shown(&self) -> Option<f64> {
        let n = self.counted as usize;
        trimmed_mean((0..n).filter(|i| self.value[*i] != NO_VALUE).filter_map(|i| from_bf16(self.baseline[i])))
    }

    /// One row from contributor `who`. In the brain's own context `claim` is
    /// its fitness, the baseline every row is measured against; in another
    /// the contributor's own previous mean is (their first row only sets
    /// it). A contributor's first measured row sets their value; later ones
    /// move it by an exponential moving average. Their slot moves to the
    /// front; a new contributor with all slots taken replaces the one who
    /// reported least recently.
    fn report(&mut self, who: u16, mean: f64, claim: Option<f64>, now: u64) {
        let n = self.counted as usize;
        let found = self.who[..n].iter().position(|w| *w == who);
        let (old_value, old_baseline) = found.map_or((NO_VALUE, NO_BASELINE), |j| (self.value[j], self.baseline[j]));
        let mut value = old_value;
        if let Some(baseline) = claim.or_else(|| from_bf16(old_baseline)) {
            let f = offspring_feedback(mean, baseline);
            let v = if old_value == NO_VALUE { f } else { EMA_ALPHA * f + (1.0 - EMA_ALPHA) * dequantize(old_value) };
            value = quantize(v);
        }
        let end = found.map_or((n + 1).min(MAX_CONTRIBUTORS), |j| j + 1);
        self.who[..end].rotate_right(1);
        self.value[..end].rotate_right(1);
        self.baseline[..end].rotate_right(1);
        self.who[0] = who;
        self.value[0] = value;
        self.baseline[0] = to_bf16(mean);
        self.counted = self.counted.max(end as u8);
        self.count = self.count.saturating_add(1);
        self.updated = now;
    }

    fn has(&self, who: u16) -> bool {
        self.who[..self.counted as usize].contains(&who)
    }

    /// Takes a contributor's slot out; false when they have none.
    fn remove(&mut self, who: u16) -> bool {
        let n = self.counted as usize;
        let Some(j) = self.who[..n].iter().position(|w| *w == who) else { return false };
        self.who.copy_within(j + 1..n, j);
        self.value.copy_within(j + 1..n, j);
        self.baseline.copy_within(j + 1..n, j);
        self.who[n - 1] = 0;
        self.value[n - 1] = NO_VALUE;
        self.baseline[n - 1] = NO_BASELINE;
        self.counted -= 1;
        true
    }

    fn row(&self, brain: &str, key: u64, context: Option<String>, reporter: Option<&str>) -> FeedbackRow {
        FeedbackRow {
            brain: brain.to_string(),
            context_key: hex_key(key),
            context,
            weight: self.weight(),
            count: u64::from(self.count),
            slots: self.slots(reporter),
            updated: self.updated,
        }
    }
}

// ─── the brain ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct BrainRecord {
    fitness: f64,
    track: Option<String>,
    /// `context_hash` of its learning context when that has a track key: the
    /// context its claimed fitness was measured in, so the one where
    /// feedback tests the claim (matchContext's exact match needs a track).
    own: Option<u64>,
    /// What the context match compares (None: a brain without a context).
    matching: Option<Match>,
    /// `short32` of its contributor: their feedback about it is not evidence.
    owner: u32,
    created: u64,
    /// Its fitness as the service ran it in its own context (X1): what it
    /// is served with in that context, in place of its claim.
    verified: Option<f64>,
    /// Its learning context when that has a track key (what `own` hashes):
    /// cloud training (X2) groups brains by it.
    context: Option<Context>,
    /// Made by the service's own training (X2, `CLOUD_CONTRIBUTOR`). Its
    /// run in its own context is its verified run, served there as any
    /// verified run is; elsewhere its fitness is a claim like a player's
    /// (its seeds' track and context were the players' to choose).
    cloud: bool,
}

impl BrainRecord {
    fn new(fitness: f64, track: Option<String>, meta: &Meta, contributor: &str, created: u64) -> Self {
        let context = meta.learning.as_ref().map(|l| &l.context);
        let own_context = context.filter(|c| !c.track.is_empty());
        BrainRecord {
            fitness,
            track,
            own: own_context.map(context_hash),
            matching: context.map(Match::of),
            owner: short32(contributor),
            created,
            verified: None,
            context: own_context.cloned(),
            cloud: contributor == CLOUD_CONTRIBUTOR,
        }
    }
}

#[derive(Clone, Debug)]
struct TrackRecord {
    created: u64,
    brains: BTreeSet<String>,
}

fn index(dimensions: usize) -> VectorDB {
    let options = DbOptions { dimensions, distance_metric: DistanceMetric::Cosine, hnsw_config: None, ..DbOptions::default() };
    // A memory-only flat index cannot fail to open.
    VectorDB::new(options).expect("memory-only VectorDB")
}

fn db_error(e: impl std::fmt::Display) -> StoreError {
    StoreError(format!("index: {e}"))
}

/// The k nearest ids by cosine distance, ties broken by id. The flat index
/// orders equal distances as its hash map iterates, which changes with every
/// rebuild: it is asked for more, and when the k-th distance ties the last
/// one it returned (so equal ones may be missing), for all of them.
fn nearest(db: &VectorDB, vector: &[f32], k: usize) -> Result<Vec<(String, f32)>> {
    let n = db.len().map_err(db_error)?;
    if k == 0 || n == 0 {
        return Ok(Vec::new());
    }
    let mut wide = n.min(k * 2 + 16);
    loop {
        let hits = db.search(SearchQuery { vector: vector.to_vec(), k: wide, filter: None, ef_search: None }).map_err(db_error)?;
        let mut hits: Vec<(String, f32)> = hits.into_iter().map(|h| (h.id, h.score)).collect();
        hits.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        let cut_tie = hits.len() == wide && wide < n && k <= hits.len() && hits[k - 1].1 == hits[wide - 1].1;
        if cut_tie {
            wide = n;
            continue;
        }
        hits.truncate(k);
        return Ok(hits);
    }
}

pub struct Brain {
    config: Config,
    brains: HashMap<String, BrainRecord>,
    tracks: HashMap<String, TrackRecord>,
    track_db: VectorDB,
    dynamics_db: VectorDB,
    /// brain id → context hash → feedback.
    feedback: HashMap<String, HashMap<u64, Aggregate>>,
    /// (minute, contributions) for the last 24 hours: at most 1 440 entries,
    /// however many requests arrive.
    minutes: VecDeque<(u64, u64)>,
    /// (minute, verifications run in it), for everyone (X1).
    verify_minute: (u64, u32),
}

impl Brain {
    /// Rebuilds the brain from its store. Rows that no longer clean (a
    /// corrupted meta, a vector of the wrong size, feedback about a brain not
    /// held, over the context cap or whose slots do not read) are deleted
    /// from the store, so what is served live and after a rebuild is the same.
    pub fn open(config: Config, store: &mut dyn Store, now: u64) -> Result<Brain> {
        let mut brain = Brain {
            config,
            brains: HashMap::new(),
            tracks: HashMap::new(),
            track_db: index(wire::TRACK_DIM),
            dynamics_db: index(wire::DYNAMICS_DIM),
            feedback: HashMap::new(),
            minutes: VecDeque::new(),
            verify_minute: (0, 0),
        };
        let this_minute = now / MINUTE_MS;
        let (mut bad_tracks, mut bad_brains, mut bad_feedback) = (Vec::new(), Vec::new(), Vec::new());
        let mut minutes: Vec<(u64, u64)> = Vec::new();
        store.load(this_minute.saturating_sub(DAY_MINUTES), &mut |row| {
            match row {
                Loaded::Track(t) => {
                    if t.vector.len() != wire::TRACK_DIM || brain.tracks.contains_key(&t.id) {
                        bad_tracks.push(t.id);
                        return Ok(());
                    }
                    brain.track_db.insert(VectorEntry { id: Some(t.id.clone()), vector: t.vector, metadata: None }).map_err(db_error)?;
                    brain.tracks.insert(t.id, TrackRecord { created: t.created, brains: BTreeSet::new() });
                }
                Loaded::Brain(b) => {
                    let meta = serde_json::from_str::<serde_json::Value>(&b.meta).ok();
                    let (Some(meta), false) = (meta, brain.brains.contains_key(&b.id)) else {
                        bad_brains.push(b.id);
                        return Ok(());
                    };
                    let track = b.track.filter(|t| brain.tracks.contains_key(t));
                    if let Some(record) = track.as_ref().and_then(|t| brain.tracks.get_mut(t)) {
                        record.brains.insert(b.id.clone());
                    }
                    if let Some(d) = b.dynamics.filter(|d| d.len() == wire::DYNAMICS_DIM) {
                        brain.dynamics_db.insert(VectorEntry { id: Some(b.id.clone()), vector: d, metadata: None }).map_err(db_error)?;
                    }
                    let record = BrainRecord::new(plain(b.fitness), track, &wire::clean_brain_meta(Some(&meta)), &b.contributor, b.created);
                    brain.brains.insert(b.id, record);
                }
                Loaded::Verified(v) => {
                    // The run that decides a brain's standing: in its own context.
                    let own = context_hash(&v.context());
                    if let Some(b) = brain.brains.get_mut(&v.brain).filter(|b| b.own == Some(own)) {
                        b.verified = Some(plain(v.fitness));
                    }
                }
                Loaded::Feedback(f) => {
                    let key = u64::from_str_radix(&f.context_key, 16).ok();
                    let contexts = brain.feedback.get(&f.brain).map_or(0, HashMap::len);
                    // The most recent rows come first: past the cap (a store
                    // an older build wrote) the rest are deleted.
                    let aggregate = Aggregate::from_row(&f);
                    let (Some(key), Some(aggregate), true, true) = (key, aggregate, brain.brains.contains_key(&f.brain), contexts < MAX_CONTEXTS_PER_BRAIN) else {
                        bad_feedback.push((f.brain, f.context_key));
                        return Ok(());
                    };
                    brain.feedback.entry(f.brain).or_default().insert(key, aggregate);
                }
                Loaded::Minute(minute, count) => {
                    if minute + DAY_MINUTES > this_minute {
                        minutes.push((minute, count));
                    }
                }
            }
            Ok(())
        })?;
        for id in bad_tracks {
            if !brain.tracks.contains_key(&id) {
                store.delete_track(&id)?;
            }
        }
        for id in bad_brains {
            if !brain.brains.contains_key(&id) {
                store.delete_brain(&id)?;
            }
        }
        for (id, key) in bad_feedback {
            store.delete_feedback(&id, &key)?;
        }
        minutes.sort_unstable();
        brain.minutes = minutes.into();
        // The presets' keys are their geometries' (X1), before anyone asks.
        for p in presets::presets() {
            if store.pinned(&p.key)?.is_none() {
                store.pin(&p.key, &p.digest, now)?;
            }
        }
        Ok(brain)
    }

    pub fn len(&self) -> usize {
        self.brains.len()
    }
    pub fn is_empty(&self) -> bool {
        self.brains.is_empty()
    }
    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }
    pub fn contains(&self, id: &str) -> bool {
        self.brains.contains_key(id)
    }
    /// Minutes with contributions held in memory (at most 1 440).
    pub fn minutes_held(&self) -> usize {
        self.minutes.len()
    }
    pub fn track_of(&self, id: &str) -> Option<&str> {
        self.brains.get(id).and_then(|b| b.track.as_deref())
    }

    /// Counts a request against the contributor's daily quota, or refuses
    /// it (nothing is written then) when it would go past any part of it.
    fn admit(&self, contributor: &str, add: Usage, now: u64, store: &mut dyn Store) -> Result<Option<Limited>> {
        let (day, midnight) = (now / DAY_MS, now - now % DAY_MS);
        let used = store.usage(contributor, day)?;
        let q = &self.config.quota;
        let over = |used: u64, add: u64, cap: u64| used.saturating_add(add) > cap;
        if over(used.requests, add.requests, q.requests) || over(used.brains, add.brains, q.brains) || over(used.feedback, add.feedback, q.feedback) {
            return Ok(Some(Limited { retry_after: (DAY_MS - now % DAY_MS).div_ceil(1000) }));
        }
        store.count_usage(contributor, day, add, now, midnight)?;
        Ok(None)
    }

    /// POST /v1/contribute: store what is new, apply the feedback, evict what
    /// no longer fits. Brains already held are accepted again (idempotent).
    /// Refused whole (`Limited`) past the contributor's daily quota.
    pub fn contribute(&mut self, c: Contribution, contributor: &str, now: u64, store: &mut dyn Store) -> Result<std::result::Result<ContributeAnswer, Limited>> {
        let add = Usage { requests: 1, brains: c.brains.len() as u64, feedback: c.feedback.len() as u64 };
        if let Some(limited) = self.admit(contributor, add, now, store)? {
            return Ok(Err(limited));
        }
        let minute = now / MINUTE_MS;
        store.count_contribution(minute, minute.saturating_sub(DAY_MINUTES))?;
        match self.minutes.back_mut() {
            Some(last) if last.0 == minute => last.1 += 1,
            _ => self.minutes.push_back((minute, 1)),
        }
        while self.minutes.front().is_some_and(|m| m.0 + DAY_MINUTES <= minute) {
            self.minutes.pop_front();
        }

        let mut track_ids: Vec<Option<String>> = Vec::with_capacity(c.tracks.len());
        for vector in c.tracks {
            let id = self.add_track(vector, &track_ids, now, store)?;
            track_ids.push(id);
        }

        let mut accepted = Vec::with_capacity(c.brains.len());
        let mut fresh = Vec::new();
        for b in c.brains {
            accepted.push(b.id.clone());
            if self.brains.contains_key(&b.id) {
                continue;
            }
            let track = b.track.and_then(|i| track_ids.get(i).cloned().flatten()).filter(|t| self.tracks.contains_key(t));
            let row = BrainRow {
                id: b.id.clone(),
                fitness: b.fitness,
                track: track.clone(),
                dynamics: b.dynamics.clone(),
                meta: serde_json::to_string(&b.meta).map_err(|e| StoreError(e.to_string()))?,
                contributor: contributor.to_string(),
                created: now,
            };
            store.put_brain(&row, &b.vector)?;
            if let Some(d) = b.dynamics {
                self.dynamics_db.insert(VectorEntry { id: Some(b.id.clone()), vector: d, metadata: None }).map_err(db_error)?;
            }
            if let Some(t) = &track {
                if let Some(record) = self.tracks.get_mut(t) {
                    record.brains.insert(b.id.clone());
                }
            }
            self.brains.insert(b.id.clone(), BrainRecord::new(b.fitness, track, &b.meta, contributor, now));
            fresh.push(b.id);
        }
        self.evict(&fresh, store)?;

        let mut feedback_rejected = c.feedback_rejected;
        let mut feedback_accepted = 0;
        let mut seen: HashSet<(String, u64)> = HashSet::new();
        for row in c.feedback {
            let pair = (row.id.clone(), context_hash(&row.context));
            let refused = if seen.contains(&pair) {
                Some(Reason::FeedbackDuplicate)
            } else {
                self.apply_feedback(&row, contributor, now, &seen, store)?.err()
            };
            match refused {
                None => {
                    seen.insert(pair);
                    feedback_accepted += 1;
                }
                Some(reason) => feedback_rejected.push(Refused { index: row.index, reason }),
            }
        }
        feedback_rejected.sort_by_key(|r| r.index);
        Ok(Ok(ContributeAnswer { protocol: PROTOCOL, accepted, rejected: c.rejected, feedback_accepted, feedback_rejected }))
    }

    /// The id of this track: an existing one within TRACK_DEDUPE_MAX_DIST, or a
    /// new one. None when the tracks are full and every one has brains or is
    /// one of this request's (`listed`): its brains are then kept without a
    /// track.
    fn add_track(&mut self, vector: Vec<f32>, listed: &[Option<String>], now: u64, store: &mut dyn Store) -> Result<Option<String>> {
        if let Some((id, _)) = nearest(&self.track_db, &vector, 1)?.into_iter().find(|h| h.1 <= TRACK_DEDUPE_MAX_DIST) {
            return Ok(Some(id));
        }
        if self.tracks.len() >= self.config.max_tracks {
            // The oldest track no brain uses makes room, never one this
            // request has listed (its brains are attached after the tracks).
            let unused = self
                .tracks
                .iter()
                .filter(|(id, t)| t.brains.is_empty() && !listed.iter().any(|l| l.as_deref() == Some(id.as_str())))
                .min_by(|a, b| (a.1.created, a.0).cmp(&(b.1.created, b.0)));
            let Some(id) = unused.map(|(id, _)| id.clone()) else { return Ok(None) };
            store.delete_track(&id)?;
            self.track_db.delete(&id).map_err(db_error)?;
            self.tracks.remove(&id);
        }
        let row = TrackRow { id: wire::fingerprint("track_", &vector), vector, created: now };
        store.put_track(&row)?;
        self.track_db.insert(VectorEntry { id: Some(row.id.clone()), vector: row.vector, metadata: None }).map_err(db_error)?;
        self.tracks.insert(row.id.clone(), TrackRecord { created: now, brains: BTreeSet::new() });
        Ok(Some(row.id))
    }

    /// Whether the brain's claim is backed: `corroborators` other
    /// contributors reported its offspring in its own context (where each
    /// row is measured against its claim). A verified run (X1) does not
    /// corroborate: its contributor chooses the track it ran on, and a track
    /// anyone can make up protects nothing.
    fn corroborated(&self, id: &str, b: &BrainRecord) -> bool {
        b.own.and_then(|k| self.aggregate(id, &k)).map_or(0, Aggregate::valued) >= self.config.corroborators
    }

    /// The fitness a brain is served and ranked with in a recall whose
    /// context hashes to `query`: in its own context, the service's run of
    /// it when there is one (X1: the claim and its quarantine no longer
    /// count there); anywhere else, its trusted fitness.
    fn served_fitness(&self, id: &str, b: &BrainRecord, query: u64) -> f64 {
        match b.verified {
            Some(verified) if b.own == Some(query) => verified,
            _ => self.trusted_fitness(id, b),
        }
    }

    /// The feedback weight of a brain in a context: against its verified
    /// fitness in its own context once it has one (X1), else as reported.
    fn weight_in(&self, id: &str, b: &BrainRecord, key: u64) -> f64 {
        self.aggregate(id, &key).map_or(0.0, |a| match b.verified {
            Some(verified) if b.own == Some(key) => a.weight_against(verified),
            _ => a.weight(),
        })
    }

    /// The fitness a brain is ranked, valued and served with (D7). A claim
    /// counts only once the brain is corroborated, and then no higher than
    /// its offspring showed (`Aggregate::shown`: a claim of 1e6 whose
    /// offspring score 50 is worth 50). Before that, a claim can only lower a
    /// brain: it ranks as fitness 0 (a neutral fitness term) at most.
    /// Reports never take its fitness below that either: a few contributors
    /// can bring a brain back to a neutral fitness, not past it. (Its
    /// feedback weight still ranks it, down to 0.7 times, as any brain whose
    /// offspring did badly: below a brain nobody reported.)
    fn trusted_fitness(&self, id: &str, b: &BrainRecord) -> f64 {
        let floor = plain(b.fitness.min(0.0));
        if !self.corroborated(id, b) {
            return floor;
        }
        match b.own.and_then(|k| self.aggregate(id, &k)).and_then(Aggregate::shown) {
            Some(shown) => b.fitness.min(shown).max(floor),
            // No reports at all (corroborators 0: claims are trusted), or a
            // record from a store without means.
            None if self.config.corroborators == 0 => b.fitness,
            None => floor,
        }
    }

    /// How much a brain is worth keeping: its trusted fitness (or its run on
    /// a preset, verified in its own context), adjusted by
    /// how its offspring did (the mean of its feedback weights, each context
    /// weighed by its contributors with a value: one contributor's many rows
    /// count once).
    fn value(&self, id: &str, b: &BrainRecord) -> f64 {
        let (mut sum, mut count) = (0.0, 0.0);
        for (key, a) in self.feedback.get(id).into_iter().flat_map(|m| m.iter()) {
            let n = a.valued() as f64;
            sum += self.weight_in(id, b, *key) * n;
            count += n;
        }
        let weight = if count > 0.0 { sum / count } else { 0.0 };
        // A run the service drove on a preset, in the brain's own context,
        // is what it is worth (a preset is no one's to make up: X1 pins its
        // geometry); any other fitness is its trusted fitness.
        let fitness = match (b.verified, &b.context) {
            (Some(run), Some(c)) if presets::by_key(&c.track).is_some() => run,
            _ => self.trusted_fitness(id, b),
        };
        fit_term(fitness) * (1.0 + FEEDBACK_TERM_WEIGHT * weight)
    }

    /// Takes a brain out of memory (the store is written by the caller).
    fn unlink(&mut self, id: &str) -> Result<()> {
        let Some(record) = self.brains.remove(id) else { return Ok(()) };
        if let Some(t) = record.track.and_then(|t| self.tracks.get_mut(&t)) {
            t.brains.remove(id);
        }
        self.dynamics_db.delete(id).map_err(db_error)?;
        self.feedback.remove(id);
        Ok(())
    }

    /// Over the cap, the least valuable brains go (the oldest first among
    /// equals). Never the brains just contributed, nor each track's best
    /// corroborated brains (an uncorroborated brain holds no place: anyone
    /// can make a track of their own).
    fn evict(&mut self, fresh: &[String], store: &mut dyn Store) -> Result<()> {
        let over = self.brains.len().saturating_sub(self.config.max_brains);
        if over == 0 {
            return Ok(());
        }
        let doomed: Vec<String> = {
            let values: HashMap<&str, f64> = self.brains.iter().map(|(id, b)| (id.as_str(), self.value(id, b))).collect();
            let mut kept: BTreeSet<&str> = fresh.iter().map(String::as_str).collect();
            for track in self.tracks.values() {
                let mut best: Vec<(&str, f64)> = track
                    .brains
                    .iter()
                    .filter(|id| self.brains.get(id.as_str()).is_some_and(|b| self.corroborated(id, b)))
                    .filter_map(|id| values.get(id.as_str()).map(|v| (id.as_str(), *v)))
                    .collect();
                best.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(b.0)));
                kept.extend(best.into_iter().take(self.config.keep_per_track).map(|b| b.0));
            }
            let mut candidates: Vec<(&str, f64, u64)> = self
                .brains
                .iter()
                .filter(|(id, _)| !kept.contains(id.as_str()))
                .map(|(id, b)| (id.as_str(), values[id.as_str()], b.created))
                .collect();
            candidates.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.2.cmp(&b.2)).then(a.0.cmp(b.0)));
            candidates.into_iter().take(over).map(|c| c.0.to_string()).collect()
        };
        for id in doomed {
            store.delete_brain(&id)?;
            self.unlink(&id)?;
        }
        Ok(())
    }

    /// One feedback row. Rows about a brain from its own contributor are
    /// accepted and change nothing: a claim is not evidence for itself. Any
    /// other contributor's row updates their slot (`Aggregate::report`).
    fn apply_feedback(
        &mut self,
        row: &wire::FeedbackIn,
        contributor: &str,
        now: u64,
        this_request: &HashSet<(String, u64)>,
        store: &mut dyn Store,
    ) -> Result<std::result::Result<(), Reason>> {
        let Some(brain) = self.brains.get(&row.id) else { return Ok(Err(Reason::FeedbackUnknown)) };
        if brain.owner == short32(contributor) {
            return Ok(Ok(()));
        }
        let key = context_hash(&row.context);
        // In its own context rows are measured against its claim, or its
        // verified fitness once the service has run it (X1).
        let claim = (brain.own == Some(key)).then_some(brain.verified.unwrap_or(brain.fitness));
        let own = brain.own;
        let contexts = self.feedback.entry(row.id.clone()).or_default();
        // A new context over the cap replaces the weakest one (fewest
        // contributors with a value, then fewest rows, then the oldest) among
        // those one contributor at most measured, or none for 7 days (rows
        // that only set a baseline hold no place); never the brain's
        // own context (where its claim is tested), nor one this request
        // reported. So new contexts, however many, cannot push out ones that
        // several contributors built up; and the brain's own context is
        // always taken, in place of the weakest other. With none to
        // replace, the row is refused.
        if !contexts.contains_key(&key) && contexts.len() >= MAX_CONTEXTS_PER_BRAIN {
            let weakest = contexts
                .iter()
                .filter(|(k, _)| Some(**k) != own && !this_request.contains(&(row.id.clone(), **k)))
                .filter(|(_, a)| claim.is_some() || a.valued() <= 1 || a.updated + STALE_MS <= now)
                .min_by(|a, b| (a.1.valued(), a.1.count, a.1.updated, a.0).cmp(&(b.1.valued(), b.1.count, b.1.updated, b.0)))
                .map(|(k, _)| *k);
            let Some(weakest) = weakest else { return Ok(Err(Reason::FeedbackFull)) };
            store.delete_feedback(&row.id, &hex_key(weakest))?;
            contexts.remove(&weakest);
        }
        let aggregate = contexts.entry(key).or_insert_with(|| Aggregate::new(now));
        aggregate.report(tag(contributor), row.mean_fitness, claim, now);
        let context = serde_json::to_string(&row.context).map_err(|e| StoreError(e.to_string()))?;
        store.put_feedback(&aggregate.row(&row.id, key, Some(context), Some(contributor)))?;
        Ok(Ok(()))
    }

    /// POST /v1/forget: deletes every brain the contributor contributed, and
    /// takes their slot out of every feedback record the store holds with
    /// their id (a record left with no slot goes). Not limited by the daily
    /// quota: forgetting must work on a busy day (the per-address limit
    /// still counts it), and it writes no usage.
    pub fn forget(&mut self, contributor: &str, store: &mut dyn Store) -> Result<ForgetAnswer> {
        let mut gone = store.delete_brains_of(contributor)?;
        for id in &gone {
            self.unlink(id)?;
        }
        // The service's brains bred from theirs (X2) go too, and those bred
        // from those: a child keeps most of its parent's weights.
        let mut parents: HashSet<String> = gone.iter().cloned().collect();
        while !parents.is_empty() {
            let cloud: Vec<String> = self.brains.iter().filter(|(_, b)| b.cloud).map(|(id, _)| id.clone()).collect();
            let rows = store.brain_rows(&cloud.iter().map(String::as_str).collect::<Vec<_>>())?;
            let bred: Vec<String> = cloud
                .into_iter()
                .zip(rows)
                .filter_map(|(id, row)| {
                    let meta = serde_json::from_str::<serde_json::Value>(&row?.1).ok()?;
                    wire::clean_brain_meta(Some(&meta)).parent_ids?.iter().any(|p| parents.contains(p)).then_some(id)
                })
                .collect();
            for id in &bred {
                store.delete_brain(id)?;
                self.unlink(id)?;
            }
            parents = bred.iter().cloned().collect();
            gone.extend(bred);
        }
        // Runs they asked the service for stay (they are the service's own),
        // without their id.
        store.anonymize_verified(contributor)?;
        // The records with a slot of the contributor's tag are in memory. A
        // few (a token that reported little, or nothing: a tag's share of the
        // records) are each read by key; more (a heavy contributor, or a
        // token made to share a heavy one's tag) are found in one pass over
        // the stored records, a page at a time, so what a forget reads never
        // grows past the records' count and no list of them is built.
        const FEW: usize = 256;
        const PAGE: usize = 500;
        let who = tag(contributor);
        let candidates = self.feedback.values().flat_map(HashMap::values).filter(|a| a.has(who)).count();
        let mut changed = 0;
        if candidates <= FEW {
            let keys: Vec<(String, u64)> =
                self.feedback.iter().flat_map(|(brain, contexts)| contexts.iter().filter(|(_, a)| a.has(who)).map(move |(key, _)| (brain.clone(), *key))).collect();
            for (brain, key) in keys {
                if let Some(held) = store.feedback_slots(&brain, &hex_key(key))? {
                    changed += self.forget_in(&brain, key, contributor, &held, store)?;
                }
            }
        } else {
            let mut after: Option<(String, String)> = None;
            loop {
                let (records, next) = store.records_of(contributor, after.as_ref(), PAGE)?;
                for (brain, context_key, held) in &records {
                    if let Ok(key) = u64::from_str_radix(context_key, 16) {
                        changed += self.forget_in(brain, key, contributor, held, store)?;
                    }
                }
                if next.is_none() {
                    break;
                }
                after = next;
            }
        }
        Ok(ForgetAnswer { protocol: PROTOCOL, brains: gone.len(), feedback: changed })
    }

    /// POST /v1/verify (X1): runs a brain the service holds on the page's
    /// track, alone, in the given context (as the page's trial worker runs
    /// it: sensors every frame, main.js's start pose), and keeps the result.
    /// In the brain's own context the run is its fitness from then on.
    pub fn verify(&mut self, v: Verify, contributor: &str, now: u64, store: &mut dyn Store) -> Result<std::result::Result<VerifyAnswer, Refusal>> {
        if !self.brains.contains_key(&v.id) {
            return Ok(Err(Refusal::Reason(Reason::BrainUnknown)));
        }
        let g = &v.geometry;
        let pt = |p: &[f64; 2]| sim::Point { x: p[0], y: p[1] };
        let gates: Vec<sim::Segment> = g.checkpoints.iter().map(|c| [pt(&c[0]), pt(&c[1])]).collect();
        let track = sim::Track::new(g.width, g.height, &g.inner.iter().map(pt).collect::<Vec<_>>(), &g.outer.iter().map(pt).collect::<Vec<_>>(), &gates);
        // The start pose as main.js finds it (with musl's atan2, which can be
        // an ulp from V8's: on the ten presets, every traced run drives the
        // same from either, sim/tests/traces.rs).
        let Some(pose) = track.start() else { return Ok(Err(Refusal::Reason(Reason::TrackGeometry))) };
        let Some(brain) = sim::Brain::from_flat(&v.vector) else { return Ok(Err(Refusal::Reason(Reason::BrainEncoding))) };
        // A key is two 32-bit hashes: the first geometry run under it (or a
        // preset's) is the only one ever run under it, so a second geometry
        // made to share a track's key never counts in that track's contexts.
        let (key, digest) = (wire::geometry_key(g), wire::geometry_digest(g));
        let pinned = store.pinned(&key)?;
        if pinned.as_ref().is_some_and(|d| *d != digest) {
            return Ok(Err(Refusal::Reason(Reason::TrackGeometry)));
        }
        let minute = now / MINUTE_MS;
        let ran = if self.verify_minute.0 == minute { self.verify_minute.1 } else { 0 };
        if ran >= VERIFY_PER_MINUTE {
            return Ok(Err(Refusal::Limited(Limited { retry_after: (MINUTE_MS - now % MINUTE_MS).div_ceil(1000) })));
        }
        if let Some(limited) = self.admit(contributor, Usage { requests: 1, brains: 1, feedback: 0 }, now, store)? {
            return Ok(Err(Refusal::Limited(limited)));
        }
        self.verify_minute = (minute, ran + 1);
        let settings = sim::Settings { max_speed: v.context.max_speed, traction: v.context.traction, profile: sim::Profile::from_id(&v.context.profile) };
        let frames = (v.context.seconds * 60.0).floor() as u64;
        let outcome = sim::run_within(&track, pose, brain, settings, frames, frames * VERIFY_WORK_PER_FRAME, |_, _| {});
        if outcome.over_budget {
            return Ok(Err(Refusal::Reason(Reason::TrackGeometry)));
        }
        if pinned.is_none() {
            store.pin(&key, &digest, now)?;
        }
        let row = VerifiedRow {
            brain: v.id.clone(),
            track: key.clone(),
            profile: v.context.profile.clone(),
            max_speed: v.context.max_speed,
            traction: v.context.traction,
            seconds: v.context.seconds,
            fitness: outcome.fitness,
            laps: u64::from(outcome.laps),
            lap_frames: outcome.lap_frames.first().copied(),
            frames: outcome.frames,
            contributor: contributor.to_string(),
            created: now,
        };
        self.keep_run(&row, store)?;
        Ok(Ok(VerifyAnswer {
            protocol: PROTOCOL,
            id: v.id,
            matched: key == v.context.track,
            track: key,
            fitness: plain(outcome.fitness),
            laps: u64::from(outcome.laps),
            lap_frames: outcome.lap_frames,
            crashed_at: outcome.crashed_at,
            frames: outcome.frames,
        }))
    }

    /// Keeps a run the service drove (a verification's, or training's): at
    /// most VERIFIED_PER_BRAIN a brain, the oldest going first but never the
    /// one in its own context; in its own context it is its standing.
    fn keep_run(&mut self, row: &VerifiedRow, store: &mut dyn Store) -> Result<()> {
        store.put_verified(row)?;
        let own = self.brains.get(&row.brain).and_then(|b| b.own);
        let mut runs = store.verified_of(&row.brain)?;
        if runs.len() > VERIFIED_PER_BRAIN {
            runs.sort_by(|a, b| (a.created, &a.track, &a.profile).cmp(&(b.created, &b.track, &b.profile)));
            let mut over = runs.len() - VERIFIED_PER_BRAIN;
            for old in &runs {
                if over == 0 {
                    break;
                }
                if own == Some(context_hash(&old.context())) || old.same_run(row) {
                    continue;
                }
                store.delete_verified(old)?;
                over -= 1;
            }
        }
        if own == Some(context_hash(&row.context())) {
            if let Some(b) = self.brains.get_mut(&row.brain) {
                b.verified = Some(plain(row.fitness));
            }
        }
        Ok(())
    }

    /// GET /v1/leaderboard (X1): the fastest verified first laps on a track
    /// and physics, of brains the service holds.
    pub fn leaderboard(&self, board: &Board, store: &dyn Store) -> Result<BoardAnswer> {
        // A brain once, at its best run (it may have one a profile or length).
        let mut seen = HashSet::new();
        let entries = store
            .board(board, BOARD_SIZE * VERIFIED_PER_BRAIN)?
            .into_iter()
            .filter(|r| self.brains.contains_key(&r.brain) && seen.insert(r.brain.clone()))
            .filter_map(|r| {
                Some(BoardEntry { lap_frames: r.lap_frames?, id: r.brain, laps: r.laps, fitness: plain(r.fitness), profile: r.profile, verified: r.created })
            })
            .take(BOARD_SIZE)
            .collect();
        Ok(BoardAnswer { protocol: PROTOCOL, track: board.track.clone(), max_speed: board.max_speed, traction: board.traction, entries })
    }

    /// Cloud training (X2), one session: in one of the three learning
    /// contexts on a preset the most players' brains learned in (collisions
    /// off, at most 120 s; which one turns with `seed`), the best
    /// `TRAIN_SEEDS` brains there (by what they are
    /// served with in that context) are driven, then children of the best
    /// two, each the parent's weights moved toward random ones as network.js
    /// `mutate` does (amounts 0.05, 0.1, 0.2 in turn), until `t.frames`
    /// frames are used. A child that drove better than every seed (more
    /// fitness, or as much with an earlier first lap) is archived as a brain
    /// of the service's own (`CLOUD_CONTRIBUTOR`, source `cloud`), with its
    /// run as its verified run. Only while nobody has contributed for
    /// `t.idle_minutes`. Deterministic for a `seed`. None: nothing to do.
    pub fn train(&mut self, t: Training, now: u64, seed: u64, store: &mut dyn Store) -> Result<Option<TrainReport>> {
        if !Brain::idle(t, now, self.minutes.back().map(|(m, _)| *m)) {
            return Ok(None);
        }
        // The busiest presets and contexts: the most players learned in them
        // (contributors, not brains: one token's many brains count once);
        // ties to the most brains, then the lowest hash; the session's turn
        // picks.
        let mut groups: HashMap<u64, (HashSet<u32>, usize, Context, &'static presets::Preset)> = HashMap::new();
        for b in self.brains.values().filter(|b| !b.cloud) {
            let Some(c) = b.context.as_ref().filter(|c| c.collisions == "off" && c.seconds <= wire::limits::VERIFY_SECONDS) else { continue };
            let Some(p) = presets::by_key(&c.track) else { continue };
            let g = groups.entry(context_hash(c)).or_insert_with(|| (HashSet::new(), 0, c.clone(), p));
            g.0.insert(b.owner);
            g.1 += 1;
        }
        let mut groups: Vec<(u64, (u64, Context, &'static presets::Preset))> =
            groups.into_iter().map(|(k, (who, n, c, p))| (k, (((who.len() as u64) << 32) | (n as u64).min(u64::from(u32::MAX)), c, p))).collect();
        groups.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.0.cmp(&b.0)));
        groups.truncate(TRAIN_CONTEXTS);
        if groups.is_empty() {
            return Ok(None);
        }
        let turn = (seed % groups.len() as u64) as usize;
        let (key, (_, context, preset)) = groups.swap_remove(turn);
        // The seeds: the best served there (a run the service drove counts as
        // it is; then the highest claims), and one brain not driven yet,
        // chosen at random: its run is kept, so each session tries one more
        // and none waits behind claims forever.
        let mut seeds: Vec<(&str, f64, f64, bool)> = self
            .brains
            .iter()
            .filter(|(_, b)| b.own == Some(key))
            .map(|(id, b)| (id.as_str(), self.served_fitness(id, b, key), b.fitness, b.verified.is_some()))
            .collect();
        seeds.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.2.total_cmp(&a.2)).then(a.0.cmp(b.0)));
        let mut random = Xorshift::new(seed);
        let mut seed_ids: Vec<String> = seeds.iter().take(TRAIN_SEEDS - 1).map(|s| s.0.to_string()).collect();
        let untried: Vec<&str> = seeds.iter().skip(TRAIN_SEEDS - 1).filter(|s| !s.3).map(|s| s.0).collect();
        if !untried.is_empty() {
            seed_ids.push(untried[(random.next() % untried.len() as u64) as usize].to_string());
        } else if let Some(next) = seeds.get(TRAIN_SEEDS - 1) {
            seed_ids.push(next.0.to_string());
        }
        let rows = store.brain_rows(&seed_ids.iter().map(String::as_str).collect::<Vec<_>>())?;

        let g = &preset.geometry;
        let pt = |p: &[f64; 2]| sim::Point { x: p[0], y: p[1] };
        let gates: Vec<sim::Segment> = g.checkpoints.iter().map(|c| [pt(&c[0]), pt(&c[1])]).collect();
        let track = sim::Track::new(g.width, g.height, &g.inner.iter().map(pt).collect::<Vec<_>>(), &g.outer.iter().map(pt).collect::<Vec<_>>(), &gates);
        let Some(pose) = track.start() else { return Ok(None) };
        let settings = sim::Settings { max_speed: context.max_speed, traction: context.traction, profile: sim::Profile::from_id(&context.profile) };
        let per_run = ((context.seconds * 60.0).floor() as u64).max(1);
        let mut left = t.frames;
        let mut drive = |v: &[f32]| -> Option<sim::Outcome> {
            if left < per_run {
                return None;
            }
            left -= per_run;
            let o = sim::run_within(&track, pose, sim::Brain::from_flat(v)?, settings, per_run, per_run * VERIFY_WORK_PER_FRAME, |_, _| {});
            (!o.over_budget).then_some(o)
        };
        let run_row = |brain: &str, o: &sim::Outcome| VerifiedRow {
            brain: brain.to_string(),
            track: preset.key.clone(),
            profile: context.profile.clone(),
            max_speed: context.max_speed,
            traction: context.traction,
            seconds: context.seconds,
            fitness: o.fitness,
            laps: u64::from(o.laps),
            lap_frames: o.lap_frames.first().copied(),
            frames: o.frames,
            contributor: CLOUD_CONTRIBUTOR.into(),
            created: now,
        };
        // (vector, outcome, the seed it descends from, mutations since)
        let mut pool: Vec<(Vec<f32>, sim::Outcome, usize, u64)> = Vec::new();
        let mut generations: Vec<u64> = Vec::new();
        let mut seed_runs: Vec<VerifiedRow> = Vec::new();
        for (i, row) in rows.into_iter().enumerate() {
            let generation = row.as_ref().and_then(|(_, meta)| serde_json::from_str::<serde_json::Value>(meta).ok()).and_then(|m| wire::clean_brain_meta(Some(&m)).generation);
            generations.push(generation.unwrap_or(0));
            let Some((vector, _)) = row else { continue };
            if let Some(o) = drive(&vector) {
                seed_runs.push(run_row(&seed_ids[i], &o));
                pool.push((vector, o, i, 0));
            }
        }
        let rank = |pool: &mut Vec<(Vec<f32>, sim::Outcome, usize, u64)>| {
            pool.sort_by(|a, b| if a.1.beats(&b.1) { std::cmp::Ordering::Less } else if b.1.beats(&a.1) { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal });
        };
        rank(&mut pool);
        let Some(seed_best) = pool.first().map(|p| p.1.clone()) else { return Ok(None) };
        let mut runs = pool.len();
        let mut best_child: Option<(Vec<f32>, sim::Outcome, usize, u64)> = None;
        loop {
            // A parent among the best so far.
            let parent = &pool[(random.next() % pool.len().min(TRAIN_PARENTS) as u64) as usize];
            let rate = TRAIN_RATES[runs % TRAIN_RATES.len()];
            let child: Vec<f32> = parent.0.iter().map(|w| (f64::from(*w) + (random.unit() * 2.0 - 1.0 - f64::from(*w)) * rate) as f32).collect();
            let (lineage, depth) = (parent.2, parent.3 + 1);
            let Some(o) = drive(&child) else { break };
            runs += 1;
            if o.beats(&seed_best) && best_child.as_ref().map_or(true, |b| o.beats(&b.1)) {
                best_child = Some((child.clone(), o.clone(), lineage, depth));
            }
            pool.push((child, o, lineage, depth));
            rank(&mut pool);
            pool.truncate(TRAIN_PARENTS);
        }
        // The seeds' runs are runs the service drove, on a preset, in their
        // own context: kept as such (so the next session ranks them by them).
        for row in &seed_runs {
            self.keep_run(row, store)?;
        }
        let mut report = TrainReport {
            track: preset.name.clone(),
            context: context.clone(),
            seeds: seed_ids.clone(),
            runs,
            frames: t.frames - left,
            seed_fitness: plain(seed_best.fitness),
            best_fitness: plain(best_child.as_ref().map_or(seed_best.fitness, |b| b.1.fitness)),
            archived: None,
        };
        let Some((vector, outcome, lineage, depth)) = best_child else { return Ok(Some(report)) };
        let id = wire::brain_id(&vector);
        if self.brains.contains_key(&id) || wire::brain_problem(Some(&vector)).is_some() {
            return Ok(Some(report));
        }
        let parent = &seed_ids[lineage];
        // Filed on the track the most players in this context file their
        // brains on (one token cannot move it), ties to the most brains,
        // then the lowest id.
        let mut filed: HashMap<&str, (HashSet<u32>, usize)> = HashMap::new();
        for b in self.brains.values().filter(|b| !b.cloud && b.own == Some(key)) {
            if let Some(t) = b.track.as_deref().filter(|t| self.tracks.contains_key(*t)) {
                let f = filed.entry(t).or_default();
                f.0.insert(b.owner);
                f.1 += 1;
            }
        }
        let track_id = filed.into_iter().max_by(|a, b| (a.1 .0.len(), a.1 .1).cmp(&(b.1 .0.len(), b.1 .1)).then(b.0.cmp(a.0))).map(|(t, _)| t.to_string());
        let meta = Meta {
            // Its seed's generation and the mutations since; the seed is its
            // parent (the brains between were never kept).
            generation: Some(generations.get(lineage).copied().unwrap_or(0) + depth),
            parent_ids: Some(vec![parent.clone()]),
            fastest_lap: outcome.fastest_lap().map(plain),
            source: Some("cloud".into()),
            learning: Some(Learning { context: context.clone(), style_score: 0.0, driving: None }),
        };
        let fitness = plain(outcome.fitness);
        let row = BrainRow {
            id: id.clone(),
            fitness,
            track: track_id.clone(),
            dynamics: None,
            meta: serde_json::to_string(&meta).map_err(|e| StoreError(e.to_string()))?,
            contributor: CLOUD_CONTRIBUTOR.into(),
            created: now,
        };
        store.put_brain(&row, &vector)?;
        if let Some(t) = &track_id {
            if let Some(record) = self.tracks.get_mut(t) {
                record.brains.insert(id.clone());
            }
        }
        self.brains.insert(id.clone(), BrainRecord::new(fitness, track_id, &meta, CLOUD_CONTRIBUTOR, now));
        // Its run is its verified run (the service drove it, on a preset).
        self.keep_run(&run_row(&id, &outcome), store)?;
        // At most CLOUD_BRAINS of the service's own: the weakest (then the
        // oldest) goes, so sessions never fill the store.
        let mut cloud: Vec<(&str, f64, u64)> = self.brains.iter().filter(|(_, b)| b.cloud).map(|(i, b)| (i.as_str(), b.fitness, b.created)).collect();
        if cloud.len() > CLOUD_BRAINS {
            cloud.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.2.cmp(&b.2)).then(a.0.cmp(b.0)));
            let gone: Vec<String> = cloud.iter().take(cloud.len() - CLOUD_BRAINS).map(|c| c.0.to_string()).collect();
            for g in gone {
                store.delete_brain(&g)?;
                self.unlink(&g)?;
            }
        }
        self.evict(std::slice::from_ref(&id), store)?;
        report.archived = self.brains.contains_key(&id).then_some(id);
        Ok(Some(report))
    }

    /// Whether nobody has contributed for `t.idle_minutes` (the last
    /// contribution's minute given): a training session may run. The Worker
    /// asks it of the store before building the brain.
    pub fn idle(t: Training, now: u64, last_contribution: Option<u64>) -> bool {
        last_contribution.map_or(true, |m| m + t.idle_minutes <= now / MINUTE_MS)
    }

    /// Takes the contributor's slot out of one record, when the stored
    /// record (`held`) holds it by their full id: 1 when it did.
    fn forget_in(&mut self, brain: &str, key: u64, contributor: &str, held: &[Slot], store: &mut dyn Store) -> Result<usize> {
        if !held.iter().any(|s| s.id == contributor) {
            return Ok(0);
        }
        let Some(contexts) = self.feedback.get_mut(brain) else { return Ok(0) };
        let Some(aggregate) = contexts.get_mut(&key).filter(|a| a.has(tag(contributor))) else { return Ok(0) };
        aggregate.remove(tag(contributor));
        let context_key = hex_key(key);
        if aggregate.counted == 0 {
            store.delete_feedback(brain, &context_key)?;
            contexts.remove(&key);
            if contexts.is_empty() {
                self.feedback.remove(brain);
            }
        } else {
            let row = aggregate.row(brain, key, None, None);
            let slots = resolve_ids(&row.slots, held)?;
            store.put_feedback(&FeedbackRow { slots, ..row })?;
        }
        Ok(1)
    }

    /// POST /v1/recall: the brains of the nearest tracks (every brain when
    /// none is near), ranked as the browser ranks its own memory, with each
    /// brain's served fitness (`Brain::served_fitness`); best k.
    pub fn recall(&self, r: &Recall, store: &dyn Store) -> Result<RecallAnswer> {
        let mut candidates: HashMap<&str, f64> = HashMap::new();
        {
            for (track, distance) in nearest(&self.track_db, &r.track, TRACK_HITS)? {
                let sim = 1.0 - f64::from(distance);
                for id in self.tracks.get(&track).into_iter().flat_map(|t| t.brains.iter()) {
                    let best = candidates.entry(id.as_str()).or_insert(sim);
                    *best = best.max(sim);
                }
            }
        }
        if candidates.is_empty() {
            candidates = self.brains.keys().map(|id| (id.as_str(), 0.0)).collect();
        }
        let mut dynamics_sim: HashMap<String, f64> = HashMap::new();
        let dynamics_active = r.dynamics.is_some() && !self.dynamics_db.is_empty().map_err(db_error)?;
        if let Some(d) = r.dynamics.as_ref().filter(|_| dynamics_active) {
            for (id, distance) in nearest(&self.dynamics_db, d, DYNAMICS_HITS)? {
                dynamics_sim.insert(id, 1.0 - f64::from(distance));
            }
        }
        let query_key = context_hash(&r.context);
        let query = Match::of(&r.context);
        let mut scored: Vec<(&str, f64, f64, f64)> = candidates
            .into_iter()
            .filter_map(|(id, track_sim)| Some((id, track_sim, self.brains.get(id)?)))
            .map(|(id, track_sim, b)| {
                let fitness = self.served_fitness(id, b, query_key);
                let track_term = 0.5 + 0.5 * track_sim;
                let dynamics_term = if dynamics_active { 1.0 + DYNAMICS_TERM_WEIGHT * dynamics_sim.get(id).copied().unwrap_or(0.0) } else { 1.0 };
                let weight = self.weight_in(id, b, query_key);
                let score = track_term * fit_term(fitness) * dynamics_term * factor(b.matching.as_ref(), &query) * (1.0 + FEEDBACK_TERM_WEIGHT * weight);
                (id, score, track_sim, fitness)
            })
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(b.0)));
        scored.truncate(r.k);
        let ids: Vec<&str> = scored.iter().map(|s| s.0).collect();
        let rows = store.brain_rows(&ids)?;
        let mut pool = Vec::with_capacity(scored.len());
        for ((id, score, track_sim, fitness), row) in scored.into_iter().zip(rows) {
            // A brain whose weights the store lost is left out, never sent bad.
            let Some((vector, meta)) = row.filter(|(v, _)| wire::brain_problem(Some(v)).is_none() && wire::brain_id(v) == id) else { continue };
            let meta = serde_json::from_str::<serde_json::Value>(&meta).map(|m| wire::clean_brain_meta(Some(&m))).unwrap_or_default();
            let weight = self.brains.get(id).map_or(0.0, |b| self.weight_in(id, b, query_key));
            let feedback = self.aggregate(id, &query_key).map_or(Feedback { weight: 0.0, count: 0, contributors: 0 }, |a| Feedback {
                weight,
                count: u64::from(a.count).min(wire::limits::COUNT as u64),
                contributors: a.counted as usize,
            });
            pool.push(PoolEntry {
                id: id.to_string(),
                vector: wire::encode_f32(&vector),
                fitness,
                score: plain(clamp(score, -wire::limits::FITNESS, wire::limits::FITNESS)),
                track_sim: plain(clamp(track_sim, -1.0, 1.0)),
                meta,
                feedback,
            });
        }
        Ok(RecallAnswer { protocol: PROTOCOL, brain_schema: BRAIN_SCHEMA, pool })
    }

    fn aggregate(&self, id: &str, key: &u64) -> Option<&Aggregate> {
        self.feedback.get(id).and_then(|m| m.get(key))
    }

    /// GET /v1/stats: contributions over the last 1 440 minutes (this one
    /// included), contributors seen since UTC midnight.
    pub fn stats(&self, now: u64, store: &dyn Store) -> Result<Stats> {
        let minute = now / MINUTE_MS;
        let contributions: u64 = self.minutes.iter().filter(|m| m.0 + DAY_MINUTES > minute).map(|m| m.1).sum();
        Ok(Stats {
            protocol: PROTOCOL,
            brains: self.brains.len(),
            tracks: self.tracks.len(),
            contributors_today: store.contributors_since(now - now % DAY_MS)?,
            contributions24h: contributions as usize,
        })
    }
}

// ─── a store in memory ───────────────────────────────────────────────────────

/// A record's slots with every id: a slot the brain wrote by its tag alone
/// keeps the id `held` has for that tag.
pub fn resolve_ids(slots: &[Slot], held: &[Slot]) -> Result<Vec<Slot>> {
    slots
        .iter()
        .map(|s| {
            if !s.id.is_empty() {
                return Ok(s.clone());
            }
            let id = held.iter().find(|h| h.who == s.who).map(|h| h.id.clone());
            id.map(|id| Slot { id, ..s.clone() }).ok_or_else(|| StoreError(format!("feedback slot {:04x} without a contributor", s.who)))
        })
        .collect()
}

/// A contributor as the store keeps them (today's only).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ContributorRow {
    pub first_seen: u64,
    pub last_seen: u64,
    /// The UTC day `used` counts.
    pub day: u64,
    pub used: Usage,
}

/// The store in memory: for tests, and the reference the SQLite store in the
/// Worker follows.
#[derive(Clone, Debug, Default)]
pub struct MemStore {
    pub tracks: HashMap<String, TrackRow>,
    pub brains: HashMap<String, (BrainRow, Vec<f32>)>,
    pub feedback: HashMap<(String, String), FeedbackRow>,
    /// minute → contributions
    pub minutes: std::collections::BTreeMap<u64, u64>,
    pub contributors: HashMap<String, ContributorRow>,
    pub verified: Vec<VerifiedRow>,
    /// track key → the digest of its geometry (X1).
    pub pins: HashMap<String, String>,
    /// Fail the n-th write from now (tests of a store that breaks mid-request).
    pub fail_after: Option<usize>,
    /// Feedback records read by `feedback_slots` and `records_of`, and the
    /// queries that read them (tests of what a forget costs).
    pub records_read: std::cell::Cell<usize>,
    pub queries: std::cell::Cell<usize>,
}

impl MemStore {
    fn write(&mut self) -> Result<()> {
        match &mut self.fail_after {
            Some(0) => Err(StoreError("store failed".into())),
            Some(n) => {
                *n -= 1;
                Ok(())
            }
            None => Ok(()),
        }
    }
}

impl Store for MemStore {
    fn load(&self, since_minute: u64, sink: &mut dyn FnMut(Loaded) -> Result<()>) -> Result<()> {
        let mut tracks: Vec<&TrackRow> = self.tracks.values().collect();
        tracks.sort_by(|a, b| a.id.cmp(&b.id));
        let mut brains: Vec<&BrainRow> = self.brains.values().map(|b| &b.0).collect();
        brains.sort_by(|a, b| a.id.cmp(&b.id));
        let mut feedback: Vec<&FeedbackRow> = self.feedback.values().collect();
        // As the SQL store: by brain, the most recently updated first.
        feedback.sort_by(|a, b| a.brain.cmp(&b.brain).then(b.updated.cmp(&a.updated)).then(a.context_key.cmp(&b.context_key)));
        tracks.into_iter().try_for_each(|t| sink(Loaded::Track(t.clone())))?;
        brains.into_iter().try_for_each(|b| sink(Loaded::Brain(b.clone())))?;
        self.verified.iter().try_for_each(|v| sink(Loaded::Verified(v.clone())))?;
        // As the SQL store, the context is not loaded back.
        feedback.into_iter().try_for_each(|f| sink(Loaded::Feedback(FeedbackRow { context: None, ..f.clone() })))?;
        self.minutes.range(since_minute + 1..).try_for_each(|(m, c)| sink(Loaded::Minute(*m, *c)))
    }
    fn put_track(&mut self, row: &TrackRow) -> Result<()> {
        self.write()?;
        self.tracks.insert(row.id.clone(), row.clone());
        Ok(())
    }
    fn delete_track(&mut self, id: &str) -> Result<()> {
        self.write()?;
        self.tracks.remove(id);
        Ok(())
    }
    fn put_brain(&mut self, row: &BrainRow, vector: &[f32]) -> Result<()> {
        self.write()?;
        self.brains.insert(row.id.clone(), (row.clone(), vector.to_vec()));
        Ok(())
    }
    fn delete_brain(&mut self, id: &str) -> Result<()> {
        self.write()?;
        self.brains.remove(id);
        self.feedback.retain(|k, _| k.0 != id);
        self.verified.retain(|v| v.brain != id);
        Ok(())
    }
    fn put_feedback(&mut self, row: &FeedbackRow) -> Result<()> {
        self.write()?;
        let key = (row.brain.clone(), row.context_key.clone());
        let held = self.feedback.get(&key);
        let slots = resolve_ids(&row.slots, held.map_or(&[][..], |r| &r.slots[..]))?;
        // Without a context, the stored one stays (as the SQL upsert does).
        let context = row.context.clone().or_else(|| held.and_then(|r| r.context.clone()));
        self.feedback.insert(key, FeedbackRow { context, slots, ..row.clone() });
        Ok(())
    }
    fn feedback_slots(&self, brain: &str, context_key: &str) -> Result<Option<Vec<Slot>>> {
        self.queries.set(self.queries.get() + 1);
        self.records_read.set(self.records_read.get() + 1);
        Ok(self.feedback.get(&(brain.to_string(), context_key.to_string())).map(|r| r.slots.clone()))
    }
    fn records_of(&self, contributor: &str, after: Option<&(String, String)>, limit: usize) -> Result<Page> {
        // As the SQL scan: every record after `after` is looked at, and a
        // page is `limit` records holding the id.
        self.queries.set(self.queries.get() + 1);
        let mut keys: Vec<&(String, String)> = self.feedback.keys().filter(|k| after.is_none_or(|a| *k > a)).collect();
        keys.sort();
        let mut page = Vec::new();
        for k in keys {
            self.records_read.set(self.records_read.get() + 1);
            let r = &self.feedback[k];
            if r.slots.iter().any(|s| s.id == contributor) {
                page.push((k.0.clone(), k.1.clone(), r.slots.clone()));
                if page.len() == limit {
                    return Ok((page, Some(k.clone())));
                }
            }
        }
        Ok((page, None))
    }
    fn delete_feedback(&mut self, brain: &str, context_key: &str) -> Result<()> {
        self.write()?;
        self.feedback.remove(&(brain.to_string(), context_key.to_string()));
        Ok(())
    }
    fn count_contribution(&mut self, minute: u64, prune_minute: u64) -> Result<()> {
        self.write()?;
        *self.minutes.entry(minute).or_insert(0) += 1;
        self.minutes.retain(|m, _| *m > prune_minute);
        Ok(())
    }
    fn usage(&self, contributor: &str, day: u64) -> Result<Usage> {
        Ok(self.contributors.get(contributor).filter(|c| c.day == day).map_or(Usage::default(), |c| c.used))
    }
    fn count_usage(&mut self, contributor: &str, day: u64, add: Usage, at: u64, prune_before: u64) -> Result<()> {
        self.write()?;
        let row = self.contributors.entry(contributor.to_string()).or_insert(ContributorRow { first_seen: at, last_seen: at, day, used: Usage::default() });
        if row.day != day {
            row.day = day;
            row.used = Usage::default();
        }
        row.used.requests += add.requests;
        row.used.brains += add.brains;
        row.used.feedback += add.feedback;
        row.last_seen = at;
        self.contributors.retain(|_, c| c.last_seen >= prune_before);
        Ok(())
    }
    fn contributors_since(&self, since: u64) -> Result<usize> {
        Ok(self.contributors.values().filter(|c| c.last_seen >= since).count())
    }
    fn brain_rows(&self, ids: &[&str]) -> Result<Vec<Option<StoredBrain>>> {
        Ok(ids.iter().map(|id| self.brains.get(*id).map(|b| (b.1.clone(), b.0.meta.clone()))).collect())
    }
    fn delete_brains_of(&mut self, contributor: &str) -> Result<Vec<String>> {
        let mut ids: Vec<String> = self.brains.values().filter(|b| b.0.contributor == contributor).map(|b| b.0.id.clone()).collect();
        ids.sort();
        // As the SQL store: their feedback first, then the brains.
        self.write()?;
        self.feedback.retain(|k, _| !ids.contains(&k.0));
        self.write()?;
        self.brains.retain(|id, _| !ids.contains(id));
        self.verified.retain(|v| !ids.contains(&v.brain));
        Ok(ids)
    }
    fn put_verified(&mut self, row: &VerifiedRow) -> Result<()> {
        self.write()?;
        self.verified.retain(|v| !v.same_run(row));
        self.verified.push(row.clone());
        Ok(())
    }
    fn delete_verified(&mut self, row: &VerifiedRow) -> Result<()> {
        self.write()?;
        self.verified.retain(|v| !v.same_run(row));
        Ok(())
    }
    fn verified_of(&self, brain: &str) -> Result<Vec<VerifiedRow>> {
        Ok(self.verified.iter().filter(|v| v.brain == brain).cloned().collect())
    }
    fn board(&self, board: &Board, limit: usize) -> Result<Vec<VerifiedRow>> {
        let mut rows: Vec<VerifiedRow> = self
            .verified
            .iter()
            .filter(|v| v.track == board.track && v.max_speed == board.max_speed && v.traction == board.traction && v.lap_frames.is_some())
            .filter(|v| self.brains.contains_key(&v.brain))
            .cloned()
            .collect();
        rows.sort_by(|a, b| a.lap_frames.cmp(&b.lap_frames).then(b.fitness.total_cmp(&a.fitness)).then(a.created.cmp(&b.created)).then(a.brain.cmp(&b.brain)));
        rows.truncate(limit);
        Ok(rows)
    }
    fn anonymize_verified(&mut self, contributor: &str) -> Result<()> {
        self.write()?;
        for v in self.verified.iter_mut().filter(|v| v.contributor == contributor) {
            v.contributor.clear();
        }
        Ok(())
    }
    fn pinned(&self, track: &str) -> Result<Option<String>> {
        Ok(self.pins.get(track).cloned())
    }
    fn pin(&mut self, track: &str, digest: &str, _now: u64) -> Result<()> {
        self.write()?;
        self.pins.entry(track.to_string()).or_insert_with(|| digest.to_string());
        Ok(())
    }
    fn last_contribution(&self) -> Result<Option<u64>> {
        Ok(self.minutes.keys().next_back().copied())
    }
}
