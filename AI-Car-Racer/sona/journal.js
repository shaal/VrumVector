// A bounded set of successful circuit examples, not an engine checkpoint.
// These can be replayed through processTask when the SONA agent is recreated.
export class CircuitJournal {
  constructor(limit=32,dimension=512){this.limit=limit;this.dimension=dimension;this.examples=[];}
  clear(){this.examples=[];}
  remember(vector,quality){
    if(!vector||vector.length!==this.dimension||!Number.isFinite(quality)||quality<.15||quality>1)return false;
    const values=Array.from(vector);if(!values.every(Number.isFinite)||!values.some(v=>v!==0))return false;
    const index=this.examples.findIndex(e=>e.vector.every((v,i)=>v===values[i]));
    if(index>=0){quality=Math.max(quality,this.examples[index].quality);this.examples.splice(index,1);}
    this.examples.unshift({vector:values,quality});this.examples.length=Math.min(this.limit,this.examples.length);return true;
  }
  serialize(){return {version:1,examples:this.examples.map(e=>({vector:e.vector.slice(),quality:e.quality}))};}
  restore(snapshot){
    this.clear();if(snapshot?.version!==1||!Array.isArray(snapshot.examples))return;
    for(const e of snapshot.examples.slice(0,this.limit).reverse())this.remember(e?.vector,e?.quality);
  }
}
