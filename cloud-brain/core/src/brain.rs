//! The shared brain: what it holds, how a contribution enters it, how a
//! recall is ranked, and what is evicted when it is full. Storage is behind
//! [`Store`] (SQLite in the Durable Object, [`MemStore`] in tests); the
//! indexes are ruvector-core `VectorDB`s (memory-only, a flat index), rebuilt
//! from the store by [`Brain::open`].
//!
//! Brain weights and meta stay in the store: a recall reads only the k it
//! returns. In memory: the track index (512 floats a track), the dynamics
//! index (64 a brain), and for each brain its fitness, track, what the
//! context match compares (`Match`), and its feedback as fixed-size records.
//! Everything held is capped (brains, tracks, contexts a brain, contributors a
//! context), so memory stays bounded whatever the requests.

use crate::wire::{self, clamp, plain, Context, Contribution, Meta, Reason, Recall, Refused, PROTOCOL, BRAIN_SCHEMA};
use ruvector_core::types::{DbOptions, DistanceMetric, SearchQuery, VectorEntry};
use ruvector_core::VectorDB;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

/// Sizes and ranking constants.
#[derive(Clone, Debug)]
pub struct Config {
    /// Brains kept; over it, the least valuable are evicted.
    pub max_brains: usize,
    /// Tracks kept; a new track over it replaces a track no brain uses.
    pub max_tracks: usize,
    /// The best brains of each track are never evicted.
    pub keep_per_track: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self { max_brains: 20_000, max_tracks: 5_000, keep_per_track: 3 }
    }
}

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
/// observeOffspring (EMA_ALPHA).
const EMA_ALPHA: f64 = 0.3;
/// Feedback kept per brain: the contexts most recently reported (a brain is
/// bred in a few; the rest would only grow memory).
pub const MAX_CONTEXTS_PER_BRAIN: usize = 8;
/// Distinct contributors counted per brain and context; more count as this
/// (enough to tell one contributor from several; CB4 aggregates per contributor).
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

#[derive(Clone, Debug, PartialEq)]
pub struct FeedbackRow {
    pub brain: String,
    /// `context_key` of the context: 16 hex digits.
    pub context_key: String,
    /// The context, as JSON: written for people and CB4, not loaded back.
    pub context: String,
    pub weight: f64,
    pub count: u64,
    pub baseline: Option<f64>,
    /// Up to MAX_CONTRIBUTORS `short32` contributor ids.
    pub contributors: Vec<u32>,
    pub updated: u64,
}

/// One row as the store loads it back, in this order: every track, every
/// brain, every feedback row (by brain, the most recently updated first),
/// then the contribution counts of the last 24 hours' minutes.
#[derive(Clone, Debug)]
pub enum Loaded {
    Track(TrackRow),
    Brain(BrainRow),
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
    /// The brain and its feedback rows.
    fn delete_brain(&mut self, id: &str) -> Result<()>;
    fn put_feedback(&mut self, row: &FeedbackRow) -> Result<()>;
    fn delete_feedback(&mut self, brain: &str, context_key: &str) -> Result<()>;
    /// Counts a contribution in its minute (dropping the counts of minutes at
    /// or before `prune_minute`), and when its contributor was last seen.
    fn count_contribution(&mut self, minute: u64, prune_minute: u64, contributor: &str, at: u64) -> Result<()>;
    /// How many contributors were seen at or after `since`.
    fn contributors_since(&self, since: u64) -> Result<usize>;
    /// The weights and meta (JSON) of these brains (None for one the store
    /// does not hold).
    fn brain_rows(&self, ids: &[&str]) -> Result<Vec<Option<StoredBrain>>>;
}

/// A contributor's id: 128 bits of SHA-256 of their token. The token itself
/// is never stored.
pub fn contributor_id(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// 64 bits of SHA-256 of a text: how memory holds contributors and contexts.
pub fn short(text: &str) -> u64 {
    let digest = Sha256::digest(text.as_bytes());
    u64::from_be_bytes([digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7]])
}

