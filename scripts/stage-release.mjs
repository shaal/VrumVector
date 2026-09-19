// A single HTML base selects an immutable app + vendor tree. Relative module,
// worker, CSS, and WASM URLs then stay within the same release, even when the
// custom-domain cache still holds files from a previous deployment.
import {cpSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
const [directory, revision] = process.argv.slice(2);
if (!directory || !/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Expected staging directory and commit SHA');
const stage = resolve(directory), release = join(stage, 'releases', revision);
mkdirSync(release, {recursive:true});
for (const name of ['AI-Car-Racer','vendor']) cpSync(join(stage,name),join(release,name),{recursive:true});
const entry = join(stage,'AI-Car-Racer/index.html');
const html = readFileSync(entry,'utf8').replace('<head>', `<head>\n    <base href="/releases/${revision}/AI-Car-Racer/">`);
writeFileSync(entry,html);
