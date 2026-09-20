export default {
  id:'gnn',title:'GNN reranker — learning from related drivers',
  oneLiner:'An experimental neural network learns which archived drivers produce useful descendants.',
  body:[
    '<p>Every saved driver is a node. Its parents send it messages containing their driving history. The graph model combines those messages with the driver’s own results, track similarity, driving style, and vehicle settings.</p>',
    '<p>After the descendants race, their improvement or regression becomes a training example. The model changes both its message weights and its scoring weights. Inputs are captured before the race result arrives. Its weights and optimizer state survive browser reloads.</p>',
    '<p>One fifth of track/style/vehicle contexts are reserved for evaluation and never used for training. The learning panel counts these held-out checks. A small measured error is useful evidence, but does not by itself prove faster racing or generalization to every track.</p>',
    '<p><strong>Auto uses the established EMA feedback.</strong> Choose <strong>gnn · experimental</strong> in Vector Memory to try the trained graph. It needs at least eight training outcomes; until then, or if its WASM cannot load, ranking uses EMA. Graph and EMA feedback are not counted twice.</p>',
    '<p>The model uses one mean-aggregation message pass over direct parents, followed by a learned nonlinear score. It does not recursively absorb the entire family tree or automatically reward a large family.</p>',
  ].join(''),
  diagram:'',related:['what-is-this-project'],
};
