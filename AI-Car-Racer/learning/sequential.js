// Anytime-valid paired test by betting, ported from ruvnet/ruvector
// crates/ruvector-typesafe-core/src/loop_gate/sequential.rs (MIT).
//
// Each paired trial where exactly one arm won updates the wealth
// W <- W * (1 + lambda * (X - 1/2)), X = 1 when the champion won. Ties carry
// no paired information and are skipped. If the champion is not better, X is a
// fair coin, W is a non-negative martingale, and Ville's inequality bounds the
// chance that W ever reaches 1/alpha by alpha. So the test can be checked
// after every trial and stopped at any time. Rejection latches.
//
// Validity needs each pair to be a fresh, independent trial. Successive
// generations of one training run are not: a lucky early champion keeps
// winning, so never feed live generations into this test.
export class PairedSequentialTest {
  constructor({alpha=.05,lambda=.5}={}){
    this.alpha=Math.min(.5,Math.max(1e-6,alpha));
    this.lambda=Math.min(1.99,Math.max(.01,lambda));
    this.wealth=1;this.maxWealth=1;this.championWins=0;this.baselineWins=0;this.ties=0;
    this.rejected=false;this.decisiveAtRejection=null;
  }
  get threshold(){return 1/this.alpha;}
  // Feed one paired trial outcome. Returns true once rejection has latched.
  update(baselineWon,championWon){
    if(!!baselineWon===!!championWon){this.ties++;return this.rejected;}
    if(championWon)this.championWins++;else this.baselineWins++;
    this.wealth*=1+this.lambda*((championWon?1:0)-.5);
    this.maxWealth=Math.max(this.maxWealth,this.wealth);
    if(!this.rejected&&this.maxWealth>=this.threshold){
      this.rejected=true;this.decisiveAtRejection=this.championWins+this.baselineWins;
    }
    return this.rejected;
  }
  static fromJSON(state){
    const test=new PairedSequentialTest({alpha:state?.alpha,lambda:state?.lambda});
    for(const key of ['wealth','maxWealth','championWins','baselineWins','ties'])if(Number.isFinite(state?.[key]))test[key]=state[key];
    test.rejected=state?.rejected===true;test.decisiveAtRejection=Number.isFinite(state?.decisiveAtRejection)?state.decisiveAtRejection:null;
    return test;
  }
  toJSON(){
    const {alpha,lambda,wealth,maxWealth,championWins,baselineWins,ties,rejected,decisiveAtRejection}=this;
    return {alpha,lambda,wealth,maxWealth,championWins,baselineWins,ties,rejected,decisiveAtRejection};
  }
}
