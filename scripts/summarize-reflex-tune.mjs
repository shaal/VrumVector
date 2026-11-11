// Summarize scripts/benchmark-reflex-tune.mjs output: per track and population,
// lapped counts, medians (censored = cap), sooner/later/tie, and tuner time.
//   node scripts/summarize-reflex-tune.mjs test-results/rt/*.jsonl
import {readFile} from 'node:fs/promises';
const rows=[];
for(const file of process.argv.slice(2))for(const line of (await readFile(file,'utf8')).split('\n'))if(line.trim())rows.push(JSON.parse(line));
const median=a=>{const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const groups=new Map();
for(const r of rows){const k=`N=${r.population} ${r.track}`;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
for(const [k,list] of groups){
  const cap=list[0].generations,v=x=>x??cap;
  const f=list.map(r=>v(r.fixed.firstLap)),t=list.map(r=>v(r.tuned.firstLap));
  let sooner=0,later=0,tie=0;f.forEach((a,i)=>{if(t[i]<a)sooner++;else if(t[i]>a)later++;else tie++;});
  const byFam=fam=>{const s=list.filter(r=>r.family===fam);return `${fam} ${median(s.map(r=>v(r.fixed.firstLap)))}→${median(s.map(r=>v(r.tuned.firstLap)))}`;};
  const mf=median(f),mt=median(t),ms=list.map(r=>r.tune.ms);
  console.log(`${k}: n=${list.length} lapped ${list.filter(r=>r.fixed.firstLap!==null).length}→${list.filter(r=>r.tuned.firstLap!==null).length} · median ${mf}→${mt} (${mf?Math.round(100*(mf-mt)/mf):0}% fewer; ${byFam('s1')}, ${byFam('s2')}) · mean ${(f.reduce((a,b)=>a+b)/f.length).toFixed(1)}→${(t.reduce((a,b)=>a+b)/t.length).toFixed(1)} · sooner/later/tie ${sooner}/${later}/${tie} · tune ${Math.min(...ms)}–${Math.max(...ms)} ms, changed ${list.filter(r=>r.tune.score>r.tune.defaultScore).length}/${list.length}`);
  console.log('  pairs: '+list.map(r=>`${r.family}#${r.run}: ${r.fixed.firstLap??'>'+(cap-1)} / ${r.tuned.firstLap??'>'+(cap-1)}`).join(', '));
}
