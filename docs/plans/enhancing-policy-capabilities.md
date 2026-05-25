# Enhancing Policy Capabilities Plan

**Status:** Draft  
**Created:** May 2026  
**Focus:** Improving the core agent architecture to better handle difficult tracks (especially Triangle)  
**Related:** Triangle apex investigations, Vector Memory work, RL mode exploration

## Motivation

Despite significant work on Vector Memory (ruvector seeding, rerankers, adapters, lineage), the Triangle track remains extremely challenging. Many cars still fail to reliably complete laps, particularly around the narrow left apex.

Analysis shows that the current policy architecture has fundamental limitations:

- It is purely reactive (no memory of recent history or internal state).
- It has limited ability to anticipate future states.
- It has relatively low representational capacity.

These constraints make it difficult for the agent to perform the precise, anticipatory control required on geometrically unforgiving tracks like Triangle.

This plan explores adding **memory**, **better anticipation mechanisms**, and **increased capacity** to the policy in a way that remains compatible with the existing Genetic Algorithm training system.

## Current Limitations

The current controller is a small feedforward network with:
- 10 inputs (7 rays + speed + lf + lr)
- 16 hidden units
- 4 outputs (forward, left, right, reverse)

Key weaknesses:
- **No temporal memory**: Every frame is processed independently.
- **Poor anticipation**: The network can only react to current sensor readings.
- **Limited capacity**: The small network struggles to represent complex, multi-phase behaviors (e.g., "approach → brake early → commit to turn → exit cleanly").

These issues are particularly exposed on the Triangle due to:
- The physics horizon problem (sensor range vs. required reaction distance).
- The need for precise timing on a narrow apex.
- The requirement to maintain a committed turning policy over many frames.

## Proposed Directions

We will explore three complementary approaches:

### 1. Adding Memory

**Goal**: Allow the policy to maintain internal state across time steps.

**Options** (in increasing order of complexity):
- Frame stacking (concatenate last N frames of inputs)
- Simple recurrent layer (Elman RNN)
- Gated recurrent units (GRU)
- LSTM
- External memory / attention over recent history

**Expected benefits on Triangle**:
- The agent can "remember" that it has started a turn.
- Better consistency in control through the apex.
- Ability to ignore transient misleading sensor readings.

### 2. Improving Anticipation

**Goal**: Give the network information that helps it predict near-future states.

**Possible features to add**:
- Rate of change (derivatives) of ray readings
- Estimated time-to-collision per ray
- Car's current angular velocity / turning rate
- Simple forward simulation of wall positions based on current velocity
- Explicit "danger level" or "closing speed" features

**Expected benefits**:
- Helps solve the physics horizon problem by letting the agent act earlier.
- Makes high-speed behavior safer without requiring perfect memory.

### 3. Increasing Network Capacity

**Goal**: Give the policy more representational power.

**Options**:
- Increase hidden layer size (e.g., 32–64 units)
- Add a second hidden layer
- Use residual connections
- Separate policy heads for steering vs. throttle/braking
- Attention mechanisms over the ray inputs

**Trade-offs**:
- Larger networks are harder to optimize via mutation in a GA.
- Risk of slower evolution and more fragile policies.
- May require improvements to mutation, selection, or initialization strategies.

## Open Questions

Please answer these when you have time. Answers can be added directly below each question.

### Scope and Prioritization

1. Which direction should we prioritize first?
   - [ ] Memory (recurrent / frame stacking)
   - [ ] Anticipation features
   - [ ] Larger network capacity
   - [ ] Combination of Memory + Anticipation (recommended starting point?)

2. Should we aim for a minimal viable improvement first (e.g., frame stacking + a few anticipation features), or go for a more ambitious architectural change (e.g., adding a GRU layer)?

3. Do we want to keep the exact same input size and output structure for fair comparison with existing results, or are we comfortable changing the network interface?

### Memory Approach

4. What is the preferred first form of memory?
   - [ ] Frame stacking (simplest)
   - [ ] Basic RNN
   - [ ] GRU (more stable)
   - [ ] LSTM
   - [ ] Other

5. How many timesteps of history should we consider (for frame stacking or recurrent unrolling)?

6. Should the memory state be reset at the start of each episode/generation, or carried across?

### Anticipation Features

7. Which anticipation features seem most promising to implement first?
   - Ray derivatives (rate of change)
   - Time-to-collision estimates
   - Car angular velocity
   - Simple predictive simulation
   - Other ideas?

8. Should these new features be computed in the sensor code, in car.js, or elsewhere?

### Capacity and Architecture

9. If we increase capacity, what is the target size?
   - 32 hidden units?
   - 64 hidden units?
   - Two hidden layers?
   - Other?

10. Are we willing to change the mutation strategy or add new evolutionary operators if larger networks prove hard to optimize?

### Training and Compatibility

11. Should the new capabilities be available in both Genetic Algorithm mode and (future) Reinforcement Learning mode?

12. How should Vector Memory (ruvector) interact with recurrent states or new input features? (e.g., Should archived brains store hidden states?)

13. Do we need new ELI15 chapters to explain these concepts?

### Evaluation

14. What metrics should we use to judge whether these changes are successful on Triangle?
    - % of population that reaches the apex?
    - Best lap time achieved?
    - Consistency (variance in performance)?
    - Time to first successful lap?
    - Other?

15. Should we maintain the ability to run clean A/B comparisons against the current baseline architecture?

### Implementation Constraints

16. Are there any hard constraints (performance, code complexity, browser limitations) that should limit the ambition of these changes?

17. Should changes be made in a way that they can be toggled on/off easily for experimentation?

## Proposed Phased Approach (Draft)

This is a suggested structure only. It should be adjusted based on answers to the open questions.

**Phase 0: Planning & Scoping**
- Answer the open questions above
- Decide on first target (e.g., frame stacking + ray derivatives)
- Define success criteria for Phase 1

**Phase 1: Minimal Capability Upgrade (MVP)**
- Implement frame stacking or a simple recurrent layer
- Add 2–3 high-value anticipation features
- Test on Rectangle first, then Triangle
- Measure impact on early-generation survival and apex reach rate

**Phase 2: Increased Capacity**
- Experiment with larger hidden layers or additional layers
- Evaluate whether current mutation/selection is sufficient
- Potentially introduce improved evolutionary operators if needed

**Phase 3: Deeper Integration**
- Explore how Vector Memory should interact with memory states
- Update ELI15 material
- Extend A/B comparison tools to support new architectures
- Consider compatibility with future RL mode

**Phase 4: Evaluation and Documentation**
- Run controlled experiments comparing old vs. new architecture on multiple tracks
- Document findings (similar to existing triangle-apex investigations)
- Decide on default architecture going forward

## Risks and Considerations

- Larger or recurrent networks may be significantly harder to evolve effectively with the current mutation-based approach.
- Adding memory increases the complexity of saving, loading, and transferring policies via Vector Memory.
- Performance impact in the browser (especially with recurrence).
- Risk of over-engineering for educational/research goals.

## Success Criteria (to be refined)

- Clear, measurable improvement in the percentage of cars that successfully navigate the Triangle apex.
- The improvement is reproducible and not just due to lucky random seeds.
- The new capabilities provide understandable, explainable benefits (supporting ELI15 goals).

---

**Next Step**:  
Please review the **Open Questions** section and provide answers (even tentative or partial ones) whenever you have time. Once we have direction on the highest-priority approach, we can create a more detailed technical implementation plan.

This document is meant to be a living planning artifact. Feel free to edit it directly as decisions are made.