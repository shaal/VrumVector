// Auto Train (docs/plan/training-ux-auto-mode.md, Option 2): an opt-in toggle
// that moves through the training presets on its own. One step per generation:
//   Fresh  → Grind   when the generation's best car passes a checkpoint beyond
//                    the start line (cars spawn touching the start gate, so
//                    every generation already scores 1)
//   Grind  → Polish  when the generation's best car completes a lap
//   Polish → Grind   on a plateau: the training-health snapshot (health.js)
//                    shows no champion gain for PLATEAU_GENERATIONS generations
//                    in Polish and the clock does not read improving
// After a plateau bounce, Grind runs at least BOUNCE_GENERATIONS generations
// before a lap can send it back to Polish; a lapping elite would otherwise
// return after one Grind generation. Both numbers are first guesses; see
// docs/validation/auto-train.md. A new track (new walls) starts again at
// Fresh. Only generations built after Auto Train set their preset are judged.
// Moving a tuning control or choosing a preset turns Auto Train off, because
// user intent wins. The toggle is not saved across reloads.
import {healthReady} from './health.js';
export const PLATEAU_GENERATIONS=20;
export const BOUNCE_GENERATIONS=8;
export const START_GATE_CREDIT=1;
const IMPROVING=new Set(['Healthy','Drifting']);
const NAMES={fresh:'🌱 Fresh',grind:'🏎️ Grind',polish:'✨ Polish'};

export class AutoTrainPolicy {
  constructor({plateau=PLATEAU_GENERATIONS,bounce=BOUNCE_GENERATIONS}={}){this.plateau=plateau;this.bounce=bounce;this.restart('Turned on.');}
  restart(reason){this.phase='fresh';this.inPhase=0;this.bounced=false;this.phaseBest=-Infinity;this.flat=0;this.reason=reason;}
  // result: one generation's outcome {fitness, laps}. health: the
  // TrainingHealth snapshot of the same generation, or null. clock: whether the
  // health clock is loaded. Returns the new phase when it changes, else null.
  observe(result,health=null,clock=false){
    if(!result||!Number.isFinite(result.fitness))return null;
    this.inPhase++;
    // Fallback plateau counter for when the health clock is unavailable.
    if(result.fitness>this.phaseBest){this.phaseBest=result.fitness;this.flat=0;}else this.flat++;
    const from=this.phase;let next=null;
    if(from==='fresh'&&result.fitness>START_GATE_CREDIT){next='grind';this.reason='A car passed a checkpoint.';}
    else if(from==='grind'&&result.laps>=1&&(!this.bounced||this.inPhase>=this.bounce)){next='polish';this.reason='A car completed a lap.';}
    else if(from==='polish'&&this.plateaued(health,clock)){next='grind';this.reason=`Plateau: no gain for ${this.plateau} generations in Polish.`;}
    if(!next)return null;
    this.bounced=from==='polish';this.phase=next;this.inPhase=0;this.phaseBest=-Infinity;this.flat=0;
    return next;
  }
  // Only generations spent in Polish count, whether or not the health clock
  // was reset when the phase changed. On real traces the clock reads a plateau
  // whenever the gain counter is past its 8-generation window, so the counter
  // decides; the state check keeps an improving reading from bouncing.
  // The clock has no reading for the first generation after a learning-context
  // change; that generation makes no decision. The plain counter of
  // generations without a new best is only for a clock that is not loaded.
  plateaued(health,clock){
    if(health)return !IMPROVING.has(health.state)&&Math.min(health.sinceProgress,this.inPhase)>=this.plateau;
    return !clock&&this.flat>=this.plateau;
  }
  // Fixed text: the status line is a live region, so it must not change
  // every generation.
  nextStep(){
    if(this.phase==='fresh')return 'Next: 🏎️ Grind when a car passes a checkpoint.';
    if(this.phase==='grind')return this.bounced?`Next: ✨ Polish after a lap, once Grind has run ${this.bounce} generations.`:'Next: ✨ Polish when a car completes a lap.';
    return `Next: 🏎️ Grind after ${this.plateau} generations without a gain.`;
  }
}

// Walls only: adaptive gates move checkpoints between generations.
const wallsKey=()=>typeof road!=='undefined'&&road?JSON.stringify([road.innerList,road.outerList]):null;
// main.js numbers each generation it begins; the worker echoes it in genEnd.
const runSerial=()=>typeof presentationRunSerial==='number'?presentationRunSerial:null;

