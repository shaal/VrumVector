// Short chapter explaining the "Pure Local Signals" comparison experiment.
// Registered in eli15/index.js and linked from the Experiments panel.
export default {
  id: 'pure-local-experiment',
  title: 'Pure local signals vs track hints',
  oneLiner: 'What happens when we remove the "next checkpoint" features and force the brain to drive from raw sensors only?',
  body: [
    '<p>This experiment lets you directly compare two versions of the same brain:</p>',
    '<ul>',
    '<li><strong>Normal mode</strong> — the network receives the usual 10 inputs: 7 ray readings + speed + two extra "track orientation" features (lf + lr). These two features quietly tell the brain the direction and distance to the next checkpoint in its own local frame.</li>',
    '<li><strong>Pure local mode</strong> (enable with the 🧪 Experiments toggle or <code>?pure-local=1</code>) — lf and lr are forced to zero. The brain only sees the raw rays + its own speed. No explicit hint about where the next gate is.</li>',
    '</ul>',
    '<p>The goal is to understand how much the current system relies on those hidden "map-like" signals versus learning to drive from truly local, embodied perception — the kind a real car or robot would have.</p>',
    '<h3>Why this matters on hard tracks like Triangle</h3>',
    '<p>On easy tracks the extra features are convenient but not essential. On the Triangle the difference becomes dramatic because the critical 180° turn requires anticipation. A brain that only reacts to what its rays see <em>right now</em> often discovers the wall too late.</p>',
    '<p>This mode is deliberately not "better" — it is a diagnostic tool. Use it (ideally with <code>?rv=0</code> for a clean GA baseline) to feel how much the network depends on the extra signals versus raw sensor data.</p>',
    '<h3>Try it yourself</h3>',
    '<ul>',
    '<li>Toggle "Pure local sensors (no lf/lr)" in the 🧪 Experiments panel.</li>',
    '<li>Watch the persistent <code>👁️ PURE LOCAL</code> badge at the top.</li>',
    '<li>Restart training and compare behavior (and the brain input bars) against a normal run.</li>',
    '<li>Look at the brain visualization: the last two input bars will stay near zero.</li>',
    '</ul>',
  ].join('\n'),
  related: [
    'why-cars-crash',
    'sensors',
    'neural-network',
  ],
};
