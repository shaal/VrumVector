//! VectorVroom's cloud brain: one shared vector memory in a SQLite-backed
//! Durable Object (docs/plan/cloud-brain.md). Built for
//! `wasm32-unknown-emscripten` with `worker-build --emscripten`, which links a
//! bin crate: `main()` runs on module init and does nothing (the brain is
//! built by the object, never at module scope).
//!
//! The front door (`fetch`) answers what needs no brain: the breaker
//! (DISABLE_BRAIN), origins and CORS, the per-address rate limits (the Rate
//! Limiting binding: the address is a key, never stored), the body limit,
//! and unknown routes. The object (`SharedBrain`) parses, holds the brain
//! and its SQLite store, and counts each contributor's daily quota. The
//! service logic is the `brain` crate (core/), tested natively.

use brain::brain::{
    contributor_id, parse_slots, resolve_ids, slots_text, Brain, BrainRow, Config, FeedbackRow, Limited, Loaded, Page, Refusal, Result as StoreResult,
    Slot, Store, StoreError, StoredBrain, TrackRow, Training, Usage, VerifiedRow, CrashRow,
};
use brain::wire::{self, error_body, CrashLayout, Reason};
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
    /// Every per-address rate limiter is bound (CB4): without them the
    /// front door lets every request through (CB5's health check asks).
    limits: bool,
    /// Cloud training is on (X2: TRAIN_FRAMES set).
    training: bool,
    build: Build,
}

#[derive(Serialize)]
struct Build {
    target: &'static str,
    ruvector: Option<&'static str>,
    spike: bool,
    /// The commit deployed (CB5: deploy.yml sets CLOUD_BRAIN_COMMIT, and its
    /// health check waits for this version to answer); null in a local build.
    commit: Option<&'static str>,
}

fn build() -> Build {
    Build {
        target: if cfg!(target_os = "emscripten") { "wasm32-unknown-emscripten" } else { "wasm32-unknown-unknown" },
        ruvector: Some(RUVECTOR),
        spike: cfg!(feature = "spike"),
        commit: option_env!("CLOUD_BRAIN_COMMIT"),
    }
}

/// A variable as text. `wrangler dev --var` passes strings; `vars` in
/// wrangler.jsonc keep their JSON type, so a number or a boolean is read too.
fn var_text(env: &Env, name: &str) -> Option<String> {
    let value = js_sys::Reflect::get(env, &wasm_bindgen::JsValue::from(name)).ok()?;
    if let Some(text) = value.as_string() {
        return Some(text.trim().to_string());
    }
    if let Some(number) = value.as_f64() {
        return Some(number.to_string());
    }
    value.as_bool().map(|b| b.to_string())
}

fn flag(env: &Env, name: &str) -> bool {
    var_text(env, name).as_deref() == Some("true")
}

/// A whole-number variable, or `default` (said in the log when it is set
/// but is not one).
fn number(env: &Env, name: &str, default: u64) -> u64 {
    match var_text(env, name) {
        None => default,
        Some(text) => text.parse().unwrap_or_else(|_| {
            console_error!("cloud brain: {name}={text:?} is not a whole number; using {default}");
            default
        }),
    }
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
    // A 429's Retry-After, readable by the page.
    headers.set("Access-Control-Expose-Headers", "Retry-After")?;
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

/// 429 `rate-limited`, and when to try again.
fn limited_response(retry_after: u64) -> Result<Response> {
    let mut response = error_response(Reason::RateLimited)?;
    response.headers_mut().set("Retry-After", &retry_after.to_string())?;
    Ok(response)
}

/// The address a request is counted under: the one Cloudflare saw
/// (`CF-Connecting-IP`), an IPv6 one by its /64 (one host holds a whole /64).
fn address_key(req: &Request) -> String {
    let raw = req.headers().get("CF-Connecting-IP").ok().flatten().unwrap_or_default();
    match raw.trim().parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
        Ok(std::net::IpAddr::V4(v4)) => v4.to_string(),
        Err(_) => raw,
    }
}

