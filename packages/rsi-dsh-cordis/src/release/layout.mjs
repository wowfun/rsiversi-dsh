import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { walkFiles } from '../archive/tree.mjs';

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const treeLimit = 16384, entryLimit = 65536, byteLimit = 4 * 1024 ** 3;

// A lock location is also the package's Node lookup ancestry. Never turn a
// key from an external package-lock into a path before validating every name.
export function packageLocation(location) {
  if (typeof location !== 'string' || location.length > 1024 || !location.startsWith('node_modules/'))
    throw new Error('Invalid lock location');
  const names = location.slice(13).split('/node_modules/');
  if (names.length > 128 || names.some(name => name.length > 214 || !packageName.test(name)))
    throw new Error('Invalid package name in lock location: '+location);
  return names.at(-1);
}

function lookup(records, parent, name) {
  if (!packageName.test(name)) throw new Error('Invalid dependency name: '+name);
  while (parent) {
    const candidate = parent+'/node_modules/'+name;
    if (records.has(candidate)) return candidate;
    const offset = parent.lastIndexOf('/node_modules/');
    parent = offset < 0 ? '' : parent.slice(0,offset);
  }
  const root = 'node_modules/'+name;
  return records.has(root) ? root : undefined;
}

export async function releaseLayout(root, runtimeRoots, pluginRoots, signal, reuseRuntime = false, build) {
  root = await realpath(root);
  const lockPath = join(root,'package-lock.json');
  if ((await lstat(lockPath)).size > 64*1024**2) throw new Error('npm lock capacity');
  const lock = JSON.parse(await readFile(lockPath,'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages || Object.keys(lock.packages).length > 32768)
    throw new Error('Unsupported release lock');
  const records = new Map();
  for (const [location, item] of Object.entries(lock.packages)) {
    if (!location) continue;
    const name = packageLocation(location);
    const directory = join(root,location);
    let stat;
    try { stat = await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT' && item.optional) continue; throw error; }
    if (!stat.isDirectory() || item.link || relative(root,await realpath(directory)).split(sep).join('/') !== location)
      throw new Error('Unexpected installed package location: '+location);
    const manifest = JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
    if (manifest.version !== item.version) throw new Error('Installed version differs from lock: '+location);
    records.set(location,{location,name,version:item.version, item, directory, owners:new Set(), dependencies:{}});
  }
  for (const record of records.values()) {
    const {item} = record;
    for (const name of Object.keys({...item.dependencies,...item.optionalDependencies,...item.peerDependencies})) {
      const found = lookup(records,record.location,name);
      if (found) record.dependencies[name] = found;
      else if (!Object.hasOwn(item.optionalDependencies ?? {},name) && !item.peerDependenciesMeta?.[name]?.optional)
        throw new Error('Missing dependency '+name+' at '+record.location);
    }
  }
  function mark(rootName, owner) {
    if (!packageName.test(rootName)) throw new Error('Invalid root package');
    const todo = ['node_modules/'+rootName];
    while (todo.length) {
      const record = records.get(todo.pop());
      if (!record) throw new Error('Unresolved profile root: '+rootName);
      if (record.owners.has(owner)) continue;
      record.owners.add(owner); todo.push(...Object.values(record.dependencies));
    }
  }
  for (const name of runtimeRoots) mark(name,'runtime');
  for (const name of pluginRoots) mark(name,name);
  if(build) {
    const builds=[...records.values()].filter(row=>row.owners.size && !row.owners.has('runtime')
      && !row.item.inBundle && row.item.hasInstallScript);
    if(await build(builds)) return releaseLayout(root,runtimeRoots,pluginRoots,signal,reuseRuntime);
  }
  const groups = new Map();
  for (const record of [...records.values()].sort((a,b)=> a.location < b.location ? -1 : 1)) {
    if (!record.owners.size) continue;
    const owner = record.owners.has('runtime') ? 'runtime' : [...record.owners].sort().join('+');
    const files = [];
    if (!reuseRuntime || owner !== 'runtime') await walkFiles(record.directory, async (path,bytes) => {
      files.push({path:record.location+'/'+path, source:resolve(record.directory,path), bytes});
    }, {signal, exclude:path=>path==='node_modules'});
    const group = groups.get(owner) ?? [];
    group.push({location:record.location, dependencies:record.dependencies, version:record.version, files});
    groups.set(owner,group);
  }
  return groups;
}

/** Pack whole npm packages together, preserving all package-private files. */
export function splitPayloads(packages) {
  const shards = [];
  let current, count, bytes, directories;
  function reset() { current=[]; count=0; bytes=0; directories=new Set(); }
  reset();
  for (const pkg of packages) {
    const dirs = new Set(), size = pkg.files.reduce((sum,f)=>sum+f.bytes,0);
    for (const file of pkg.files) {
      for (let parent=dirname(file.path).replaceAll('\\','/'); parent!=='.'; parent=dirname(parent).replaceAll('\\','/')) dirs.add(parent);
    }
    if (!pkg.files.length || pkg.files.length>treeLimit || size>byteLimit || dirs.size+pkg.files.length>entryLimit)
      throw new Error('Package exceeds a payload: '+pkg.location);
    if (current.length && (count+pkg.files.length>treeLimit || bytes+size>byteLimit ||
      count+pkg.files.length+directories.size+dirs.size>entryLimit)) {
      shards.push(current); reset();
    }
    current.push(pkg); count+=pkg.files.length; bytes+=size;
    for(const dir of dirs) directories.add(dir);
  }
  if(current.length) shards.push(current);
  return shards;
}

/** A separately launched Node runner uses ordinary on-disk npm resolution. */
export function runtimePayloads(packages) {
  const byLocation=new Map(packages.map(pkg=>[pkg.location,pkg]));
  const runners=new Set(packages.filter(pkg=>pkg.location.endsWith('/@deepseek-ai/dsh-subprocess-local') ||
    pkg.location.endsWith('/@deepseek-ai/dsh-sandbox-windows-acl')));
  // Set iteration visits newly added packages and terminates on shared or cyclic edges.
  for(const pkg of runners)
    for(const location of Object.values(pkg.dependencies))runners.add(byLocation.get(location));
  const shards=splitPayloads([...runners,...packages.filter(pkg=>!runners.has(pkg))]);
  if(runners.size && shards[0].length<runners.size)
    throw new Error('The DSH subprocess runners and their dependencies exceed one runtime payload');
  return shards;
}
