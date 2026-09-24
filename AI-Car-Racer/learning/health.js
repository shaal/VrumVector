// Training health from the agentic clock of emergent-time (ruvnet/ruvector,
// vendored at vendor/ruvector/emergent_time_wasm). Diagnostic only: upstream
// reports no proven early-warning lead over simple change-point baselines.
//
// One clock tick per generation. Channel mapping (the rest stay 0):
//   belief        RMS change of the champion's weights (0 when unchanged)
//   plan          relative change of the mutation rate (adaptive stages)
//   contradiction drop of this generation's best below the previous one, in checkpoints
//   progress      gain of the champion's progress, in checkpoints
// Progress stays in checkpoints (not laps) so that the reading does not depend
// on how many gates a track has. Over an 8-generation window: Healthy =
// progress; Stuck = no progress and no change; NeedsReplan = the champion or
// the mutation rate changed without a gain. Upstream's ATI thresholds (0.5,
// 0.1) read most improving windows as Drifting; 0.05 and 0.01 do not. See
// docs/validation/training-health.md for what the traces do and do not show.
export const HEALTH_WINDOW=8;
export const HEALTH_THRESHOLDS=[1e-3,.05,.01,.5,.8]; // idle, healthy ATI, drifting ATI, collapse, human review
// ?v= is the first 8 hex digits of the wasm SHA-256 (test:learning enforces it).
export const HEALTH_MODULE_URL=new URL('../../vendor/ruvector/emergent_time_wasm/emergent_time_wasm.js?v=et-c8c08764',import.meta.url).href;
const HEALTH_WASM_URL=new URL('../../vendor/ruvector/emergent_time_wasm/emergent_time_wasm_bg.wasm?v=et-c8c08764',import.meta.url);

let wasm=null,loading=null;
export function loadHealth(){
  loading??=import(HEALTH_MODULE_URL).then(async mod=>{await mod.default({module_or_path:HEALTH_WASM_URL});wasm=mod;return true;})
    .catch(error=>{console.warn('[health] emergent-time unavailable; health pill hidden',error);return false;});
  return loading;
}
export const healthReady=()=>!!wasm;

export const HEALTH_LABELS={
  Healthy:'Improving',Drifting:'Slow progress',Stuck:'Plateau',NeedsReplan:'Plateau while exploring',
  Contradicting:'Losing ground',Collapsing:'Collapsing',NeedsHumanReview:'Needs review',
};

export class TrainingHealth{
  constructor({thresholds=HEALTH_THRESHOLDS,window=HEALTH_WINDOW}={}){
    this.thresholds=thresholds;this.window=window;this.clock=null;this.previous=null;this.state=null;this.sinceProgress=0;this.generations=0;
  }
  reset(){try{this.clock?.free();}catch{}this.clock=null;this.previous=null;this.state=null;this.sinceProgress=0;this.generations=0;}
  // row: {best, genBest, gates, mutation, champion: Float32Array}
  observe(row){
    if(!wasm||!row||!(row.gates>0)||!Number.isFinite(row.best))return this.snapshot();
    if(!this.clock){this.clock=new wasm.AgenticClock();this.clock.setWindow(this.window);this.clock.setThresholds(...this.thresholds);}
    const p=this.previous;let move=0,plan=0,regress=0,progress=0;
    if(p){
      if(row.champion&&p.champion&&row.champion.length===p.champion.length){
        for(let i=0;i<row.champion.length;i++)move+=(row.champion[i]-p.champion[i])**2;
        move=Math.sqrt(move/row.champion.length);
      }
      plan=Math.abs((row.mutation??0)-(p.mutation??0))/Math.max(.01,p.mutation??0);
      regress=Math.max(0,(p.genBest??0)-(row.genBest??0));
      progress=Math.max(0,row.best-p.best);
    }
    // tick() borrows the delta and returns a Tick; free both wasm objects.
    const delta=new wasm.StateDelta(move,0,0,0,regress,plan,0,progress);
    try{this.clock.tick(delta).free();}finally{delta.free();}
    this.state=wasm.AgentHealthJs[this.clock.health];
    this.sinceProgress=p&&progress<=0?this.sinceProgress+1:0;this.generations++;
    this.previous={...row,champion:row.champion?Float32Array.from(row.champion):null};
    return this.snapshot();
  }
  // Nothing to report until there is a previous generation to compare with.
  snapshot(){return this.state&&this.generations>=2?{state:this.state,label:HEALTH_LABELS[this.state]||this.state,sinceProgress:this.sinceProgress,generations:this.generations}:null;}
}
