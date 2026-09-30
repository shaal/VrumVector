//! VectorVroom's cloud brain: one shared vector memory in a SQLite-backed
//! Durable Object (docs/plan/cloud-brain.md). Built for
//! `wasm32-unknown-emscripten` with `worker-build --emscripten`, which links a
//! bin crate: `main()` runs on module init and does nothing (the brain is
//! built by the object, never at module scope).
//!
//! The front door (`fetch`) answers what needs no brain: the breaker
//! (DISABLE_BRAIN), origins and CORS, the body limit, and unknown routes.
//! The object (`SharedBrain`) parses, holds the brain and its SQLite store.
//! The service logic is the `brain` crate (core/), tested natively.

use brain::brain::{contributor_id, Brain, BrainRow, Config, FeedbackRow, Loaded, Result as StoreResult, Store, StoreError, StoredBrain, TrackRow};
use brain::wire::{self, error_body, Reason};
use futures_util::StreamExt;
use serde::Serialize;
use std::cell::RefCell;
use std::panic::AssertUnwindSafe;
use worker::*;

fn main() {}

/// One brain for everyone: every request goes to the object with this name.
const BRAIN_NAME: &str = "vectorvroom-shared-brain-v1";
/// The ruvector commit the index comes from (scripts/build-cloud-brain.sh).
const RUVECTOR: &str = "5356a84e2";

#[derive(Serialize)]
struct Health {
    ok: bool,
    protocol: u32,
    brain: bool,
    build: Build,
}

#[derive(Serialize)]
struct Build {
    target: &'static str,
    ruvector: Option<&'static str>,
    spike: bool,
}

fn build() -> Build {
    Build {
        target: if cfg!(target_os = "emscripten") { "wasm32-unknown-emscripten" } else { "wasm32-unknown-unknown" },
        ruvector: Some(RUVECTOR),
        spike: cfg!(feature = "spike"),
    }
}

fn flag(env: &Env, name: &str) -> bool {
    env.var(name).map(|v| v.to_string() == "true").unwrap_or(false)
}

/// The origins multiplayer allows (multiplayer/worker.js), and with
/// ALLOW_LOCAL=true any localhost port.
fn origin_allowed(origin: &str, allow_local: bool) -> bool {
    let label = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if let Some(host) = origin.strip_prefix("https://").and_then(|h| h.strip_suffix("vectorvroom.pages.dev")) {
        if host.is_empty() || host.strip_suffix('.').is_some_and(label) {
            return true;
        }
    }
    if origin == "https://vectorvroom.shaal.dev" || origin == "https://vv.shaal.dev" {
        return true;
    }
    if allow_local {
        for host in ["http://localhost:", "http://127.0.0.1:"] {
            if let Some(port) = origin.strip_prefix(host) {
                return !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit());
            }
        }
    }
    false
}

/// The response with CORS headers for `origin`. A response from the object
/// has immutable headers: they are copied.
fn with_cors(response: Response, origin: Option<&str>) -> Result<Response> {
    let Some(origin) = origin else { return Ok(response) };
    let headers = Headers::new();
    for (name, value) in response.headers().entries() {
        headers.set(&name, &value)?;
    }
    headers.set("Access-Control-Allow-Origin", origin)?;
    headers.set("Vary", "Origin")?;
    Ok(response.with_headers(headers))
}

fn json_response(body: String, status: u16) -> Result<Response> {
    let mut response = Response::ok(body)?.with_status(status);
    response.headers_mut().set("Content-Type", "application/json")?;
    Ok(response)
}

fn error_response(reason: Reason) -> Result<Response> {
    json_response(error_body(reason), reason.status())
}