/// The per-address limits (wrangler.jsonc `ratelimits`, 60-second windows):
/// contributions, forgets, and recalls, stats and health checks. The key
/// is `address_key`, used for this count and never stored. Without the
/// binding (a misconfiguration: /health says `limits: false`) or when it
/// fails, the request goes on: the per-token quotas in the object still hold.
async fn over_rate_limit(env: &Env, binding: &str, req: &Request) -> bool {
    let address = address_key(req);
    let limiter = match env.rate_limiter(binding) {
        Ok(limiter) => limiter,
        Err(e) => {
            console_error!("cloud brain: no rate limiter {binding}: {e}");
            return false;
        }
    };
    match limiter.limit(address).await {
        Ok(outcome) => !outcome.success,
        Err(e) => {
            console_error!("cloud brain: rate limiter {binding}: {e}");
            false
        }
    }
}
/// The window the limits count in (seconds): a refused page may try again after it.
const RATE_WINDOW_S: u64 = 60;

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
        // It reaches the object: counted with the reads.
        if over_rate_limit(&env, "READ_LIMIT", &req).await {
            return limited_response(RATE_WINDOW_S);
        }
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
    let limiter = match (&method, path.as_str()) {
        (Method::Post, "/v1/contribute" | "/v1/crashes") => "WRITE_LIMIT",
        // A forget can read every feedback record: a few a minute.
        (Method::Post, "/v1/forget") => "FORGET_LIMIT",
        // A verification runs the simulator (up to 7 200 frames).
        (Method::Post, "/v1/verify") => "VERIFY_LIMIT",
        (Method::Post, "/v1/recall" | "/v1/crashes/recall") | (Method::Get, "/v1/stats" | "/v1/leaderboard") => "READ_LIMIT",
        _ => return with_cors(Response::error("Not found", 404)?, cors),
    };
    if over_rate_limit(&env, limiter, &req).await {
        return with_cors(limited_response(RATE_WINDOW_S)?, cors);
    }
    let forwarded = match (method, path.as_str()) {
        (Method::Post, "/v1/recall" | "/v1/contribute" | "/v1/forget" | "/v1/verify" | "/v1/crashes" | "/v1/crashes/recall") => match capped_body(&mut req, wire::limits::REQUEST_BYTES).await {
            Ok(None) => return with_cors(error_response(Reason::BodyTooLarge)?, cors),
            Ok(Some(body)) => {
                let mut init = RequestInit::new();
                init.with_method(Method::Post).with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
                match (stub(), Request::new_with_init(url.as_str(), &init)) {
                    (Ok(stub), Ok(inner)) => stub.fetch_with_request(inner).await,
                    (Err(e), _) | (_, Err(e)) => Err(e),
                }
            }
            // The body could not be read (the page went away mid-send).
            Err(e) => Err(e),
        },
        (Method::Get, "/v1/stats" | "/v1/leaderboard") => match stub() {
            Ok(stub) => stub.fetch_with_request(req).await,
            Err(e) => Err(e),
        },
        _ => return with_cors(Response::error("Not found", 404)?, cors),
    };
    // The object threw (a panic, a reset, an overload), or the body could
    // not be read: the page still gets an answer it can read.
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
    /// Every rate limiter is bound (reported by /health).
    limits: bool,
    /// Built on the first request that needs it, from SQLite, with no await
    /// in between: no other request runs until it is built (the effect of
    /// blockConcurrencyWhile). A request takes it out and puts it back only
    /// when it succeeds: after a store error or a panic the slot is empty,
    /// and the next request rebuilds it from what SQLite holds (so the
    /// assertion of unwind safety holds).
    brain: AssertUnwindSafe<RefCell<Option<Brain>>>,
    /// Sizes, trust and quotas (the quotas can be set with QUOTA_REQUESTS,
    /// QUOTA_BRAINS and QUOTA_FEEDBACK).
    config: Config,
    /// The spike routes also need the variable CLOUD_BRAIN_SPIKE=1 (the spike
    /// test passes it to `wrangler dev`), so a spike build that reaches a
    /// deploy by mistake still serves them to nobody.
    #[cfg_attr(not(feature = "spike"), allow(dead_code))]
    spike_enabled: bool,
    /// Cloud training (X2): a session's budget and how often one runs (ms),
    /// when TRAIN_FRAMES is set (off by default: its CPU is the plan's to
    /// choose, D2).
    training: Option<(Training, i64)>,
    /// The training alarm is known to be set (checked once an instance; a
    /// flag a panic cannot leave half-written).
    alarm_checked: AssertUnwindSafe<std::cell::Cell<bool>>,
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
    // 2 (CB4): feedback per contributor, daily quotas, forget. Nothing was
    // deployed at schema 1, so its feedback (one weight for everyone) and
    // its contributors (no quota counts) start over; each statement can
    // run again (a migration cut short runs before any request).
    &[
        "DELETE FROM feedback",
        "DROP TABLE IF EXISTS contributors",
        "CREATE TABLE IF NOT EXISTS contributors (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, \
         day INTEGER NOT NULL, requests INTEGER NOT NULL, brains INTEGER NOT NULL, feedback INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS contributors_last_seen ON contributors (last_seen)",
        "CREATE INDEX IF NOT EXISTS brains_contributor ON brains (contributor)",
    ],
    // 3 (X1): verified runs, the leaderboards read from them, and the
    // geometry each track key is pinned to.
    &[
        "CREATE TABLE IF NOT EXISTS geometries (track TEXT PRIMARY KEY, digest TEXT NOT NULL, created INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS verified (brain TEXT NOT NULL, track TEXT NOT NULL, profile TEXT NOT NULL, max_speed REAL NOT NULL, \
         traction REAL NOT NULL, seconds REAL NOT NULL, fitness REAL NOT NULL, laps INTEGER NOT NULL, lap_frames INTEGER, frames INTEGER NOT NULL, \
         contributor TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (brain, track, profile, max_speed, traction, seconds))",
        "CREATE INDEX IF NOT EXISTS verified_board ON verified (track, max_speed, traction, lap_frames)",
    ],
    // 4 (X4): everyone's crash maps: a contributor's latest a track and
    // collision mode, with the best gate layout they shared there (null
    // columns: none).
    &[
        "CREATE TABLE IF NOT EXISTS crash_maps (track TEXT NOT NULL, mode TEXT NOT NULL, contributor TEXT NOT NULL, map BLOB NOT NULL, \
         deaths INTEGER NOT NULL, geometry TEXT, gates TEXT, survival REAL, updated INTEGER NOT NULL, PRIMARY KEY (track, mode, contributor))",
        "CREATE INDEX IF NOT EXISTS crash_maps_contributor ON crash_maps (contributor)",
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
        let base = Config::default();
        let d = base.quota;
        let quota = Usage {
            requests: number(&env, "QUOTA_REQUESTS", d.requests),
            brains: number(&env, "QUOTA_BRAINS", d.brains),
            feedback: number(&env, "QUOTA_FEEDBACK", d.feedback),
        };
        // Fewer tracks than the default, never more (memory is sized for it).
        let max_tracks = number(&env, "MAX_TRACKS", base.max_tracks as u64).clamp(1, base.max_tracks as u64) as usize;
        let config = Config { quota, max_tracks, ..base };
        let limits = ["WRITE_LIMIT", "READ_LIMIT", "FORGET_LIMIT", "VERIFY_LIMIT"].iter().all(|name| env.rate_limiter(name).is_ok());
        let frames = number(&env, "TRAIN_FRAMES", 0);
        // At most ~1 s of CPU a session, and a session a week at least.
        let frames = frames.min(TRAIN_FRAMES_MAX);
        let training = (frames > 0).then(|| {
            let t = Training { frames, idle_minutes: number(&env, "TRAIN_IDLE_MINUTES", 10).min(10_080) };
            (t, number(&env, "TRAIN_EVERY_SECONDS", 1_800).clamp(1, 604_800) as i64 * 1_000)
        });
        Self {
            state,
            init_error,
            disabled: flag(&env, "DISABLE_BRAIN"),
            limits,
            brain: AssertUnwindSafe(RefCell::new(None)),
            config,
            spike_enabled,
            training,
            alarm_checked: AssertUnwindSafe(std::cell::Cell::new(false)),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        if let (Method::Get, "/health") = (req.method(), url.path()) {
            return Response::from_json(&Health {
                ok: self.init_error.is_none(),
                protocol: wire::PROTOCOL,
                brain: !self.disabled,
                limits: self.limits,
                training: self.training.is_some(),
                build: build(),
            });
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
            (Method::Post, "/v1/forget") => Route::Forget,
            (Method::Post, "/v1/verify") => Route::Verify,
            (Method::Get, "/v1/stats") => Route::Stats,
            (Method::Get, "/v1/leaderboard") => Route::Leaderboard,
            (Method::Post, "/v1/crashes") => Route::Crashes,
            (Method::Post, "/v1/crashes/recall") => Route::CrashRecall,
            // Before any body is read or the brain built.
            _ => return Response::error("Not found", 404),
        };
        // The front door checks this too; the object never serves while off.
        if self.disabled {
            return error_response(Reason::Disabled);
        }
        // Cloud training's alarm, once an instance (an alarm set stays set).
        if let Some((_, every)) = self.training.filter(|_| !self.alarm_checked.get()) {
            let storage = self.state.storage();
            if storage.get_alarm().await?.is_none() {
                storage.set_alarm(every).await?;
            }
            self.alarm_checked.set(true);
        }
        // The only await: after it, the request runs to its answer alone.
        // (The front door has already cut the body at 64 KB.)
        let body = if matches!(route, Route::Stats | Route::Leaderboard) { Vec::new() } else { req.bytes().await? };
        // Parsed before the brain is touched: a refused body never builds it.
        let job = match route {
            Route::Contribute => wire::parse_contribute(&body).map(Job::Contribute),
            Route::Recall => wire::parse_recall(&body).map(Job::Recall),
            Route::Forget => wire::parse_forget(&body).map(Job::Forget),
            Route::Verify => wire::parse_verify(&body).map(Job::Verify),
            Route::Stats => Ok(Job::Stats),
            Route::Leaderboard => wire::parse_board(url.query().unwrap_or("")).map(Job::Leaderboard),
            Route::Crashes => wire::parse_crashes(&body).map(Job::Crashes),
            Route::CrashRecall => wire::parse_crash_recall(&body).map(Job::CrashRecall),
        };
        let job = match job {
            Ok(job) => job,
            Err(reason) => return error_response(reason),
        };
        let now = now_ms() as u64;
        let mut store = SqlStore(self.state.storage().sql());
        let result = match self.brain.take() {
            Some(brain) => Ok(brain),
            None => Brain::open(self.config.clone(), &mut store, now),
        }
        .and_then(|mut brain| {
            let answer = run(&mut brain, &mut store, job, now)?;
            self.brain.replace(Some(brain));
            Ok(answer)
        });
        match result {
            Ok(Answer::Json(answer)) => json_response(answer, 200),
            Ok(Answer::Limited(Limited { retry_after })) => limited_response(retry_after),
            Ok(Answer::Refused(reason)) => error_response(reason),
            Err(error) => {
                // The store may hold part of this request: the brain is
                // rebuilt from it on the next request.
                console_error!("cloud brain: {error}");
                error_response(Reason::ServerError)
            }
        }
    }

    /// Cloud training (X2): a session, then the next alarm. Nothing while
    /// paused or without a schema; a store error or a panic empties the
    /// brain (the next request or session rebuilds it from SQLite), and the
    /// schedule goes on.
    async fn alarm(&self) -> Result<Response> {
        let Some((t, every)) = self.training else { return Response::ok("") };
        if !self.disabled && self.init_error.is_none() {
            let started = now_ms();
            match std::panic::catch_unwind(AssertUnwindSafe(|| self.train(t))) {
                Ok(Ok(Some(report))) => console_log!("cloud brain: trained in {} ms: {}", now_ms() - started, serde_json::to_string(&report).unwrap_or_default()),
                Ok(Ok(None)) => {}
                Ok(Err(error)) => console_error!("cloud brain: training: {error}"),
                Err(_) => console_error!("cloud brain: training panicked"),
            }
        }
        self.state.storage().set_alarm(every).await?;
        Response::ok("")
    }
}

