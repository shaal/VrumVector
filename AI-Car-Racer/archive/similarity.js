// Every index the bridge searches returns a distance-like score where 0 means
// identical, so similarity is 1 - score, clamped to [0, 1]. For VectorDB the
// score is cosine distance (1 - cos) and the result is cosine similarity. The
// hyperbolic adapter's squashed Poincaré distance keeps the direction but is
// not cosine. A missing or non-numeric score is treated as no match.
export function similarityFromDistance(score){
  if(score==null||score==='')return 0;
  const distance=Number(score);
  return Number.isFinite(distance)?Math.max(0,Math.min(1,1-distance)):0;
}