/// The body, at most `limit` bytes: a larger Content-Length is refused before
/// reading, and a body without one is read only up to the limit.
async fn capped_body(req: &mut Request, limit: usize) -> Result<Option<Vec<u8>>> {
    if let Some(length) = req.headers().get("Content-Length")? {
        if length.trim().parse::<u64>().map_or(true, |n| n > limit as u64) {
            return Ok(None);
        }
    }
    let mut body = Vec::new();
    let mut stream = req.stream()?;
    while let Some(chunk) = stream.next().await {
        body.extend_from_slice(&chunk?);
        if body.len() > limit {
            return Ok(None);
        }
    }
    Ok(Some(body))
}

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let path = url.path().to_string();
    let stub = || env.durable_object("BRAIN")?.get_by_name(BRAIN_NAME);
    if (req.method() == Method::Get && path == "/health") || (cfg!(feature = "spike") && path.starts_with("/spike/")) {
        return stub()?.fetch_with_request(req).await;
    }
    if !path.starts_with("/v1/") {
        return Response::error("Not found", 404);
    }
    let origin = req.headers().get("Origin")?.unwrap_or_default();
    // Emergency circuit breaker, as DISABLE_MULTIPLAYER. Readable by any
    // page, so the browser can say why.
    if flag(&env, "DISABLE_BRAIN") {
        return with_cors(error_response(Reason::Disabled)?, (!origin.is_empty()).then_some(origin.as_str()));
    }
    if !origin_allowed(&origin, flag(&env, "ALLOW_LOCAL")) {
        return Response::error("Origin not allowed", 403);
    }
    let cors = Some(origin.as_str());
    let method = req.method();
    if method == Method::Options {
        let mut response = Response::empty()?.with_status(204);
        let headers = response.headers_mut();
        headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
        headers.set("Access-Control-Allow-Headers", "Content-Type")?;
        headers.set("Access-Control-Max-Age", "86400")?;
        return with_cors(response, cors);
    }
    let forwarded = match (method, path.as_str()) {
        (Method::Post, "/v1/recall" | "/v1/contribute") => match capped_body(&mut req, wire::limits::REQUEST_BYTES).await? {
            None => return with_cors(error_response(Reason::BodyTooLarge)?, cors),
            Some(body) => {
                let mut init = RequestInit::new();
                init.with_method(Method::Post).with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
                match stub() {
                    Ok(stub) => stub.fetch_with_request(Request::new_with_init(url.as_str(), &init)?).await,
                    Err(e) => Err(e),
                }
            }
        },
        (Method::Get, "/v1/stats") => match stub() {
            Ok(stub) => stub.fetch_with_request(req).await,
            Err(e) => Err(e),
        },
        _ => return with_cors(Response::error("Not found", 404)?, cors),
    };
    // The object threw (a panic, a reset, an overload): the page still gets
    // an answer it can read.
    let response = forwarded.or_else(|e| {
        console_error!("cloud brain: the object failed: {e}");
        error_response(Reason::ServerError)
    })?;
    with_cors(response, cors)
}

// ─── the object ──────────────────────────────────────────────────────────────

#[durable_object]
pub struct SharedBrain {
    state: State,
    /// Why the schema could not be set up, if it could not: the object then
    /// answers `server-error` rather than serving from a half-made database.
    init_error: Option<String>,
    disabled: bool,
    /// Built on the first request that needs it, from SQLite, with no await
    /// in between: no other request runs until it is built (the effect of
    /// blockConcurrencyWhile). A request takes it out and puts it back only
    /// when it succeeds: after a store error or a panic the slot is empty,
    /// and the next request rebuilds it from what SQLite holds (so the
    /// assertion of unwind safety holds).
    brain: AssertUnwindSafe<RefCell<Option<Brain>>>,
    /// The spike routes also need the variable CLOUD_BRAIN_SPIKE=1 (the spike
    /// test passes it to `wrangler dev`), so a spike build that reaches a
    /// deploy by mistake still serves them to nobody.
    #[cfg_attr(not(feature = "spike"), allow(dead_code))]
    spike_enabled: bool,
}

/// The SQL schema, one migration per version (`migrations` records which
/// ran; `meta.sql_schema` is the latest). Each statement can run again, so a
/// migration cut short is finished at the next start. The brain format the
/// browser speaks (BRAIN_SCHEMA_VERSION) is a separate number.
const MIGRATIONS: &[&[&str]] = &[
    // 1 (CB2): the shared brain.
    &[
        "CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, vector BLOB NOT NULL, created INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS brains (id TEXT PRIMARY KEY, vector BLOB NOT NULL, fitness REAL NOT NULL, track TEXT, dynamics BLOB, \
         meta TEXT NOT NULL, contributor TEXT NOT NULL, created INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS feedback (brain TEXT NOT NULL, context_key TEXT NOT NULL, context TEXT NOT NULL, weight REAL NOT NULL, \
         count INTEGER NOT NULL, baseline REAL, contributors TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (brain, context_key))",
        // Contributions counted by the minute (1 440 rows at most).
        "CREATE TABLE IF NOT EXISTS contribution_minutes (minute INTEGER PRIMARY KEY, count INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS contributors (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS contributors_last_seen ON contributors (last_seen)",
    ],
];

