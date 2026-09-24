// One arm of a paired transfer trial: a short genetic run that starts either
// from a fixed seed pool (memories) or from fresh random drivers. Pure: the
// caller supplies simulate(flat) -> {fitness, styleScore, popN, popStillAlive,
// vector, driving} for one generation, so the same loop runs in the browser
// trial worker and in Node tests.
import {LearningCoach,buildPopulation} from './policy.js';

export const TRIAL_DEFAULTS={generations:6,population:24,mutation:.22,conservative:.65};

export function runTrialArm({simulate,context,seeds=[],random,exploration=1,...options}){
  const {generations,population,mutation,conservative}={...TRIAL_DEFAULTS,...options};
  const coach=new LearningCoach();coach.setContext(context);let lastMean=0;
  for(let generation=0;generation<generations;generation++){
    // Fixed exploration, as with the default live setting.
    const plan=coach.plan(mutation,false,exploration);
    const batch=buildPopulation({N:population,seeds,incumbent:coach.incumbent,plan,random,conservative});
    const result=simulate(batch.flat);coach.record(result,result.vector);
    lastMean=Number.isFinite(result.meanProgress)?result.meanProgress:result.fitness;
  }
  const best=coach.incumbent?.fitness??0,curve=coach.history.map(row=>row.best);
  // area: summed champion progress over generations (who got there first).
  return {best,area:curve.reduce((sum,v)=>sum+v,0),lastMean,history:coach.history.map(row=>row.fitness)};
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