/// 32 bits of SHA-256 of a text: a contributor, in a feedback record.
pub fn short32(text: &str) -> u32 {
    let digest = Sha256::digest(text.as_bytes());
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

/// A context as a feedback key: 64 bits of its `Context::key`.
pub fn context_hash(context: &Context) -> u64 {
    short(&context.key())
}
fn hex_key(hash: u64) -> String {
    format!("{hash:016x}")
}

// ─── answers ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct Feedback {
    pub weight: f64,
    pub count: u64,
    pub contributors: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct PoolEntry {
    pub id: String,
    pub vector: String,
    pub fitness: f64,
    pub score: f64,
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

// ─── the brain ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct BrainRecord {
    fitness: f64,
    track: Option<String>,
    /// `context_hash` of its learning context.
    context: Option<u64>,
    /// What the context match compares (None: a brain without a context).
    matching: Option<Match>,
    created: u64,
}

impl BrainRecord {
    fn new(fitness: f64, track: Option<String>, meta: &Meta, created: u64) -> Self {
        let context = meta.learning.as_ref().map(|l| &l.context);
        BrainRecord { fitness, track, context: context.map(context_hash), matching: context.map(Match::of), created }
    }
}

/// Feedback for one brain in one context, in 64 bytes.
#[derive(Clone, Debug)]
struct Aggregate {
    weight: f64,
    /// NaN: none yet.
    baseline: f64,
    count: u32,
    updated: u64,
    contributors: [u32; MAX_CONTRIBUTORS],
    counted: u8,
}

// The size the docs state (docs/validation/cloud-brain.md, CB2).
const _: () = assert!(std::mem::size_of::<Aggregate>() == 64);

impl Aggregate {
    fn new(now: u64) -> Self {
        Aggregate { weight: 0.0, baseline: f64::NAN, count: 0, updated: now, contributors: [0; MAX_CONTRIBUTORS], counted: 0 }
    }
    fn baseline(&self) -> Option<f64> {
        (!self.baseline.is_nan()).then_some(self.baseline)
    }
    fn contributors(&self) -> &[u32] {
        &self.contributors[..self.counted as usize]
    }
    fn count_contributor(&mut self, who: u32) {
        if (self.counted as usize) < MAX_CONTRIBUTORS && !self.contributors().contains(&who) {
            self.contributors[self.counted as usize] = who;
            self.counted += 1;
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
}

impl Brain {
    /// Rebuilds the brain from its store. Rows that no longer clean (a
    /// corrupted meta, a vector of the wrong size, feedback about a brain not
    /// held or over the context cap) are deleted from the store, so what is
    /// served live and after a rebuild is the same.
    pub fn open(config: Config, store: &mut dyn Store, now: u64) -> Result<Brain> {
        let mut brain = Brain {
            config,
            brains: HashMap::new(),
            tracks: HashMap::new(),
            track_db: index(wire::TRACK_DIM),
            dynamics_db: index(wire::DYNAMICS_DIM),
            feedback: HashMap::new(),
            minutes: VecDeque::new(),
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
                    brain.brains.insert(b.id, BrainRecord::new(plain(b.fitness), track, &wire::clean_brain_meta(Some(&meta)), b.created));
                }
                Loaded::Feedback(f) => {
                    let key = u64::from_str_radix(&f.context_key, 16).ok();
                    let contexts = brain.feedback.get(&f.brain).map_or(0, HashMap::len);
                    // The most recent rows come first: past the cap (a store
                    // an older build wrote) the rest are deleted.
                    let (Some(key), true, true) = (key, brain.brains.contains_key(&f.brain), contexts < MAX_CONTEXTS_PER_BRAIN) else {
                        bad_feedback.push((f.brain, f.context_key));
                        return Ok(());
                    };
                    let mut aggregate = Aggregate::new(f.updated);
                    aggregate.weight = clamp(f.weight, -1.0, 1.0);
                    aggregate.baseline = f.baseline.unwrap_or(f64::NAN);
                    aggregate.count = f.count.min(u64::from(u32::MAX)) as u32;
                    for who in f.contributors {
                        aggregate.count_contributor(who);
                    }
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

    /// POST /v1/contribute: store what is new, apply the feedback, evict what
    /// no longer fits. Brains already held are accepted again (idempotent).
    pub fn contribute(&mut self, c: Contribution, contributor: &str, now: u64, store: &mut dyn Store) -> Result<ContributeAnswer> {
        let minute = now / MINUTE_MS;
        store.count_contribution(minute, minute.saturating_sub(DAY_MINUTES), contributor, now)?;
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
            self.brains.insert(b.id.clone(), BrainRecord::new(b.fitness, track, &b.meta, now));
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
        Ok(ContributeAnswer { protocol: PROTOCOL, accepted, rejected: c.rejected, feedback_accepted, feedback_rejected })
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

    /// How much a brain is worth keeping: its fitness, adjusted by how its
    /// offspring did (the count-weighted mean of its feedback weights).
    fn value(&self, id: &str, b: &BrainRecord) -> f64 {
        let (mut sum, mut count) = (0.0, 0.0);
        for a in self.feedback.get(id).into_iter().flat_map(|m| m.values()) {
            sum += a.weight * f64::from(a.count);
            count += f64::from(a.count);
        }
        let weight = if count > 0.0 { sum / count } else { 0.0 };
        fit_term(b.fitness) * (1.0 + FEEDBACK_TERM_WEIGHT * weight)
    }

    /// Over the cap, the least valuable brains go (the oldest first among
    /// equals). Never the brains just contributed, nor each track's best.
    fn evict(&mut self, fresh: &[String], store: &mut dyn Store) -> Result<()> {
        let over = self.brains.len().saturating_sub(self.config.max_brains);
        if over == 0 {
            return Ok(());
        }
        let doomed: Vec<String> = {
            let values: HashMap<&str, f64> = self.brains.iter().map(|(id, b)| (id.as_str(), self.value(id, b))).collect();
            let mut kept: BTreeSet<&str> = fresh.iter().map(String::as_str).collect();
            for track in self.tracks.values() {
                let mut best: Vec<(&str, f64)> = track.brains.iter().filter_map(|id| values.get(id.as_str()).map(|v| (id.as_str(), *v))).collect();
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
            let Some(record) = self.brains.remove(&id) else { continue };
            if let Some(t) = record.track.and_then(|t| self.tracks.get_mut(&t)) {
                t.brains.remove(&id);
            }
            self.dynamics_db.delete(&id).map_err(db_error)?;
            self.feedback.remove(&id);
        }
        Ok(())
    }

    /// One feedback row, as the browser's observeOffspring applies it: in the
    /// brain's own context the baseline is its fitness; in another context,
    /// the mean the previous row reported (the first row only sets it).
    /// False when the brain is not held.
    fn apply_feedback(
        &mut self,
        row: &wire::FeedbackIn,
        contributor: &str,
        now: u64,
        this_request: &HashSet<(String, u64)>,
        store: &mut dyn Store,
    ) -> Result<std::result::Result<(), Reason>> {
        let Some(brain) = self.brains.get(&row.id) else { return Ok(Err(Reason::FeedbackUnknown)) };
        let key = context_hash(&row.context);
        // matchContext's exact match needs a track key (`!!q.track`).
        let exact = brain.context == Some(key) && !row.context.track.is_empty();
        let fitness = brain.fitness;
        let contexts = self.feedback.entry(row.id.clone()).or_default();
        // A new context over the cap replaces the least reported one (fewest
        // reports, then fewest contributors, then the oldest) among those
        // reported once, or not for 7 days; never one this request reported.
        // So new contexts, however many, cannot push out ones that repeated
        // reports built up. With none to replace, the row is refused.
        if !contexts.contains_key(&key) && contexts.len() >= MAX_CONTEXTS_PER_BRAIN {
            let weakest = contexts
                .iter()
                .filter(|(k, a)| (a.count <= 1 || a.updated + STALE_MS <= now) && !this_request.contains(&(row.id.clone(), **k)))
                .min_by(|a, b| (a.1.count, a.1.counted, a.1.updated, a.0).cmp(&(b.1.count, b.1.counted, b.1.updated, b.0)))
                .map(|(k, _)| *k);
            let Some(weakest) = weakest else { return Ok(Err(Reason::FeedbackFull)) };
            store.delete_feedback(&row.id, &hex_key(weakest))?;
            contexts.remove(&weakest);
        }
        let aggregate = contexts.entry(key).or_insert_with(|| Aggregate::new(now));
        let baseline = if exact { Some(fitness) } else { aggregate.baseline() };
        if let Some(baseline) = baseline {
            let feedback = offspring_feedback(row.mean_fitness, baseline);
            aggregate.weight = plain(EMA_ALPHA * feedback + (1.0 - EMA_ALPHA) * aggregate.weight);
        }
        aggregate.count = aggregate.count.saturating_add(1);
        aggregate.baseline = row.mean_fitness;
        aggregate.count_contributor(short32(contributor));
        aggregate.updated = now;
        store.put_feedback(&FeedbackRow {
            brain: row.id.clone(),
            context_key: hex_key(key),
            context: serde_json::to_string(&row.context).map_err(|e| StoreError(e.to_string()))?,
            weight: aggregate.weight,
            count: u64::from(aggregate.count),
            baseline: aggregate.baseline(),
            contributors: aggregate.contributors().to_vec(),
            updated: now,
        })?;
        Ok(Ok(()))
    }

    /// POST /v1/recall: the brains of the nearest tracks (every brain when
    /// none is near), ranked as the browser ranks its own memory, best k.
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
        let mut scored: Vec<(&str, f64)> = candidates
            .into_iter()
            .filter_map(|(id, track_sim)| Some((id, track_sim, self.brains.get(id)?)))
            .map(|(id, track_sim, b)| {
                let track_term = 0.5 + 0.5 * track_sim;
                let dynamics_term = if dynamics_active { 1.0 + DYNAMICS_TERM_WEIGHT * dynamics_sim.get(id).copied().unwrap_or(0.0) } else { 1.0 };
                let weight = self.aggregate(id, &query_key).map_or(0.0, |a| a.weight);
                let score = track_term * fit_term(b.fitness) * dynamics_term * factor(b.matching.as_ref(), &query) * (1.0 + FEEDBACK_TERM_WEIGHT * weight);
                (id, score)
            })
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(b.0)));
        scored.truncate(r.k);
        let ids: Vec<&str> = scored.iter().map(|s| s.0).collect();
        let rows = store.brain_rows(&ids)?;
        let mut pool = Vec::with_capacity(scored.len());
        for ((id, score), row) in scored.into_iter().zip(rows) {
            // A brain whose weights the store lost is left out, never sent bad.
            let Some((vector, meta)) = row.filter(|(v, _)| wire::brain_problem(Some(v)).is_none() && wire::brain_id(v) == id) else { continue };
            let Some(b) = self.brains.get(id) else { continue };
            let meta = serde_json::from_str::<serde_json::Value>(&meta).map(|m| wire::clean_brain_meta(Some(&m))).unwrap_or_default();
            let feedback = self.aggregate(id, &query_key).map_or(Feedback { weight: 0.0, count: 0, contributors: 0 }, |a| Feedback {
                weight: plain(a.weight),
                count: u64::from(a.count).min(wire::limits::COUNT as u64),
                contributors: a.contributors().len(),
            });
            pool.push(PoolEntry {
                id: id.to_string(),
                vector: wire::encode_f32(&vector),
                fitness: b.fitness,
                score: plain(clamp(score, -wire::limits::FITNESS, wire::limits::FITNESS)),
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

/// The store in memory: for tests, and the reference the SQLite store in the
/// Worker follows.
#[derive(Clone, Debug, Default)]
pub struct MemStore {
    pub tracks: HashMap<String, TrackRow>,
    pub brains: HashMap<String, (BrainRow, Vec<f32>)>,
    pub feedback: HashMap<(String, String), FeedbackRow>,
    /// minute → contributions
    pub minutes: std::collections::BTreeMap<u64, u64>,
    /// contributor → (first seen, last seen)
    pub contributors: HashMap<String, (u64, u64)>,
    /// Fail the n-th write from now (tests of a store that breaks mid-request).
    pub fail_after: Option<usize>,
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
        feedback.into_iter().try_for_each(|f| sink(Loaded::Feedback(f.clone())))?;
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
        Ok(())
    }
    fn put_feedback(&mut self, row: &FeedbackRow) -> Result<()> {
        self.write()?;
        self.feedback.insert((row.brain.clone(), row.context_key.clone()), row.clone());
        Ok(())
    }
    fn delete_feedback(&mut self, brain: &str, context_key: &str) -> Result<()> {
        self.write()?;
        self.feedback.remove(&(brain.to_string(), context_key.to_string()));
        Ok(())
    }
    fn count_contribution(&mut self, minute: u64, prune_minute: u64, contributor: &str, at: u64) -> Result<()> {
        self.write()?;
        *self.minutes.entry(minute).or_insert(0) += 1;
        self.minutes.retain(|m, _| *m > prune_minute);
        self.contributors.entry(contributor.to_string()).and_modify(|c| c.1 = at).or_insert((at, at));
        Ok(())
    }
    fn contributors_since(&self, since: u64) -> Result<usize> {
        Ok(self.contributors.values().filter(|c| c.1 >= since).count())
    }
    fn brain_rows(&self, ids: &[&str]) -> Result<Vec<Option<StoredBrain>>> {
        Ok(ids.iter().map(|id| self.brains.get(*id).map(|b| (b.1.clone(), b.0.meta.clone()))).collect())
    }
}