fn init_schema(state: &State) -> Result<()> {
    let sql = state.storage().sql();
    sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)", None)?;
    sql.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied INTEGER NOT NULL)", None)?;
    let done: Vec<serde_json::Value> = sql.exec("SELECT MAX(version) AS v FROM migrations", None)?.to_array()?;
    let done = done.first().and_then(|r| r["v"].as_u64()).unwrap_or(0) as usize;
    // Code older than its database (a rollback) must not serve from it.
    if done > MIGRATIONS.len() {
        return Err(Error::RustError(format!("the database is at SQL schema {done}, this build knows {}", MIGRATIONS.len())));
    }
    for (i, statements) in MIGRATIONS.iter().enumerate().skip(done) {
        for statement in *statements {
            sql.exec(statement, None)?;
        }
        let version = (i + 1) as i64;
        sql.exec("INSERT INTO migrations (version, applied) VALUES (?, ?)", vec![version.into(), now_ms().into()])?;
    }
    sql.exec(
        "INSERT INTO meta (key, value) VALUES ('sql_schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        vec![MIGRATIONS.len().to_string().into()],
    )?;
    Ok(())
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

impl DurableObject for SharedBrain {
    fn new(state: State, env: Env) -> Self {
        // Schema before any request.
        let init_error = init_schema(&state).err().map(|e| e.to_string());
        let spike_enabled = env.var("CLOUD_BRAIN_SPIKE").map(|v| v.to_string() == "1").unwrap_or(false);
        Self { state, init_error, disabled: flag(&env, "DISABLE_BRAIN"), brain: AssertUnwindSafe(RefCell::new(None)), spike_enabled }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        if let (Method::Get, "/health") = (req.method(), url.path()) {
            return Response::from_json(&Health { ok: self.init_error.is_none(), protocol: wire::PROTOCOL, brain: !self.disabled, build: build() });
        }
        #[cfg(feature = "spike")]
        if self.spike_enabled && url.path().starts_with("/spike/") {
            return spike::route(&self.state, req).await;
        }
        if let Some(error) = &self.init_error {
            console_error!("cloud brain: schema: {error}");
            return error_response(Reason::ServerError);
        }
        let (method, path) = (req.method(), url.path().to_string());
        let route = match (method, path.as_str()) {
            (Method::Post, "/v1/contribute") => Route::Contribute,
            (Method::Post, "/v1/recall") => Route::Recall,
            (Method::Get, "/v1/stats") => Route::Stats,
            // Before any body is read or the brain built.
            _ => return Response::error("Not found", 404),
        };
        // The front door checks this too; the object never serves while off.
        if self.disabled {
            return error_response(Reason::Disabled);
        }
        // The only await: after it, the request runs to its answer alone.
        // (The front door has already cut the body at 64 KB.)
        let body = if route == Route::Stats { Vec::new() } else { req.bytes().await? };
        // Parsed before the brain is touched: a refused body never builds it.
        let job = match route {
            Route::Contribute => wire::parse_contribute(&body).map(Job::Contribute),
            Route::Recall => wire::parse_recall(&body).map(Job::Recall),
            Route::Stats => Ok(Job::Stats),
        };
        let job = match job {
            Ok(job) => job,
            Err(reason) => return error_response(reason),
        };
        let now = now_ms() as u64;
        let mut store = SqlStore(self.state.storage().sql());
        let result = match self.brain.take() {
            Some(brain) => Ok(brain),
            None => Brain::open(Config::default(), &mut store, now),
        }
        .and_then(|mut brain| {
            let answer = run(&mut brain, &mut store, job, now)?;
            self.brain.replace(Some(brain));
            Ok(answer)
        });
        match result {
            Ok(answer) => json_response(answer, 200),
            Err(error) => {
                // The store may hold part of this request: the brain is
                // rebuilt from it on the next request.
                console_error!("cloud brain: {error}");
                error_response(Reason::ServerError)
            }
        }
    }
}

#[derive(PartialEq)]
enum Route {
    Contribute,
    Recall,
    Stats,
}

/// A parsed request.
enum Job {
    Contribute(wire::Contribution),
    Recall(wire::Recall),
    Stats,
}

