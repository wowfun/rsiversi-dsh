import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { releaseLayout } from '../packages/rsi-dsh-cordis/src/release/layout.mjs';
import {writeShards} from '../packages/rsi-dsh-cordis/src/release/artifacts.mjs';
import { writeSelection } from './market-selection.mjs';

const [input, output, ...plugins] = process.argv.slice(2);
if (!input || !output || !plugins.length || new Set(plugins).size !== plugins.length)
  throw new Error('Expected strict npm stage, new output directory, and ordered plugin names');
const root = await realpath(input), destination = resolve(output);
const manifest = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const runtime = Object.keys(manifest.dependencies).filter(name=>!plugins.includes(name));
if (!runtime.includes('@deepseek-ai/dsh')) throw new Error('Unidentified DSH runtime');
const version = JSON.parse(await readFile(join(root,'node_modules/@deepseek-ai/dsh/package.json'),'utf8')).version;
const groups = await releaseLayout(root,runtime,plugins);
await mkdir(destination,{recursive:false});
const targetOS = {win32:'windows',linux:'linux',darwin:'macos'}[process.platform];
const targetCPU = {x64:'x86_64',arm64:'aarch64'}[process.arch];
if (!targetOS || !targetCPU) throw new Error('Unsupported package target');

const {artifacts,locations}=await writeShards(destination,groups,version,targetOS+'-'+targetCPU);
await writeSelection(destination,version,targetOS+'-'+targetCPU,plugins,locations,artifacts);
console.log('Packaged',Object.keys(locations).length,'npm instances into',artifacts.length,'leased objects.');
