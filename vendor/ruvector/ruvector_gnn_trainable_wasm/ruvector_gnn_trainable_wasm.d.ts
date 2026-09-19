/* tslint:disable */
/* eslint-disable */

export class WasmGraphRanker {
    free(): void;
    [Symbol.dispose](): void;
    exportCheckpoint(): string;
    importCheckpoint(json: string): void;
    constructor(input_dim: number, hidden_dim: number, seed: number);
    predict(node: Float64Array, parents: string): number;
    setWeights(weights: Float64Array): void;
    steps(): number;
    train(node: Float64Array, parents: string, target: number, rate: number): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmgraphranker_free: (a: number, b: number) => void;
    readonly wasmgraphranker_exportCheckpoint: (a: number) => [number, number, number, number];
    readonly wasmgraphranker_importCheckpoint: (a: number, b: number, c: number) => [number, number];
    readonly wasmgraphranker_new: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmgraphranker_predict: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasmgraphranker_setWeights: (a: number, b: number, c: number) => [number, number];
    readonly wasmgraphranker_steps: (a: number) => number;
    readonly wasmgraphranker_train: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