/// A job against the brain: its answer as JSON, or the store's error (the
/// brain is then rebuilt).
fn run(brain: &mut Brain, store: &mut SqlStore, job: Job, now: u64) -> StoreResult<String> {
    let json = |value: &dyn erased::Json| value.to_json();
    match job {
        Job::Contribute(c) => {
            let contributor = contributor_id(&c.token);
            json(&brain.contribute(c, &contributor, now, store)?)
        }
        Job::Recall(r) => json(&brain.recall(&r, store)?),
        Job::Stats => json(&brain.stats(now, store)?),
    }
}

mod erased {
    use super::{StoreError, StoreResult};
    /// An answer as JSON (no -0: the brain never produces one).
    pub trait Json {
        fn to_json(&self) -> StoreResult<String>;
    }
    impl<T: serde::Serialize> Json for T {
        fn to_json(&self) -> StoreResult<String> {
            serde_json::to_string(self).map_err(|e| StoreError(e.to_string()))
        }
    }
}

// ─── the SQLite store ────────────────────────────────────────────────────────

struct SqlStore(SqlStorage);

fn sql_error(e: Error) -> StoreError {
    StoreError(format!("sql: {e}"))
}
fn f32_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}
fn f32s(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}
fn text(v: &SqlStorageValue) -> Option<String> {
    match v {
        SqlStorageValue::String(s) => Some(s.clone()),
        _ => None,
    }
}
// A REAL holding a whole number arrives as an integer.
fn real(v: &SqlStorageValue) -> Option<f64> {
    match v {
        SqlStorageValue::Float(x) => Some(*x),
        SqlStorageValue::Integer(i) => Some(*i as f64),
        _ => None,
    }
}
fn int(v: &SqlStorageValue) -> Option<u64> {
    match v {
        SqlStorageValue::Integer(i) if *i >= 0 => Some(*i as u64),
        _ => None,
    }
}
fn blob(v: &SqlStorageValue) -> Option<Vec<f32>> {
    match v {
        SqlStorageValue::Blob(b) if b.len() % 4 == 0 => Some(f32s(b)),
        _ => None,
    }
}

impl SqlStore {
    /// Each row of a query, as it is read (never all of them at once).
    fn each(&self, query: &str, bindings: Vec<SqlStorageValue>, mut f: impl FnMut(Vec<SqlStorageValue>) -> StoreResult<()>) -> StoreResult<()> {
        let bindings = if bindings.is_empty() { None } else { Some(bindings) };
        for row in self.0.exec(query, bindings).map_err(sql_error)?.raw() {
            f(row.map_err(sql_error)?)?;
        }
        Ok(())
    }
    fn run(&self, query: &str, bindings: Vec<SqlStorageValue>) -> StoreResult<()> {
        self.0.exec(query, Some(bindings)).map_err(sql_error)?;
        Ok(())
    }
}

/// Contributor ids in a feedback row: comma-separated 8-digit hex.
fn ids_text(ids: &[u32]) -> String {
    ids.iter().map(|id| format!("{id:08x}")).collect::<Vec<_>>().join(",")
}
fn ids(text: &str) -> Vec<u32> {
    text.split(',').filter_map(|id| u32::from_str_radix(id, 16).ok()).collect()
}