class AutoTrain {
  constructor(){this.enabled=false;this.policy=new AutoTrainPolicy();this.note='';this.walls=null;this.judgeFrom=null;}
  toggle(){this.setEnabled(!this.enabled);}
  setEnabled(on,note=''){
    on=!!on;
    if(on&&!this.enabled){this.policy.restart('Turned on.');this.walls=wallsKey();this.apply('fresh');}
    this.enabled=on;this.note=note;this.render();
  }
  // A generation already running was built with the earlier settings, and so
  // is one queued until the worker is ready (main.js pendingBegin).
  apply(phase){
    if(typeof applyTrainingPreset==='function')applyTrainingPreset(phase);
    const serial=runSerial(),queued=typeof pendingBegin!=='undefined'&&!!pendingBegin;
    this.judgeFrom=serial===null?null:serial+(queued?2:1);
  }
  // A new track starts again at Fresh. utils.js calls this before the phase-4
  // panel begins a generation; onGeneration calls it for other track changes.
  syncTrack(){
    if(!this.enabled)return false;
    const walls=wallsKey();
    if(!walls||walls===this.walls)return false;
    const changed=this.walls!==null;this.walls=walls;
    if(changed){this.policy.restart('New track: started again at Fresh.');this.apply('fresh');this.render();}
    return changed;
  }
  // Called by main.js after each generation is recorded, before the next begins.
  onGeneration(result){
    if(!this.enabled)return null;
    if(this.syncTrack())return 'fresh';
    if(this.judgeFrom!==null&&Number.isInteger(result?.runSerial)&&result.runSerial<this.judgeFrom){this.render();return null;}
    const phase=this.policy.observe(result,window.DriverLearning?.healthState||null,healthReady());
    if(phase||this.drifted())this.apply(this.policy.phase);
    this.render();return phase;
  }
  // Other code can change a knob without a user event: turning multiplayer on
  // forces 1× and turning it off does not restore the speed. Re-apply the
  // phase's preset before the next generation. The 1× of multiplayer and of
  // recording your driving stays.
  drifted(){
    const p=typeof TRAINING_PRESETS!=='undefined'&&TRAINING_PRESETS[this.policy.phase];
    if(!p||typeof batchSize==='undefined')return false;
    return batchSize!==p.N||Number(nextSeconds)!==p.seconds||Number(mutateValue)!==p.mutate||
      Number(conservativeInit)!==p.conservativeInit||(!(window.LiveSession?.enabled||window.DemonstrationRecorder?.recording)&&simSpeed!==p.simSpeed);
  }
  render(){
    const button=typeof document!=='undefined'&&document.getElementById('autoTrainToggle');if(!button)return;
    const label=`🤖 Auto Train: ${this.enabled?'on':'off'}`;
    if(button.textContent!==label)button.textContent=label;
    button.setAttribute('aria-pressed',String(this.enabled));
    document.querySelectorAll('#trainingPresets [data-preset]').forEach(b=>b.classList.toggle('auto-active',this.enabled&&b.dataset.preset===this.policy.phase));
    document.getElementById('trainingTuning')?.classList.toggle('auto-locked',this.enabled);
    const lock=document.getElementById('autoTrainLock');if(lock)lock.hidden=!this.enabled;
    const status=document.getElementById('autoTrainStatus');
    const text=this.enabled?`Auto Train · ${NAMES[this.policy.phase]}. ${this.policy.reason} ${this.policy.nextStep()}`:this.note;
    if(status&&status.textContent!==text)status.textContent=text;
  }
}
export const autoTrain=new AutoTrain();

if(typeof document!=='undefined'){
  window.AutoTrain=autoTrain;
  // Delegated, so the listeners survive re-renders of the training panel.
  // Programmatic value changes (the presets, this module) fire no events.
  const TUNING='#trainingTuning input, #trainingTuning select',TUNED='Auto Train off: you changed a training setting.';
  const userOverride=event=>{
    if(!autoTrain.enabled||!event.isTrusted||!(event.target instanceof Element))return;
    if(event.type==='click'){
      const preset=event.target.closest('#trainingPresets [data-preset]');
      if(preset)autoTrain.setEnabled(false,`Auto Train off: you chose ${NAMES[preset.dataset.preset]}.`);
      else if(event.target.closest('#trainingTuning .ai-small-grid button'))autoTrain.setEnabled(false,TUNED);
    }else if(event.target.matches(TUNING))autoTrain.setEnabled(false,TUNED);
  };
  for(const type of ['click','input','change'])document.addEventListener(type,userOverride,true);
  // A click on the toggle before this module loaded.
  if(window.__autoTrainPending){delete window.__autoTrainPending;autoTrain.setEnabled(true);}
  autoTrain.render();
}
