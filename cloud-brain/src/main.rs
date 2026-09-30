//! VectorVroom's cloud brain: one shared vector memory in a SQLite-backed
//! Durable Object (docs/plan/cloud-brain.md). Built for
//! `wasm32-unknown-emscripten` with `worker-build --emscripten`, which links a
//! bin crate: `main()` runs on module init and does nothing.
//!
//! CB0 (the toolchain spike) has only the skeleton: the front door, the
//! object, its schema, and `/health`. The `spike` feature adds the routes the
//! spike measures with (a SQL round trip, a panic, an index build).

use serde::Serialize;
use worker::*;

fn main() {}

/// One brain for everyone: every request goes to the object with this name.
const BRAIN_NAME: &str = "vectorvroom-shared-brain-v1";
/// Wire protocol of the HTTP API.
const PROTOCOL: u32 = 1;

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
        target: if cfg!(target_os = "emscripten") {
            "wasm32-unknown-emscripten"
        } else {
            "wasm32-unknown-unknown"
        },
        ruvector: None,
        spike: cfg!(feature = "spike"),
    }
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let stub = env.durable_object("BRAIN")?.get_by_name(BRAIN_NAME)?;
    stub.fetch_with_request(req).await
}

#[durable_object]
pub struct SharedBrain {
    #[cfg_attr(not(feature = "spike"), allow(dead_code))]
    state: State,
    /// Why the schema could not be set up, if it could not: the object then
    /// answers 503 rather than serving from a half-made database.
    init_error: Option<String>,
    /// The spike routes also need the variable CLOUD_BRAIN_SPIKE=1 (the spike
    /// test passes it to `wrangler dev`), so a spike build that reaches a
    /// deploy by mistake still serves them to nobody.
    #[cfg_attr(not(feature = "spike"), allow(dead_code))]
    spike_enabled: bool,
}

/// Version of this object's SQL schema (`meta.sql_schema`). The brain format
/// the browser speaks (BRAIN_SCHEMA_VERSION) is a separate number.
const SQL_SCHEMA: &str = "1";

fn init_schema(state: &State) -> Result<()> {
    let sql = state.storage().sql();
    sql.exec(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        None,
    )?;
    sql.exec(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('sql_schema', ?)",
        vec![SQL_SCHEMA.into()],
    )?;
    Ok(())
}

impl DurableObject for SharedBrain {
    fn new(state: State, env: Env) -> Self {
        // Schema before any request.
        let init_error = init_schema(&state).err().map(|e| e.to_string());
        let spike_enabled = env
            .var("CLOUD_BRAIN_SPIKE")
            .map(|v| v.to_string() == "1")
            .unwrap_or(false);
        Self { state, init_error, spike_enabled }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        if let Some(error) = &self.init_error {
            return Response::error(format!("Brain unavailable: {error}"), 503);
        }
        let url = req.url()?;
        match (req.method(), url.path()) {
            (Method::Get, "/health") => Response::from_json(&Health {
                ok: true,
                protocol: PROTOCOL,
                brain: true,
                build: build(),
            }),
            #[cfg(feature = "spike")]
            _ if self.spike_enabled => spike::route(&self.state, req).await,
            #[cfg(feature = "spike")]
            _ => Response::error("Not found", 404),
            #[cfg(not(feature = "spike"))]
            _ => Response::error("Not found", 404),
        }
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
        let query = |name: &str| {
            url.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        };
        let sql = state.storage().sql();
        // Spike rows live in their own table, never in `meta`.
        sql.exec(
            "CREATE TABLE IF NOT EXISTS spike_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            None,
        )?;
        match (req.method(), url.path()) {
            // SQL round trip: write a row, read it back (also after a restart).
            (Method::Post, "/spike/sql") => {
                let row: Row = req.json().await?;
                sql.exec(
                    "INSERT OR REPLACE INTO spike_kv (key, value) VALUES (?, ?)",
                    vec![row.key.clone().into(), row.value.clone().into()],
                )?;
                Response::from_json(&row)
            }
            (Method::Get, "/spike/sql") => {
                let key = query("key").unwrap_or_default();
                let rows: Vec<Row> = sql
                    .exec("SELECT key, value FROM spike_kv WHERE key = ?", vec![key.into()])?
                    .to_array()?;
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
            (Method::Get, "/spike/memory") => Response::from_json(&serde_json::json!({
                "bytes": memory_bytes(),
            })),
            // n random 244-float brains in a flat array, then q exhaustive
            // cosine searches (generation plus search; no SQLite read and no
            // index structure). A compute benchmark, without ruvector.
            (Method::Post, "/spike/index") => {
                let n: usize = query("n").and_then(|v| v.parse().ok()).unwrap_or(20_000).min(100_000);
                let q: usize = query("q").and_then(|v| v.parse().ok()).unwrap_or(10).min(1000);
                let (checksum, top) = flat_index(n, 244, q);
                Response::from_json(&serde_json::json!({
                    "n": n, "dim": 244, "queries": q, "checksum": checksum, "top": top,
                    "bytes": memory_bytes(),
                }))
            }
            _ => Response::error("Not found", 404),
        }
    }

    fn memory_bytes() -> usize {
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