impl Store for SqlStore {
    fn load(&self, since_minute: u64, sink: &mut dyn FnMut(Loaded) -> StoreResult<()>) -> StoreResult<()> {
        self.each("SELECT id, vector, created FROM tracks", vec![], |r| match (text(&r[0]), blob(&r[1]), int(&r[2])) {
            (Some(id), Some(vector), Some(created)) => sink(Loaded::Track(TrackRow { id, vector, created })),
            _ => Ok(()),
        })?;
        self.each("SELECT id, fitness, track, dynamics, meta, contributor, created FROM brains", vec![], |r| {
            match (text(&r[0]), real(&r[1]), text(&r[4]), text(&r[5]), int(&r[6])) {
                (Some(id), Some(fitness), Some(meta), Some(contributor), Some(created)) => {
                    sink(Loaded::Brain(BrainRow { id, fitness, track: text(&r[2]), dynamics: blob(&r[3]), meta, contributor, created }))
                }
                _ => Ok(()),
            }
        })?;
        // The context JSON stays in SQLite: memory keys feedback by its hash.
        self.each("SELECT brain, context_key, weight, count, baseline, contributors, updated FROM feedback ORDER BY brain, updated DESC", vec![], |r| {
            match (text(&r[0]), text(&r[1]), real(&r[2]), int(&r[3]), text(&r[5]), int(&r[6])) {
                (Some(brain), Some(context_key), Some(weight), Some(count), Some(contributors), Some(updated)) => sink(Loaded::Feedback(FeedbackRow {
                    brain,
                    context_key,
                    context: String::new(),
                    weight,
                    count,
                    baseline: real(&r[4]),
                    contributors: ids(&contributors),
                    updated,
                })),
                _ => Ok(()),
            }
        })?;
        self.each("SELECT minute, count FROM contribution_minutes WHERE minute > ?", vec![(since_minute as i64).into()], |r| match (int(&r[0]), int(&r[1])) {
            (Some(minute), Some(count)) => sink(Loaded::Minute(minute, count)),
            _ => Ok(()),
        })
    }
    fn put_track(&mut self, row: &TrackRow) -> StoreResult<()> {
        self.run(
            "INSERT OR REPLACE INTO tracks (id, vector, created) VALUES (?, ?, ?)",
            vec![row.id.as_str().into(), f32_bytes(&row.vector).into(), (row.created as i64).into()],
        )
    }
    fn delete_track(&mut self, id: &str) -> StoreResult<()> {
        self.run("DELETE FROM tracks WHERE id = ?", vec![id.into()])
    }
    fn put_brain(&mut self, row: &BrainRow, vector: &[f32]) -> StoreResult<()> {
        self.run(
            // A brain the brain holds is never put again; a row that did not
            // load (and was deleted) is replaced, as in MemStore.
            "INSERT OR REPLACE INTO brains (id, vector, fitness, track, dynamics, meta, contributor, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            vec![
                row.id.as_str().into(),
                f32_bytes(vector).into(),
                row.fitness.into(),
                row.track.as_deref().map_or(SqlStorageValue::Null, Into::into),
                row.dynamics.as_deref().map_or(SqlStorageValue::Null, |d| f32_bytes(d).into()),
                row.meta.as_str().into(),
                row.contributor.as_str().into(),
                (row.created as i64).into(),
            ],
        )
    }
    fn delete_brain(&mut self, id: &str) -> StoreResult<()> {
        self.run("DELETE FROM brains WHERE id = ?", vec![id.into()])?;
        self.run("DELETE FROM feedback WHERE brain = ?", vec![id.into()])
    }
    fn put_feedback(&mut self, row: &FeedbackRow) -> StoreResult<()> {
        self.run(
            "INSERT OR REPLACE INTO feedback (brain, context_key, context, weight, count, baseline, contributors, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            vec![
                row.brain.as_str().into(),
                row.context_key.as_str().into(),
                row.context.as_str().into(),
                row.weight.into(),
                (row.count as i64).into(),
                row.baseline.map_or(SqlStorageValue::Null, Into::into),
                ids_text(&row.contributors).into(),
                (row.updated as i64).into(),
            ],
        )
    }
    fn delete_feedback(&mut self, brain: &str, context_key: &str) -> StoreResult<()> {
        self.run("DELETE FROM feedback WHERE brain = ? AND context_key = ?", vec![brain.into(), context_key.into()])
    }
    fn count_contribution(&mut self, minute: u64, prune_minute: u64, contributor: &str, at: u64) -> StoreResult<()> {
        self.run(
            "INSERT INTO contribution_minutes (minute, count) VALUES (?, 1) ON CONFLICT (minute) DO UPDATE SET count = count + 1",
            vec![(minute as i64).into()],
        )?;
        self.run("DELETE FROM contribution_minutes WHERE minute <= ?", vec![(prune_minute as i64).into()])?;
        self.run(
            "INSERT INTO contributors (id, first_seen, last_seen) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen",
            vec![contributor.into(), (at as i64).into(), (at as i64).into()],
        )
    }
    fn contributors_since(&self, since: u64) -> StoreResult<usize> {
        let mut count = 0;
        self.each("SELECT COUNT(*) FROM contributors WHERE last_seen >= ?", vec![(since as i64).into()], |r| {
            count = int(&r[0]).unwrap_or(0) as usize;
            Ok(())
        })?;
        Ok(count)
    }
    fn brain_rows(&self, ids: &[&str]) -> StoreResult<Vec<Option<StoredBrain>>> {
        let mut found = std::collections::HashMap::new();
        for chunk in ids.chunks(32) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let bindings = chunk.iter().map(|id| (*id).into()).collect();
            self.each(&format!("SELECT id, vector, meta FROM brains WHERE id IN ({marks})"), bindings, |r| {
                if let (Some(id), Some(vector), Some(meta)) = (text(&r[0]), blob(&r[1]), text(&r[2])) {
                    found.insert(id, (vector, meta));
                }
                Ok(())
            })?;
        }
        Ok(ids.iter().map(|id| found.remove(*id)).collect())
    }
}