/// Frames a training session may drive at most (~1 s natively).
const TRAIN_FRAMES_MAX: u64 = 1_200_000;

impl SharedBrain {
    /// One training session on the brain (built if it is not), or why not.
    /// While someone is playing nothing runs, and a brain not in memory is
    /// not built (a rebuild costs more than a session).
    fn train(&self, t: Training) -> StoreResult<Option<brain::brain::TrainReport>> {
        let now = now_ms() as u64;
        let mut store = SqlStore(self.state.storage().sql());
        if !Brain::idle(t, now, store.last_contribution()?) {
            return Ok(None);
        }
        let mut brain = match self.brain.take() {
            Some(brain) => brain,
            None => Brain::open(self.config.clone(), &mut store, now)?,
        };
        // The session's random numbers come from the time.
        let report = brain.train(t, now, now, &mut store)?;
        self.brain.replace(Some(brain));
        Ok(report)
    }
}

#[derive(PartialEq)]
enum Route {
    Contribute,
    Recall,
    Forget,
    Verify,
    Stats,
    Leaderboard,
    Crashes,
    CrashRecall,
}

/// A parsed request.
enum Job {
    Contribute(wire::Contribution),
    Recall(wire::Recall),
    /// The token.
    Forget(String),
    Verify(wire::Verify),
    Stats,
    Leaderboard(wire::Board),
    Crashes(wire::Crashes),
    CrashRecall(wire::CrashRecall),
}

