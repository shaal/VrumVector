/* @ts-self-types="./ruvector_sona.d.ts" */

/**
 * WASM-compatible Ephemeral Agent for federated learning
 *
 * Lightweight agent wrapper (~5MB footprint) for distributed training.
 * Agents process tasks, collect trajectories, and export state for aggregation.
 *
 * # Example
 * ```javascript
 * const agent = new WasmEphemeralAgent("agent-1");
 *
 * // Process tasks
 * const embedding = new Float32Array(256).fill(0.1);
 * agent.process_task(embedding, 0.85);
 *
 * // Export state for coordinator
 * const state = agent.export_state();
 * ```
 */
export class WasmEphemeralAgent {
    static __wrap(ptr) {
        const obj = Object.create(WasmEphemeralAgent.prototype);
        obj.__wbg_ptr = ptr;
        WasmEphemeralAgentFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmEphemeralAgentFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmephemeralagent_free(ptr, 0);
    }
    /**
     * Get average quality of collected trajectories
     * @returns {number}
     */
    averageQuality() {
        const ret = wasm.wasmephemeralagent_averageQuality(this.__wbg_ptr);
        return ret;
    }
    /**
     * Clear collected trajectories (after export)
     */
    clear() {
        wasm.wasmephemeralagent_clear(this.__wbg_ptr);
    }
    /**
     * Full, versioned learning checkpoint; unlike exportState, does not train.
     * @returns {string}
     */
    exportCheckpoint() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.wasmephemeralagent_exportCheckpoint(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Export agent state for coordinator aggregation
     *
     * # Returns
     * JSON object containing agent state, trajectories, and statistics
     *
     * # Example
     * ```javascript
     * const state = agent.export_state();
     * console.log('Trajectories:', state.trajectories.length);
     * coordinator.aggregate(state);
     * ```
     * @returns {any}
     */
    exportState() {
        const ret = wasm.wasmephemeralagent_exportState(this.__wbg_ptr);
        return ret;
    }
    /**
     * Find top-k patterns most similar to a query embedding
     *
     * # Arguments
     * * `query_embedding` - Query vector as Float32Array
     * * `k` - Number of patterns to return
     * @param {Float32Array} query_embedding
     * @param {number} k
     * @returns {any}
     */
    findPatterns(query_embedding, k) {
        const ptr0 = passArrayF32ToWasm0(query_embedding, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmephemeralagent_findPatterns(this.__wbg_ptr, ptr0, len0, k);
        return ret;
    }
    /**
     * Force learning cycle on agent's engine
     * @returns {string}
     */
    forceLearn() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmephemeralagent_forceLearn(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get learned patterns from agent
     * @returns {any}
     */
    getPatterns() {
        const ret = wasm.wasmephemeralagent_getPatterns(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get agent statistics
     *
     * # Returns
     * JSON object with trajectory count, quality stats, uptime
     * @returns {any}
     */
    getStats() {
        const ret = wasm.wasmephemeralagent_getStats(this.__wbg_ptr);
        return ret;
    }
    /**
     * Validate the complete checkpoint before replacing any live state.
     * @param {string} json
     */
    importCheckpoint(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmephemeralagent_importCheckpoint(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Create a new ephemeral agent with default config
     *
     * # Arguments
     * * `agent_id` - Unique identifier for this agent
     *
     * # Example
     * ```javascript
     * const agent = new WasmEphemeralAgent("agent-1");
     * ```
     * @param {string} agent_id
     */
    constructor(agent_id) {
        const ptr0 = passStringToWasm0(agent_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmephemeralagent_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WasmEphemeralAgentFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Process task with model route information
     *
     * # Arguments
     * * `embedding` - Query embedding
     * * `quality` - Quality score
     * * `route` - Model route used (e.g., "gpt-4", "claude-3")
     * @param {Float32Array} embedding
     * @param {number} quality
     * @param {string} route
     */
    processTaskWithRoute(embedding, quality, route) {
        const ptr0 = passArrayF32ToWasm0(embedding, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(route, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.wasmephemeralagent_processTaskWithRoute(this.__wbg_ptr, ptr0, len0, quality, ptr1, len1);
    }
    /**
     * Process a task and record trajectory
     *
     * # Arguments
     * * `embedding` - Query embedding as Float32Array
     * * `quality` - Task quality score [0.0, 1.0]
     *
     * # Example
     * ```javascript
     * const embedding = new Float32Array(256).fill(0.1);
     * agent.process_task(embedding, 0.85);
     * ```
     * @param {Float32Array} embedding
     * @param {number} quality
     */
    processTask(embedding, quality) {
        const ptr0 = passArrayF32ToWasm0(embedding, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmephemeralagent_processTask(this.__wbg_ptr, ptr0, len0, quality);
    }
    /**
     * Get number of collected trajectories
     * @returns {number}
     */
    trajectoryCount() {
        const ret = wasm.wasmephemeralagent_trajectoryCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get agent uptime in seconds
     * @returns {bigint}
     */
    uptimeSeconds() {
        const ret = wasm.wasmephemeralagent_uptimeSeconds(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Create agent with custom configuration
     *
     * # Arguments
     * * `agent_id` - Unique identifier
     * * `config` - JSON configuration object
     *
     * # Example
     * ```javascript
     * const config = {
     *   hidden_dim: 256,
     *   trajectory_capacity: 500,
     *   pattern_clusters: 25
     * };
     * const agent = WasmEphemeralAgent.with_config("agent-1", config);
     * ```
     * @param {string} agent_id
     * @param {any} config
     * @returns {WasmEphemeralAgent}
     */
    static withConfig(agent_id, config) {
        const ptr0 = passStringToWasm0(agent_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmephemeralagent_withConfig(ptr0, len0, config);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmEphemeralAgent.__wrap(ret[0]);
    }
}
if (Symbol.dispose) WasmEphemeralAgent.prototype[Symbol.dispose] = WasmEphemeralAgent.prototype.free;

/**
 * WASM-compatible Federated Coordinator
 *
 * Central aggregator for federated learning with quality filtering.
 * Coordinates multiple ephemeral agents using star topology.
 *
 * # Example
 * ```javascript
 * const coordinator = new WasmFederatedCoordinator("central");
 *
 * // Aggregate agent exports
 * const agentState = agent.export_state();
 * const result = coordinator.aggregate(agentState);
 *
 * // Check stats
 * const stats = coordinator.get_stats();
 * console.log('Total agents:', stats.total_agents);
 * ```
 */
export class WasmFederatedCoordinator {
    static __wrap(ptr) {
        const obj = Object.create(WasmFederatedCoordinator.prototype);
        obj.__wbg_ptr = ptr;
        WasmFederatedCoordinatorFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmFederatedCoordinatorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmfederatedcoordinator_free(ptr, 0);
    }
    /**
     * Get total number of contributing agents
     * @returns {number}
     */
    agentCount() {
        const ret = wasm.wasmfederatedcoordinator_agentCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Aggregate agent export into coordinator
     *
     * # Arguments
     * * `agent_export` - JSON export from agent.export_state()
     *
     * # Returns
     * JSON aggregation result with accepted/rejected counts
     *
     * # Example
     * ```javascript
     * const agentState = agent.export_state();
     * const result = coordinator.aggregate(agentState);
     * console.log('Accepted:', result.accepted);
     * ```
     * @param {any} agent_export
     * @returns {any}
     */
    aggregate(agent_export) {
        const ret = wasm.wasmfederatedcoordinator_aggregate(this.__wbg_ptr, agent_export);
        return ret;
    }
    /**
     * Apply coordinator's learned LoRA to input
     * @param {Float32Array} input
     * @returns {Float32Array}
     */
    applyLora(input) {
        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmfederatedcoordinator_applyLora(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Clear all agent contributions (reset coordinator)
     */
    clear() {
        wasm.wasmfederatedcoordinator_clear(this.__wbg_ptr);
    }
    /**
     * Consolidate learning from all aggregated trajectories
     *
     * Should be called periodically after aggregating multiple agents.
     *
     * # Returns
     * Learning result as JSON string
     * @returns {string}
     */
    consolidate() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmfederatedcoordinator_consolidate(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Find similar patterns to query
     *
     * # Arguments
     * * `query_embedding` - Query vector
     * * `k` - Number of patterns to return
     * @param {Float32Array} query_embedding
     * @param {number} k
     * @returns {any}
     */
    findPatterns(query_embedding, k) {
        const ptr0 = passArrayF32ToWasm0(query_embedding, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmfederatedcoordinator_findPatterns(this.__wbg_ptr, ptr0, len0, k);
        return ret;
    }
    /**
     * Get all learned patterns from coordinator
     * @returns {any}
     */
    getPatterns() {
        const ret = wasm.wasmfederatedcoordinator_getPatterns(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get coordinator statistics
     *
     * # Returns
     * JSON object with agent count, trajectory count, quality stats
     * @returns {any}
     */
    getStats() {
        const ret = wasm.wasmfederatedcoordinator_getStats(this.__wbg_ptr);
        return ret;
    }
    /**
     * Create a new federated coordinator with default config
     *
     * # Arguments
     * * `coordinator_id` - Unique identifier for this coordinator
     *
     * # Example
     * ```javascript
     * const coordinator = new WasmFederatedCoordinator("central");
     * ```
     * @param {string} coordinator_id
     */
    constructor(coordinator_id) {
        const ptr0 = passStringToWasm0(coordinator_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmfederatedcoordinator_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WasmFederatedCoordinatorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set quality threshold for accepting trajectories
     *
     * # Arguments
     * * `threshold` - Minimum quality [0.0, 1.0], default 0.4
     * @param {number} threshold
     */
    setQualityThreshold(threshold) {
        wasm.wasmfederatedcoordinator_setQualityThreshold(this.__wbg_ptr, threshold);
    }
    /**
     * Get total trajectories aggregated
     * @returns {number}
     */
    totalTrajectories() {
        const ret = wasm.wasmfederatedcoordinator_totalTrajectories(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create coordinator with custom configuration
     *
     * # Arguments
     * * `coordinator_id` - Unique identifier
     * * `config` - JSON configuration object
     *
     * # Example
     * ```javascript
     * const config = {
     *   hidden_dim: 256,
     *   trajectory_capacity: 50000,
     *   pattern_clusters: 200,
     *   ewc_lambda: 2000.0
     * };
     * const coordinator = WasmFederatedCoordinator.with_config("central", config);
     * ```
     * @param {string} coordinator_id
     * @param {any} config
     * @returns {WasmFederatedCoordinator}
     */
    static withConfig(coordinator_id, config) {
        const ptr0 = passStringToWasm0(coordinator_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmfederatedcoordinator_withConfig(ptr0, len0, config);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmFederatedCoordinator.__wrap(ret[0]);
    }
}
if (Symbol.dispose) WasmFederatedCoordinator.prototype[Symbol.dispose] = WasmFederatedCoordinator.prototype.free;

/**
 * WASM-compatible SONA Engine wrapper
 *
 * Provides JavaScript bindings for the SONA adaptive learning system.
 */
export class WasmSonaEngine {
    static __wrap(ptr) {
        const obj = Object.create(WasmSonaEngine.prototype);
        obj.__wbg_ptr = ptr;
        WasmSonaEngineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmSonaEngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmsonaengine_free(ptr, 0);
    }
    /**
     * Apply LoRA transformation to specific layer
     *
     * # Arguments
     * * `layer_idx` - Layer index
     * * `input` - Input vector as Float32Array
     *
     * # Returns
     * Transformed vector as Float32Array
     * @param {number} layer_idx
     * @param {Float32Array} input
     * @returns {Float32Array}
     */
    applyLoraLayer(layer_idx, input) {
        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmsonaengine_applyLoraLayer(this.__wbg_ptr, layer_idx, ptr0, len0);
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Apply LoRA transformation to input vector
     *
     * # Arguments
     * * `input` - Input vector as Float32Array
     *
     * # Returns
     * Transformed vector as Float32Array
     *
     * # Example
     * ```javascript
     * const input = new Float32Array(256).fill(1.0);
     * const output = engine.apply_lora(input);
     * ```
     * @param {Float32Array} input
     * @returns {Float32Array}
     */
    applyLora(input) {
        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmsonaengine_applyLora(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * End the trajectory and submit for learning
     *
     * # Arguments
     * * `trajectory_id` - ID returned from start_trajectory
     * * `final_score` - Overall trajectory quality [0.0, 1.0]
     *
     * # Example
     * ```javascript
     * engine.end_trajectory(trajectoryId, 0.85);
     * ```
     * @param {bigint} trajectory_id
     * @param {number} final_score
     */
    endTrajectory(trajectory_id, final_score) {
        wasm.wasmsonaengine_endTrajectory(this.__wbg_ptr, trajectory_id, final_score);
    }
    /**
     * Find similar patterns to query
     *
     * # Arguments
     * * `query_embedding` - Query vector as Float32Array
     * * `k` - Number of patterns to return
     *
     * # Returns
     * Array of similar patterns as JSON
     *
     * # Example
     * ```javascript
     * const query = new Float32Array(256).fill(0.5);
     * const patterns = engine.find_patterns(query, 5);
     * console.log('Similar patterns:', patterns);
     * ```
     * @param {Float32Array} query_embedding
     * @param {number} k
     * @returns {any}
     */
    findPatterns(query_embedding, k) {
        const ptr0 = passArrayF32ToWasm0(query_embedding, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmsonaengine_findPatterns(this.__wbg_ptr, ptr0, len0, k);
        return ret;
    }
    /**
     * Force background learning cycle
     *
     * # Returns
     * Learning statistics as JSON string
     *
     * # Example
     * ```javascript
     * const stats = engine.force_learn();
     * console.log('Learning results:', stats);
     * ```
     * @returns {string}
     */
    forceLearn() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmsonaengine_forceLearn(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get configuration
     *
     * # Returns
     * Configuration as JSON object
     * @returns {any}
     */
    getConfig() {
        const ret = wasm.wasmsonaengine_getConfig(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get engine statistics
     *
     * # Returns
     * Statistics as JSON object
     *
     * # Example
     * ```javascript
     * const stats = engine.get_stats();
     * console.log('Trajectories buffered:', stats.trajectories_buffered);
     * console.log('Patterns learned:', stats.patterns_learned);
     * ```
     * @returns {any}
     */
    getStats() {
        const ret = wasm.wasmsonaengine_getStats(this.__wbg_ptr);
        return ret;
    }
    /**
     * Check if engine is enabled
     *
     * # Returns
     * true if enabled, false otherwise
     * @returns {boolean}
     */
    isEnabled() {
        const ret = wasm.wasmsonaengine_isEnabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Apply learning from user feedback
     *
     * # Arguments
     * * `success` - Whether the operation succeeded
     * * `latency_ms` - Operation latency in milliseconds
     * * `quality` - User-perceived quality [0.0, 1.0]
     *
     * # Example
     * ```javascript
     * engine.learn_from_feedback(true, 50.0, 0.9);
     * ```
     * @param {boolean} success
     * @param {number} latency_ms
     * @param {number} quality
     */
    learnFromFeedback(success, latency_ms, quality) {
        wasm.wasmsonaengine_learnFromFeedback(this.__wbg_ptr, success, latency_ms, quality);
    }
    /**
     * Create a new SONA engine with specified hidden dimension
     *
     * # Arguments
     * * `hidden_dim` - Size of hidden layer (typically 256, 512, or 1024)
     *
     * # Example
     * ```javascript
     * const engine = new WasmSonaEngine(256);
     * ```
     * @param {number} hidden_dim
     */
    constructor(hidden_dim) {
        const ret = wasm.wasmsonaengine_new(hidden_dim);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WasmSonaEngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Record a step in the trajectory
     *
     * # Arguments
     * * `trajectory_id` - ID returned from start_trajectory
     * * `node_id` - Graph node visited
     * * `score` - Step quality score [0.0, 1.0]
     * * `latency_us` - Step latency in microseconds
     *
     * # Example
     * ```javascript
     * engine.record_step(trajectoryId, 42, 0.8, 1000);
     * ```
     * @param {bigint} trajectory_id
     * @param {number} node_id
     * @param {number} score
     * @param {bigint} latency_us
     */
    recordStep(trajectory_id, node_id, score, latency_us) {
        wasm.wasmsonaengine_recordStep(this.__wbg_ptr, trajectory_id, node_id, score, latency_us);
    }
    /**
     * Run instant learning cycle
     *
     * Flushes accumulated micro-LoRA updates
     *
     * # Example
     * ```javascript
     * engine.run_instant_cycle();
     * ```
     */
    runInstantCycle() {
        wasm.wasmsonaengine_runInstantCycle(this.__wbg_ptr);
    }
    /**
     * Enable or disable the engine
     *
     * # Arguments
     * * `enabled` - Whether to enable the engine
     *
     * # Example
     * ```javascript
     * engine.set_enabled(false); // Pause learning
     * ```
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        wasm.wasmsonaengine_setEnabled(this.__wbg_ptr, enabled);
    }
    /**
     * Start recording a new trajectory
     *
     * # Arguments
     * * `query_embedding` - Query vector as Float32Array
     *
     * # Returns
     * Trajectory ID (u64)
     *
     * # Example
     * ```javascript
     * const embedding = new Float32Array(256).fill(0.1);
     * const trajectoryId = engine.start_trajectory(embedding);
     * ```
     * @param {Float32Array} query_embedding
     * @returns {bigint}
     */
    startTrajectory(query_embedding) {
        const ptr0 = passArrayF32ToWasm0(query_embedding, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmsonaengine_startTrajectory(this.__wbg_ptr, ptr0, len0);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Try to run background learning cycle
     *
     * Returns true if cycle was executed, false if not due yet
     *
     * # Example
     * ```javascript
     * if (engine.tick()) {
     *   console.log('Background learning completed');
     * }
     * ```
     * @returns {boolean}
     */
    tick() {
        const ret = wasm.wasmsonaengine_tick(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Create engine with custom configuration
     *
     * # Arguments
     * * `config` - JSON configuration object
     *
     * # Example
     * ```javascript
     * const config = {
     *   hidden_dim: 256,
     *   embedding_dim: 256,
     *   micro_lora_rank: 2,
     *   base_lora_rank: 16,
     *   micro_lora_lr: 0.001,
     *   base_lora_lr: 0.0001,
     *   ewc_lambda: 1000.0,
     *   pattern_clusters: 128,
     *   trajectory_capacity: 10000,
     *   quality_threshold: 0.6
     * };
     * const engine = WasmSonaEngine.with_config(config);
     * ```
     * @param {any} config
     * @returns {WasmSonaEngine}
     */
    static withConfig(config) {
        const ret = wasm.wasmsonaengine_withConfig(config);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmSonaEngine.__wrap(ret[0]);
    }
}
if (Symbol.dispose) WasmSonaEngine.prototype[Symbol.dispose] = WasmSonaEngine.prototype.free;

/**
 * Initialize WASM module (called automatically)
 */
export function wasm_init() {
    wasm.wasm_init();
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_debug_string_0e68cf47c9cbd9b0: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_undefined_8c687d0b90d5b524: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_string_get_92ab86bb19cbc12f: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_756c5934221e6fee: function(arg0) {
            console.error(arg0);
        },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_get_989d0a1309644f2b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_instanceof_Performance_9f88c0432406e101: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Performance;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_log_363d83b9114c8831: function(arg0) {
            console.log(arg0);
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_now_0b7736bc17fd7719: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_now_d1fb6650485d7f3e: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_8eb4cd83130a11a0: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_1e7044f654e934db: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_d8b50611246a6d92: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_fd0bc376bf0f8b42: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./ruvector_sona_bg.js": import0,
    };
}

const WasmEphemeralAgentFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmephemeralagent_free(ptr, 1));
const WasmFederatedCoordinatorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmfederatedcoordinator_free(ptr, 1));
const WasmSonaEngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmsonaengine_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('ruvector_sona_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
