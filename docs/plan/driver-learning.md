# Driver profiles and learning

Open **Driver profile · Balanced**, next to **AI driving**, in either 2D or Circuit Studio. Choose a style for the AI population and the player's optional AI co-driver. Selecting a style before Start does not start the simulation. Selecting it during training starts a new generation. The profile and adaptive-exploration preference survive reload; AI driving, multiplayer, sound, and 3D remain opt-in.

Adaptive exploration is **off for new visitors**. A controlled 90-run experiment found mixed results, so it remains an explicit experiment. Champion preservation, context-aware memory, and actual offspring feedback operate with either setting. See [the measured results](learning-proof/README.md).

| Profile | Driving decisions | Training preference within a checkpoint tie |
| --- | --- | --- |
| Balanced | Original neural policy, with no speed or braking filter | Original ordering |
| Calm | Reduced cruise and corner speeds, early braking, damped rapid opposite turns | Smoothness and fewer slides |
| Careful | Lower speed and larger stopping margin | Survival and clearance from walls |
| Wild | Fast cornering and late braking | Speed with some survival preference |
| Reckless | No braking filter and larger mutation steps | Speed with little survival preference |

Profiles do not change the car's maximum speed, acceleration, traction, collision rules, or multiplayer clock. A/D override the entire AI steering axis; W/S override the throttle/braking axis. Releasing keys returns that axis to AI. The network still decides where to drive. Profiles do not guarantee a clean lap.

## Learning loop

1. Retrieve networks from the existing ruvector archive. Matching profile, track geometry, vehicle physics, and generation duration receive preference. Legacy and transfer candidates remain usable and are labeled as unverified or transferred.
2. Remove exact duplicate seeds and apply a small diversity preference to avoid filling the seed pool with nearly identical networks.
3. Preserve the best evaluated driver exactly when the population has at least two cars. Fill other slots with light/heavy mutations and new random drivers. One-car training tests successive challengers while retaining its champion separately.
4. With adaptive exploration enabled, refine after progress, increase variation after five stalled generations, and introduce more fresh drivers after ten. The base mutation slider remains meaningful. Disabling adaptation fixes the exploration schedule; profiles still set their risk preference.
5. Track each car's actual seed parent. Credit a memory from its own mutated descendants' average progress, including negative outcomes. Exact elite copies are excluded from feedback. A transfer from different conditions establishes a local baseline before receiving an improvement score.
6. Archive the selected network with its context, style score, and driving statistics. Lineage records its actual parent instead of every retrieved candidate.

Checkpoint progress remains the primary selection objective. Style contributes less than one checkpoint and never rewards a car that has made no progress. Balanced keeps the original checkpoint ordering. This avoids introducing the unconditional speed reward that previously regressed the Triangle track; see `ruvector-proof/f1-fitness-shaping/PROOF.md`.

The best evaluated networks are kept in a bounded 20-entry local startup cache, scoped to the complete training context. The full IndexedDB archive is retained. Manual named-brain loads override the cache. Start Fresh and benchmark resets clear the cache alongside trained state. Profile metadata and feedback baselines survive archive export/import; profile context also travels with opt-in cross-tab brain sharing.

Content-deduplicated networks keep up to 20 separate context evaluations. Reusing one genome as a Careful and Wild driver therefore preserves both measured results. Retrieval and feedback select the relevant evaluation. Re-archiving an unchanged elite neither adds a self-parent lineage edge nor duplicates its insertion-order entry. Descendant feedback is applied before the current generation updates its parent evaluation.

## What the learning panel shows

- Current exploration stage and effective mutation rate.
- Best checkpoint progress, latest generation survival, and the last 20 generations' progress.
- Counts of memory-derived, saved, and fresh drivers.
- The top recalled memories with an explanation of how their conditions match.
- A manual memory-review button and automatic SONA consolidation every eight generations.

SONA buffers are bounded to 128 steps. Zero-checkpoint fitness has zero quality; it is not treated as a successful example. Periodic consolidation means patterns can form during a long unattended session instead of waiting until the user leaves the track.

A bounded journal retains up to 32 successful circuit embeddings in the existing IndexedDB adapter snapshot. On reload they are replayed through SONA to relearn patterns. It validates dimensions, finite values, and minimum quality; duplicate circuits retain their best quality. The panel reports saved and replayed examples. This is example replay, not an exact restoration of the agent's optimizer or EWC state, and it does not reapply MicroLoRA rewards.

The A/B baseline now uses a real genetic loop with the same profile, initialization, mutation policy, and elite preservation, without vector retrieval. Previously it generated a completely random population every generation. A single visual comparison is still not statistical proof of a universal learning improvement.

## Verification

`npm run test:learning` checks profile control behavior, manual priority, actual car physics, checkpoint-dominant selection, small populations, champion preservation, plateau recovery, context changes, diverse retrieval, feedback, and SONA quality. `npm run test:learning:browser` uses the real worker and vendored WASM to check profile changes, persistence, actual offspring feedback, A/B evolution, contextual retrieval, archive round trips, cross-tab metadata, and desktop/mobile controls in both views.

The existing graphics, multiplayer, and contrast checks continue to run. The contrast suite includes the new profile panel in 2D and 3D.

A regression test covers stopping mid-drift while holding steering. The former zero-vector normalization divided by zero and could poison positions, sensors, and replay samples; it now keeps a finite stopped car.

## Further work and current binding limits

- [Trainable GNN bindings](https://github.com/shaal/VrumVector/issues/10): the current WASM layer exposes forward inference, but not weight training or checkpoint APIs. Outcome feedback now affects ranking alongside the structural GNN; it does not train the GNN's weights.
- [Exact SONA/EWC restoration](https://github.com/shaal/VrumVector/issues/11): the ephemeral agent can export, but its browser API cannot restore an exact checkpoint. MicroLoRA and driving networks persist; exact ephemeral-agent state needs an upstream binding change.
- **Mixed-style rival grids:** run separate small populations and champions per profile, then race their leaders together. This preserves each profile's learning goal while making the opposition more varied.
- **Multi-track curriculum:** alternate simple turns and complex circuits, with a held-out evaluation before replacing a champion. Retain a previous champion when transfer harms an already learned track.
- **Sector practice:** use the existing crash-map vectors to identify repeated trouble spots, show them to the player, and train those sections before returning to a full lap.
- **Style demonstration replays:** show the same starting network in each profile so speed and braking differences are easy to compare.
- **Opt-in human demonstrations:** collect sensor/action examples only while a player deliberately teaches; evaluate any imitation-trained network alongside the existing champion before promoting it.

These follow-ups need controlled experiments before claiming better transfer or faster learning.

Upstream reference: [RuVector](https://github.com/ruvnet/ruvector). Runtime integration targets the checked-in browser WASM binaries and their type declarations.