#[cfg(feature = "spike")]
mod spike {
    //! CB0 measurement routes. Not in a deployed build.
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize, Serialize)]
    struct Row {
        key: String,
        value: String,
    }

    pub async fn route(state: &State, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        let query = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
        let sql = state.storage().sql();
        // Spike rows live in their own table, never in `meta`.
        sql.exec("CREATE TABLE IF NOT EXISTS spike_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)", None)?;
        match (req.method(), url.path()) {
            // SQL round trip: write a row, read it back (also after a restart).
            (Method::Post, "/spike/sql") => {
                let row: Row = req.json().await?;
                sql.exec("INSERT OR REPLACE INTO spike_kv (key, value) VALUES (?, ?)", vec![row.key.clone().into(), row.value.clone().into()])?;
                Response::from_json(&row)
            }
            (Method::Get, "/spike/sql") => {
                let key = query("key").unwrap_or_default();
                let rows: Vec<Row> = sql.exec("SELECT key, value FROM spike_kv WHERE key = ?", vec![key.into()])?.to_array()?;
                match rows.into_iter().next() {
                    Some(row) => Response::from_json(&row),
                    None => Response::error("Not found", 404),
                }
            }
            // What a panic does to later requests. On Emscripten a Rust panic
            // unwinds by default (Wasm exception handling); it does not abort.
            (Method::Get, "/spike/panic") => panic!("spike: deliberate panic"),
            // The module's Wasm memory, in bytes: a high-water mark (it never
            // shrinks), not what is in use now.
            (Method::Get, "/spike/memory") => Response::from_json(&serde_json::json!({"bytes": memory_bytes()})),
            // n random 244-float brains in a flat array, then q exhaustive
            // cosine searches (generation plus search; no SQLite read and no
            // index structure). A compute benchmark, without ruvector.
            (Method::Post, "/spike/index") => {
                let n: usize = query("n").and_then(|v| v.parse().ok()).unwrap_or(20_000).min(100_000);
                let q: usize = query("q").and_then(|v| v.parse().ok()).unwrap_or(10).min(1000);
                let (checksum, top) = flat_index(n, 244, q);
                Response::from_json(&serde_json::json!({
                    "n": n, "dim": 244, "queries": q, "checksum": checksum, "top": top, "bytes": memory_bytes(),
                }))
            }
            _ => Response::error("Not found", 404),
        }
    }

    pub fn memory_bytes() -> usize {
        #[cfg(target_arch = "wasm32")]
        {
            core::arch::wasm32::memory_size(0) * 65_536
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            0
        }
    }

    /// n unit vectors of `dim` from a fixed xorshift stream, then q exact
    /// cosine searches over all of them. Returns a checksum (so the work is
    /// not optimised away) and the best index of the last query.
    fn flat_index(n: usize, dim: usize, q: usize) -> (f64, usize) {
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f32 / (1u64 << 53) as f32 * 2.0 - 1.0
        };
        let mut data = vec![0f32; n * dim];
        for row in data.chunks_mut(dim) {
            let mut norm = 0f32;
            for x in row.iter_mut() {
                *x = next();
                norm += *x * *x;
            }
            let inv = 1.0 / norm.sqrt().max(1e-12);
            row.iter_mut().for_each(|x| *x *= inv);
        }
        let mut checksum = 0f64;
        let mut best = 0usize;
        for _ in 0..q {
            let query: Vec<f32> = (0..dim).map(|_| next()).collect();
            let mut best_score = f32::MIN;
            for (i, row) in data.chunks(dim).enumerate() {
                let score: f32 = row.iter().zip(&query).map(|(a, b)| a * b).sum();
                if score > best_score {
                    best_score = score;
                    best = i;
                }
            }
            checksum += best_score as f64;
        }
        (checksum, best)
    }
}
