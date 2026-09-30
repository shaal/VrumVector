// The static server every browser test runs: scripts/static-server.py, which
// is `python3 -m http.server` with a listen queue of 256 instead of 5 (the
// stock queue resets connections under a page load's burst of module
// requests on a busy machine). It serves the repo root.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(new URL('../../scripts/static-server.py', import.meta.url));

export function startStaticServer(port, host = '127.0.0.1') {
  return spawn('python3', [script, String(port), '--bind', host], {cwd: root, stdio: 'ignore'});
}