enum Answer {
    Json(String),
    /// Past the contributor's daily quota.
    Limited(Limited),
    /// Refused by the service (a verification of a brain it does not hold).
    Refused(Reason),
}

/// A job against the brain: its answer, or the store's error (the brain is
/// then rebuilt).
fn run(brain: &mut Brain, store: &mut SqlStore, job: Job, now: u64) -> StoreResult<Answer> {
    let json = |value: &dyn erased::Json| value.to_json().map(Answer::Json);
    match job {
        Job::Contribute(c) => {
            let contributor = contributor_id(&c.token);
            match brain.contribute(c, &contributor, now, store)? {
                Ok(answer) => json(&answer),
                Err(limited) => Ok(Answer::Limited(limited)),
            }
        }
        Job::Recall(r) => json(&brain.recall(&r, store)?),
        Job::Forget(token) => json(&brain.forget(&contributor_id(&token), store)?),
        Job::Verify(v) => {
            let contributor = contributor_id(&v.token);
            match brain.verify(v, &contributor, now, store)? {
                Ok(answer) => json(&answer),
                Err(Refusal::Limited(limited)) => Ok(Answer::Limited(limited)),
                Err(Refusal::Reason(reason)) => Ok(Answer::Refused(reason)),
            }
        }
        Job::Stats => json(&brain.stats(now, store)?),
        Job::Leaderboard(board) => json(&brain.leaderboard(&board, store)?),
        Job::Crashes(c) => {
            let contributor = contributor_id(&c.token);
            match brain.crashes(c, &contributor, now, store)? {
                Ok(answer) => json(&answer),
                Err(limited) => Ok(Answer::Limited(limited)),
            }
        }
        Job::CrashRecall(r) => json(&brain.crash_recall(&r, store)?),
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

const VERIFIED_COLUMNS_QUERY: &str =
    "SELECT brain, track, profile, max_speed, traction, seconds, fitness, laps, lap_frames, frames, contributor, created FROM verified";

/// A `verified` row as VERIFIED_COLUMNS_QUERY reads it.
fn verified_row(r: &[SqlStorageValue]) -> Option<VerifiedRow> {
    Some(VerifiedRow {
        brain: text(&r[0])?,
        track: text(&r[1])?,
        profile: text(&r[2])?,
        max_speed: real(&r[3])?,
        traction: real(&r[4])?,
        seconds: real(&r[5])?,
        fitness: real(&r[6])?,
        laps: int(&r[7])?,
        lap_frames: int(&r[8]),
        frames: int(&r[9])?,
        contributor: text(&r[10])?,
        created: int(&r[11])?,
    })
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
        self.each(VERIFIED_COLUMNS_QUERY, vec![], |r| match verified_row(&r) {
            Some(v) => sink(Loaded::Verified(v)),
            None => Ok(()),
        })?;
        // The context JSON stays in SQLite: memory keys feedback by its hash.
        // Slots that do not read come as none, so the rebuild deletes the row.
        self.each("SELECT brain, context_key, weight, count, contributors, updated FROM feedback ORDER BY brain, updated DESC, context_key", vec![], |r| {
            match (text(&r[0]), text(&r[1]), real(&r[2]), int(&r[3]), text(&r[4]), int(&r[5])) {
                (Some(brain), Some(context_key), Some(weight), Some(count), Some(slots), Some(updated)) => sink(Loaded::Feedback(FeedbackRow {
                    brain,
                    context_key,
                    context: None,
                    weight,
                    count,
                    slots: parse_slots(&slots).unwrap_or_default(),
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
        self.run("DELETE FROM crash_maps WHERE track = ?", vec![id.into()])?;
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
        self.run("DELETE FROM feedback WHERE brain = ?", vec![id.into()])?;
        self.run("DELETE FROM verified WHERE brain = ?", vec![id.into()])
    }
    fn put_feedback(&mut self, row: &FeedbackRow) -> StoreResult<()> {
        // A slot the brain knows by its tag alone keeps the id stored for it.
        let slots = if row.slots.iter().any(|s| s.id.is_empty()) {
            resolve_ids(&row.slots, &self.feedback_slots(&row.brain, &row.context_key)?.unwrap_or_default())?
        } else {
            row.slots.clone()
        };
        // Without a context (forget rewriting a row), the stored one stays.
        // (`baseline`, schema 1's one baseline for everyone, is left empty:
        // each slot has its own.)
        self.run(
            "INSERT INTO feedback (brain, context_key, context, weight, count, baseline, contributors, updated) VALUES (?, ?, ?, ?, ?, NULL, ?, ?) \
             ON CONFLICT (brain, context_key) DO UPDATE SET context = CASE WHEN excluded.context = '' THEN context ELSE excluded.context END, \
             weight = excluded.weight, count = excluded.count, baseline = NULL, contributors = excluded.contributors, updated = excluded.updated",
            vec![
                row.brain.as_str().into(),
                row.context_key.as_str().into(),
                row.context.as_deref().unwrap_or("").into(),
                row.weight.into(),
                (row.count as i64).into(),
                slots_text(&slots).into(),
                (row.updated as i64).into(),
            ],
        )
    }
    fn delete_feedback(&mut self, brain: &str, context_key: &str) -> StoreResult<()> {
        self.run("DELETE FROM feedback WHERE brain = ? AND context_key = ?", vec![brain.into(), context_key.into()])
    }
    fn records_of(&self, contributor: &str, after: Option<&(String, String)>, limit: usize) -> StoreResult<Page> {
        // In key order from `after` (the primary key's): each record is read
        // once over all the pages. The text search finds the candidates; the
        // slots, read, decide.
        let (query, mut bindings): (&str, Vec<SqlStorageValue>) = match after {
            None => ("SELECT brain, context_key, contributors FROM feedback WHERE instr(contributors, ?) > 0 ORDER BY brain, context_key LIMIT ?", vec![]),
            Some((brain, key)) => (
                "SELECT brain, context_key, contributors FROM feedback WHERE (brain, context_key) > (?, ?) AND instr(contributors, ?) > 0 \
                 ORDER BY brain, context_key LIMIT ?",
                vec![brain.as_str().into(), key.as_str().into()],
            ),
        };
        bindings.push(contributor.into());
        bindings.push((limit as i64).into());
        let (mut records, mut read, mut last) = (Vec::new(), 0, None);
        self.each(query, bindings, |r| {
            read += 1;
            if let (Some(brain), Some(key)) = (text(&r[0]), text(&r[1])) {
                if let Some(slots) = text(&r[2]).and_then(|t| parse_slots(&t)).filter(|slots| slots.iter().any(|s| s.id == contributor)) {
                    records.push((brain.clone(), key.clone(), slots));
                }
                last = Some((brain, key));
            }
            Ok(())
        })?;
        // A full page may have more after it.
        Ok((records, if read == limit { last } else { None }))
    }
    fn feedback_slots(&self, brain: &str, context_key: &str) -> StoreResult<Option<Vec<Slot>>> {
        let mut held = None;
        self.each("SELECT contributors FROM feedback WHERE brain = ? AND context_key = ?", vec![brain.into(), context_key.into()], |r| {
            held = text(&r[0]).and_then(|t| parse_slots(&t));
            Ok(())
        })?;
        Ok(held)
    }
    fn count_contribution(&mut self, minute: u64, prune_minute: u64) -> StoreResult<()> {
        self.run(
            "INSERT INTO contribution_minutes (minute, count) VALUES (?, 1) ON CONFLICT (minute) DO UPDATE SET count = count + 1",
            vec![(minute as i64).into()],
        )?;
        self.run("DELETE FROM contribution_minutes WHERE minute <= ?", vec![(prune_minute as i64).into()])
    }
    fn usage(&self, contributor: &str, day: u64) -> StoreResult<Usage> {
        let mut used = Usage::default();
        self.each("SELECT requests, brains, feedback FROM contributors WHERE id = ? AND day = ?", vec![contributor.into(), (day as i64).into()], |r| {
            used = Usage { requests: int(&r[0]).unwrap_or(0), brains: int(&r[1]).unwrap_or(0), feedback: int(&r[2]).unwrap_or(0) };
            Ok(())
        })?;
        Ok(used)
    }
    fn count_usage(&mut self, contributor: &str, day: u64, add: Usage, at: u64, prune_before: u64) -> StoreResult<()> {
        // SET reads the row as it was: a row of another day starts over.
        self.run(
            "INSERT INTO contributors (id, first_seen, last_seen, day, requests, brains, feedback) VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT (id) DO UPDATE SET \
             requests = CASE WHEN day = excluded.day THEN requests + excluded.requests ELSE excluded.requests END, \
             brains = CASE WHEN day = excluded.day THEN brains + excluded.brains ELSE excluded.brains END, \
             feedback = CASE WHEN day = excluded.day THEN feedback + excluded.feedback ELSE excluded.feedback END, \
             day = excluded.day, last_seen = excluded.last_seen",
            vec![
                contributor.into(),
                (at as i64).into(),
                (at as i64).into(),
                (day as i64).into(),
                (add.requests as i64).into(),
                (add.brains as i64).into(),
                (add.feedback as i64).into(),
            ],
        )?;
        self.run("DELETE FROM contributors WHERE last_seen < ?", vec![(prune_before as i64).into()])
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
    fn delete_brains_of(&mut self, contributor: &str) -> StoreResult<Vec<String>> {
        let mut ids = Vec::new();
        self.each("SELECT id FROM brains WHERE contributor = ? ORDER BY id", vec![contributor.into()], |r| {
            ids.extend(text(&r[0]));
            Ok(())
        })?;
        // Their feedback and runs first: the brains alone would still be valid.
        self.run("DELETE FROM feedback WHERE brain IN (SELECT id FROM brains WHERE contributor = ?)", vec![contributor.into()])?;
        self.run("DELETE FROM verified WHERE brain IN (SELECT id FROM brains WHERE contributor = ?)", vec![contributor.into()])?;
        self.run("DELETE FROM brains WHERE contributor = ?", vec![contributor.into()])?;
        Ok(ids)
    }
    fn put_verified(&mut self, v: &VerifiedRow) -> StoreResult<()> {
        self.run(
            "INSERT OR REPLACE INTO verified (brain, track, profile, max_speed, traction, seconds, fitness, laps, lap_frames, frames, contributor, created) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            vec![
                v.brain.as_str().into(),
                v.track.as_str().into(),
                v.profile.as_str().into(),
                v.max_speed.into(),
                v.traction.into(),
                v.seconds.into(),
                v.fitness.into(),
                (v.laps as i64).into(),
                v.lap_frames.map_or(SqlStorageValue::Null, |f| (f as i64).into()),
                (v.frames as i64).into(),
                v.contributor.as_str().into(),
                (v.created as i64).into(),
            ],
        )
    }
    fn delete_verified(&mut self, v: &VerifiedRow) -> StoreResult<()> {
        self.run(
            "DELETE FROM verified WHERE brain = ? AND track = ? AND profile = ? AND max_speed = ? AND traction = ? AND seconds = ?",
            vec![v.brain.as_str().into(), v.track.as_str().into(), v.profile.as_str().into(), v.max_speed.into(), v.traction.into(), v.seconds.into()],
        )
    }
    fn verified_of(&self, brain: &str) -> StoreResult<Vec<VerifiedRow>> {
        let mut rows = Vec::new();
        self.each(&format!("{VERIFIED_COLUMNS_QUERY} WHERE brain = ?"), vec![brain.into()], |r| {
            rows.extend(verified_row(&r));
            Ok(())
        })?;
        Ok(rows)
    }
    fn board(&self, board: &wire::Board, limit: usize) -> StoreResult<Vec<VerifiedRow>> {
        let mut rows = Vec::new();
        self.each(
            &format!(
                "{VERIFIED_COLUMNS_QUERY} WHERE track = ? AND max_speed = ? AND traction = ? AND lap_frames IS NOT NULL \
                 AND brain IN (SELECT id FROM brains) ORDER BY lap_frames, fitness DESC, created, brain LIMIT ?"
            ),
            vec![board.track.as_str().into(), board.max_speed.into(), board.traction.into(), (limit as i64).into()],
            |r| {
                rows.extend(verified_row(&r));
                Ok(())
            },
        )?;
        Ok(rows)
    }
    fn anonymize_verified(&mut self, contributor: &str) -> StoreResult<()> {
        self.run("UPDATE verified SET contributor = '' WHERE contributor = ?", vec![contributor.into()])
    }
    fn pinned(&self, track: &str) -> StoreResult<Option<String>> {
        let mut digest = None;
        self.each("SELECT digest FROM geometries WHERE track = ?", vec![track.into()], |r| {
            if let Some(SqlStorageValue::String(d)) = r.first() {
                digest = Some(d.clone());
            }
            Ok(())
        })?;
        Ok(digest)
    }
    fn pin(&mut self, track: &str, digest: &str, now: u64) -> StoreResult<()> {
        self.run("INSERT OR IGNORE INTO geometries (track, digest, created) VALUES (?, ?, ?)", vec![track.into(), digest.into(), (now as i64).into()])
    }
    fn crashes_of(&self, track: &str, mode: Option<&str>) -> StoreResult<Vec<CrashRow>> {
        let mut rows = Vec::new();
        const COLUMNS: &str = "SELECT track, mode, contributor, map, deaths, geometry, gates, survival, updated FROM crash_maps WHERE track = ?";
        let (query, bindings) = match mode {
            Some(m) => (format!("{COLUMNS} AND mode = ?"), vec![track.into(), m.into()]),
            None => (COLUMNS.to_string(), vec![track.into()]),
        };
        self.each(&query, bindings, |r| {
            if let (Some(track), Some(mode), Some(contributor), Some(map), Some(deaths), Some(updated)) =
                (text(&r[0]), text(&r[1]), text(&r[2]), blob(&r[3]), int(&r[4]), int(&r[8]))
            {
                // A layout reads back whole or not at all.
                let layout = match (text(&r[5]), text(&r[6]).and_then(|g| serde_json::from_str::<Vec<[[f64; 2]; 2]>>(&g).ok()), real(&r[7])) {
                    (Some(geometry), Some(gates), Some(survival)) => Some(CrashLayout { geometry, gates, survival }),
                    _ => None,
                };
                if map.len() == wire::CRASH_DIM {
                    rows.push(CrashRow { track, mode, contributor, map, deaths, layout, updated });
                }
            }
            Ok(())
        })?;
        Ok(rows)
    }
    fn put_crash(&mut self, row: &CrashRow) -> StoreResult<()> {
        let (geometry, gates, survival) = match &row.layout {
            Some(l) => (
                l.geometry.as_str().into(),
                serde_json::to_string(&l.gates).map_err(|e| StoreError(e.to_string()))?.into(),
                l.survival.into(),
            ),
            None => (SqlStorageValue::Null, SqlStorageValue::Null, SqlStorageValue::Null),
        };
        self.run(
            "INSERT OR REPLACE INTO crash_maps (track, mode, contributor, map, deaths, geometry, gates, survival, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            vec![
                row.track.as_str().into(),
                row.mode.as_str().into(),
                row.contributor.as_str().into(),
                f32_bytes(&row.map).into(),
                (row.deaths as i64).into(),
                geometry,
                gates,
                survival,
                (row.updated as i64).into(),
            ],
        )
    }
    fn delete_crash(&mut self, row: &CrashRow) -> StoreResult<()> {
        self.run("DELETE FROM crash_maps WHERE track = ? AND mode = ? AND contributor = ?", vec![row.track.as_str().into(), row.mode.as_str().into(), row.contributor.as_str().into()])
    }
    fn forget_crashes(&mut self, contributor: &str) -> StoreResult<usize> {
        let mut n = 0;
        self.each("SELECT COUNT(*) FROM crash_maps WHERE contributor = ?", vec![contributor.into()], |r| {
            n += r.first().and_then(int).unwrap_or(0) as usize;
            Ok(())
        })?;
        self.run("DELETE FROM crash_maps WHERE contributor = ?", vec![contributor.into()])?;
        Ok(n)
    }
    fn last_contribution(&self) -> StoreResult<Option<u64>> {
        let mut last = None;
        self.each("SELECT MAX(minute) FROM contribution_minutes", vec![], |r| {
            last = r.first().and_then(|v| match v {
                SqlStorageValue::Integer(i) if *i >= 0 => Some(*i as u64),
                SqlStorageValue::Float(x) if *x >= 0.0 => Some(*x as u64),
                _ => None,
            });
            Ok(())
        })?;
        Ok(last)
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
