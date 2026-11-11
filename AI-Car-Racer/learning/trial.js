// One arm of a paired transfer trial: a short genetic run that starts either
// from a fixed seed pool (memories) or from fresh random drivers. Pure: the
// caller supplies simulate(flat, batch) -> {fitness, styleScore, popN, popStillAlive,
// vector, driving} for one generation, so the same loop runs in the browser
// trial worker and in Node tests.
import {LearningCoach,buildPopulation} from './policy.js';
import {applyReflexTuning} from './reflexTuner.js';

export const TRIAL_DEFAULTS={generations:6,population:24,mutation:.22,conservative:.65};

// reflexTuning (#70): the reflex car of a cold start uses this tuning
// (reflexTuner.js) instead of the fixed one. It needs reflex:true.
export function runTrialArm({simulate,context,seeds=[],random,exploration=1,returnChampion=false,sparse=null,reflex=false,reinjectReflex=null,reflexTuning=null,...options}){
  const {generations,population,mutation,conservative}={...TRIAL_DEFAULTS,...options};
  const coach=new LearningCoach();coach.setContext(context);let lastMean=0;
  for(let generation=0;generation<generations;generation++){
    // Fixed exploration, as with the default live setting.
    const plan=coach.plan(mutation,false,exploration);
    const batch=buildPopulation({N:population,seeds,incumbent:coach.incumbent,plan,random,conservative,sparse,reflex,reinjectReflex});
    if(reflexTuning)applyReflexTuning(batch,reflexTuning);
    const result=simulate(batch.flat,batch);coach.record(result,result.vector);
    lastMean=Number.isFinite(result.meanProgress)?result.meanProgress:result.fitness;
  }
  const best=coach.incumbent?.fitness??0,curve=coach.history.map(row=>row.best);
  // area: summed champion progress over generations (who got there first).
  // returnChampion adds the final incumbent's weights, so a benchmark can score it.
  return {best,area:curve.reduce((sum,v)=>sum+v,0),lastMean,history:coach.history.map(row=>row.fitness),
    ...(returnChampion?{champion:coach.incumbent?.vector??null}:{})};
}

// Which arm did better: final champion progress, then the same champion
// sooner (area). 1 = a, -1 = b, 0 = tie. The order is fixed in advance and
// treats both arms alike, so under "no difference" each decided trial is a
// fair coin. Population mean progress is reported but never decides: it
// measures how a population is made up (memory offspring vs fresh drivers),
// not how good its champion is.
export function compareOutcomes(a,b){
  for(const key of ['best','area']){
    const d=(a[key]??0)-(b[key]??0);
    if(Math.abs(d)>1e-9)return d>0?1:-1;
  }
  return 0;
}
