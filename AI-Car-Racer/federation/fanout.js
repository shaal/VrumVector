// federation/fanout.js — Phase 2A (F2)
//
// Parallel fan-out across S shards. Each shard is a {name, db, metric} entry
// where `db` implements the slice of the VectorDB / HyperbolicVectorDB surface
// the bridge already uses (search(queryVec, k) → [{id, score, ...}, ...]).
//
// Over-request formula (per plan / paper):
//     k' = k + ⌈√(k · ln S)⌉
//
// Rationale: with S independent indexes each returning their own top-k', the
// probability that the global top-k all surface in the union is high enough
// that a subsequent rerank over the union matches single-index quality. The
// extra √(k ln S) term is the classical union-bound slack.
//
// API:
//   fanOut(queryVec, k, shards) → Promise<[{name, kPrime, results: [{id, score, ...}]}]>
//
// We accept a single queryVec (the bridge only ever has one at a time after
// LoRA adapt). Each shard search is kicked off synchronously then awaited via
// Promise.all — even though the underlying search calls are synchronous today
// (both the Euclidean VectorDB and the HyperbolicVectorDB hand back sync
// arrays), we stay async to leave room for a future worker-backed index.
//
// Failure mode: a single shard throwing does NOT take the whole fan-out down.
// We catch per-shard, log, and yield an empty result for that shard so the
// bridge's union path still produces something drawn from the surviving
// shards. This keeps federation graceful when e.g. the hyperbolic adapter
// hits a NaN on a pathological vector.

export function kPrime(k, shardCount) {
  const kk = Math.max(1, k | 0);
  const S = Math.max(1, shardCount | 0);
  if (S <= 1) return kk;
  return kk + Math.ceil(Math.sqrt(kk * Math.log(S)));
}

export async function fanOut(queryVec, k, shards) {
  if (!Array.isArray(shards) || shards.length === 0) return [];
  const kk = Math.max(1, k | 0);
  const S = shards.length;
  const kp = kPrime(kk, S);
  const promises = shards.map(async (shard) => {
    const name = (shard && shard.name) || 'shard';
    try {
      if (!shard || !shard.db || typeof shard.db.search !== 'function') {
        return { name, kPrime: kp, results: [] };
      }
      // The underlying search is synchronous; await still resolves fine.
      const hits = shard.db.search(queryVec, kp) || [];
      return { name, kPrime: kp, results: hits };
    } catch (e) {
      console.warn('[federation/fanout] shard "' + name + '" failed:', e);
      return { name, kPrime: kp, results: [], error: String(e && e.message || e) };
    }
  });
  return Promise.all(promises);
}

// Synchronous sibling. Today's shard backends (VectorDB, HyperbolicVectorDB)
// are both sync, and seed ranking is called in hot paths (GA seed buffer
// construction, the rv-panel's previewSeeds poll) that already expect sync. We keep the async
// fanOut as the contract surface for future worker-backed indexes, and use
// this sync variant internally. The two share kPrime() so the over-request
// math is identical.
export function fanOutSync(queryVec, k, shards) {
  if (!Array.isArray(shards) || shards.length === 0) return [];
  const kk = Math.max(1, k | 0);
  const S = shards.length;
  const kp = kPrime(kk, S);
  const out = [];
  for (const shard of shards) {
    const name = (shard && shard.name) || 'shard';
    try {
      if (!shard || !shard.db || typeof shard.db.search !== 'function') {
        out.push({ name, kPrime: kp, results: [] });
        continue;
      }
      const hits = shard.db.search(queryVec, kp) || [];
      out.push({ name, kPrime: kp, results: hits });
    } catch (e) {
      console.warn('[federation/fanout] shard "' + name + '" failed:', e);
      out.push({ name, kPrime: kp, results: [], error: String(e && e.message || e) });
    }
  }
  return out;
}
