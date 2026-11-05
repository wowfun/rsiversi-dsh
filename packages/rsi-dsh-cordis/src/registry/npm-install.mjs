import {lstat,mkdir,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {basename,dirname,join,delimiter} from 'node:path';
import {createRequire} from 'node:module';
import {runtimeEnvironment} from '../runtime/node.mjs';

export const profileState=profile=>join(dirname(profile),'.selections',basename(profile));
export const registryCache=profile=>join(profileState(profile),'npm');

export function registryEnvironment(source=process.env) {
  const network={};
  for(const key of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY']) {
    const value=source[key.toLowerCase()]??source[key];
    if(!value)continue;
    if(key!=='NO_PROXY'){
      let url;try {url=new URL(value);} catch {continue;}
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;
    }
    network[key]=value;
  }
  if(network.HTTP_PROXY || network.HTTPS_PROXY) network.NODE_USE_ENV_PROXY='1';
  return network;
}

export async function moveRegistryCache(profile) {
  const legacy=join(profile,'cache','npm'),destination=registryCache(profile);
  const previous=await lstat(legacy).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(!previous?.isDirectory())return;
  await mkdir(profileState(profile),{recursive:true});
  const current=await lstat(destination).catch(error=>{if(error.code!=='ENOENT')throw error;});
  // A previous application version may have populated its old location
  // again. Preserve both sets of downloaded data outside the portable tree.
  await rename(legacy,current?destination+'-previous-'+randomUUID():destination);
}

export const npmImportFlags = Object.freeze(['--ignore-scripts','--bin-links=false','--install-links=true',
  '--allow-git=none','--allow-remote=none','--allow-file=root','--allow-directory=root',
    '--strict-peer-deps','--prefer-dedupe','--omit=dev','--no-audit','--no-fund','--update-notifier=false']);

export function registryUrl(value='https://registry.npmjs.org/') {
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid npm registry');
  return url.href;
}

/** Resolve the public registry manifest with the same npm resolver as install. */
export async function viewNpm(npmRoot,spec,fields,registry,cache,signal) {
  const require=createRequire(join(npmRoot,'package.json'));
  const parsed=require('npm-package-arg')(spec);
  if(!parsed.registry) throw new Error('Expected a named registry package');
  const manifest=await npmManifest(npmRoot,parsed,registry,cache,signal);
  return Object.fromEntries(fields.filter(field=>Object.hasOwn(manifest,field)).map(field=>[field,manifest[field]]));
}

export function npmManifest(npmRoot,spec,registry,cache,signal) {
  const require=createRequire(join(npmRoot,'package.json'));
  return require('pacote').manifest(spec,{registry:registryUrl(registry),cache,
    fullMetadata:true,preferOnline:true,fetchRetries:0,signal});
}

export async function installNpm(npmRoot, root, work, specs, signal,registry,cache) {
  await writeFile(join(work, 'npmrc'), 'registry='+registryUrl(registry)+'\n');
  await writeFile(join(work, 'global-npmrc'), '');
  await mkdir(join(work, 'home'));
  await runNpm(npmRoot,root,work,['install',...npmImportFlags,'--',...specs],signal,cache);
}

/** npm's unreviewed scripts can run during a normal install. Rebuild only
 * exact directories in the already resolved private graph. */
export async function rebuildApproved(npmRoot,root,work,builds,policy,signal,cache) {
  const pending=[...new Set(builds.filter(row=>!Object.hasOwn(policy,row.name)).map(row=>row.name))];
  if(pending.length) {
    // This line is consumed by the released Plugin Manager's recordPendingBuilds.
    const names=[];
    for(const name of pending) {
      if(names.join(', ').length+name.length>700) break;
      names.push(name);
    }
    throw new Error('Ignored build scripts: '+names.join(', '));
  }
  const approved=builds.filter(row=>policy[row.name]===true);
  if(!approved.length) return false;
  await runNpm(npmRoot,root,work,['rebuild','--offline','--bin-links=false','--',
    ...approved.map(row=>join(root,row.location))],signal,cache);
  return true;
}

async function runNpm(npmRoot,root,work,args,signal,cache=join(work,'cache')) {
  const env = { ...runtimeEnvironment(), ...registryEnvironment(), HOME:join(work,'home'), USERPROFILE:join(work,'home'),
    PATH:[dirname(process.execPath),process.env.PATH].filter(Boolean).join(delimiter),
    npm_config_userconfig:join(work,'npmrc'), npm_config_globalconfig:join(work,'global-npmrc'), npm_config_cache:cache };
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(npmRoot,'bin/npm-cli.js'),...args],
      {cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output = '', killed = false;
    const abort = () => { killed = true; child.kill(); };
    signal.addEventListener('abort', abort, {once:true}); if (signal.aborted) abort();
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes.toString()).slice(-8192); });
    child.once('error', reject);
    child.once('close', code => { signal.removeEventListener('abort', abort); if (killed) reject(new Error('Import cancelled')); else if (code) reject(new Error(`npm import failed (${code}): ${output}`)); else accept(); });
  });
  signal.throwIfAborted();
}
