import {mkdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {writeNpmToolchain,writeSelection} from './market-selection.mjs';

// The installable application starts with the release runtime only. The
// market and sidebar get their own immutable selections when actually added.
const [corpus,destination,npmRoot]=process.argv.slice(2).map(path=>resolve(path));
const receipt=JSON.parse(await readFile(join(corpus,'receipt.json'),'utf8'));
const previous=JSON.parse(await readFile(join(corpus,receipt.selection.name,'layout.json'),'utf8'));
const manifest=JSON.parse(await readFile(join(corpus,receipt.selection.name,'package.json'),'utf8'));
const artifacts=receipt.artifacts.filter(row=>row.owner==='runtime');
const names=new Set(artifacts.map(row=>row.name));
const locations=Object.fromEntries(Object.entries(previous.locations).filter(([,row])=>names.has(row.package)));
await mkdir(destination,{recursive:false});
const toolchain=await writeNpmToolchain(destination,npmRoot,manifest.target);
await writeSelection(destination,receipt.version,manifest.target,[],locations,artifacts,toolchain);
