# Reinforcement Learning Mode Plan

**Status:** Draft / Planning  
**Created:** 2026-05  
**Owner:** (to be assigned)  
**Related Projects:** Vector Memory / Neuroevolution experiments

## Motivation

The current system uses a Genetic Algorithm (neuroevolution) to train neural network controllers for cars. While this approach has many strengths (especially for the project's educational and research goals), it is fundamentally different from modern Reinforcement Learning (RL) methods that use gradient-based optimization.

Adding an explicit "Reinforcement Learning" mode would allow:

- Direct comparison between evolutionary learning and gradient-based learning in the same environment.
- Better understanding of the strengths and weaknesses of each paradigm on the same tasks (especially hard tracks like Triangle).
- Educational value (aligns with the project's strong ELI15 focus).
- Future research into hybrid approaches or continual learning.

## Goals

- Enable users to switch between Genetic Algorithm mode and Reinforcement Learning mode.
- Make the differences in behavior, learning dynamics, and performance observable and measurable.
- Keep the experience usable within a browser environment.
- Preserve the ability to run meaningful comparisons (including with existing tools like A/B mode and pure-local sensors).

## High-Level Vision

A user should be able to:

1. Load the project.
2. Choose a learning mode (Genetic Algorithm vs Reinforcement Learning).
3. Start training.
4. Observe qualitatively and quantitatively different learning behaviors.
5. Easily switch between modes or run controlled comparisons.

The RL mode should feel like a first-class experimental feature, similar to how Vector Memory features and the A/B comparison mode are treated today.

## Current State Summary

- Learning is entirely population-based via a Genetic Algorithm.
- No backpropagation or gradient-based optimization is used.
- Brains are small feedforward networks (`[10, 16, 4]`).
- Training happens in a Web Worker.
- Strong existing infrastructure for visualization, A/B testing, checkpoints, and first-visit UX.

## Open Questions

This section contains all major decisions that are still unresolved. Please answer these when you have time. Answers can be added directly below each question.

### 1. Scope & Ambition

**1.1** What is the primary goal of adding RL mode?
- [ ] Educational / conceptual comparison with GA
- [ ] Research into whether RL can outperform GA on hard tracks (e.g. Triangle)
- [ ] Both
- [ ] Other: ________________

**1.2** Which RL algorithm family should we target first?
- [ ] REINFORCE (vanilla policy gradient) — simplest
- [ ] Advantage Actor-Critic (A2C / A3C style)
- [ ] PPO (more stable but more complex)
- [ ] DQN or value-based methods
- [ ] Other: ________________

**1.3** Should we aim for a minimal viable RL mode first, or go straight for something reasonably modern and stable?

### 2. Learning Dynamics

**2.1** Should RL mode use a single agent or multiple parallel agents (for variance reduction)?

**2.2** How should episodes be defined? (Fixed time? Until crash? Until lap completion?)

**2.3** Should the RL agent have access to the same input features as the GA agent (including `lf`/`lr` track-relative features), or should we start with a stricter "pure local sensors" version?

### 3. Reward Design

**3.1** Who will be primarily responsible for designing and iterating on the reward function?
- [ ] The person driving this plan
- [ ] Collaborative (multiple people)
- [ ] Other: ________________

**3.2** Should we start with a relatively dense reward function, or try to stay close to the current sparse fitness signal?

**3.3** How important is it that the RL reward function remains "fair" when comparing against GA fitness?

### 4. Technical Implementation

**4.1** Where should the RL training loop live?
- [ ] Inside the existing Web Worker (preferred for performance)
- [ ] On the main thread
- [ ] Hybrid

**4.2** Are we comfortable implementing a basic optimizer (Adam or SGD with momentum) in pure JavaScript?

**4.3** Should we keep the exact same network architecture (`[10,16,4]`) for fair comparison, or allow different architectures per mode?

**4.4** How should we handle saving and loading policies between GA and RL modes? (They will likely be incompatible.)

### 5. User Experience & Comparison

**5.1** How should mode switching work?
- [ ] Global mode at startup (either GA or RL for the whole session)
- [ ] Switchable at runtime
- [ ] Support running both simultaneously (like current A/B)

**5.2** What new visualizations/metrics would be most valuable in RL mode?
- Reward/return curves
- Loss curves
- Policy entropy
- Value function estimates
- Other: ________________

**5.3** Should we extend the existing A/B system to support "GA vs RL" comparisons, or build something new?

**5.4** How do we want to handle the "first visit" / onboarding experience when RL mode is selected?

### 6. Integration with Existing Features

**6.1** Should the "Pure Local Sensors" experiment (`?pure-local=1`) work in both GA and RL modes?

**6.2** Should the existing ELI15 teaching material be updated to cover RL concepts?

**6.3** How should checkpoints (especially the 10-checkpoint Triangle setup) interact with RL training?

### 7. Performance & Practicality

**7.1** How important is it that RL training feels reasonably fast in the browser?

**7.2** Are we okay with RL mode being significantly slower than GA mode (due to gradient computation)?

**7.3** Should RL training support running in the background (like current training)?

### 8. Long-term Direction

**8.1** Is the ultimate goal to have RL as a permanent, well-supported alternative to GA?

**8.2** Are we interested in hybrid approaches in the future (e.g., using RL for fine-tuning GA populations, or vice versa)?

**8.3** Should this work eventually be written up (even informally) as an experiment comparing evolution vs. reinforcement learning in a constrained browser environment?

## Proposed High-Level Phases (Subject to Change)

These phases are only a starting point and should be adjusted based on answers to the open questions above.

**Phase 0 – Planning & Scoping**
- Answer the open questions above
- Decide on target algorithm for v1
- Define success criteria for the first version

**Phase 1 – Core RL Training Loop (MVP)**
- Implement basic policy gradient (likely REINFORCE + baseline)
- Define initial reward function
- Get a single agent training and showing visible improvement
- Minimal UI (basic reward graph + episode counter)

**Phase 2 – Integration & Mode Switching**
- Add UI to select between GA and RL modes
- Ensure clean separation of concerns
- Basic comparison tooling

**Phase 3 – Polish & Educational Value**
- Improve visualizations
- Add ELI15 material explaining the differences
- Stabilize training (entropy bonus, better baselines, etc.)
- Documentation and examples

**Phase 4 – Advanced Features (Optional)**
- Actor-Critic
- Better exploration techniques
- Multi-agent or population-based RL hybrids
- Stronger comparison experiments

## Risks & Challenges

- Reward engineering is notoriously difficult and time-consuming.
- Policy gradient methods can be very unstable compared to GA.
- Performance in the browser may be a limiting factor.
- Fair comparison between fundamentally different paradigms is conceptually tricky.
- Increased codebase complexity.

## Success Metrics (to be refined)

- A new user can enable RL mode and observe the car improving over time.
- Clear qualitative differences between GA and RL behavior are observable.
- Quantitative comparisons are possible and meaningful.

---

**Next Step:**  
Once you have time, please go through the **Open Questions** section above and provide answers (even partial or tentative ones). You can edit this file directly or reply with your thoughts. We can then refine the plan and begin execution.

This document is intentionally left with many questions open so we can make good decisions before writing significant code.