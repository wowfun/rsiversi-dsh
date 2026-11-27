import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';
import { maximumBytes, maximumEntries, walkFiles } from '../archive/tree.mjs';
import { maximumHeaderBytes } from '../archive/payload.mjs';

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

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

// The standalone DSH release selects one engine for its Office provider.
// Other packages keep their own dependency edges, including explicit WASM use.
function selectOfficeEngine(kit, {platform, arch}) {
  const optional = kit.item.optionalDependencies ?? {};
  const prefix = kit.name+'-';
  const native = prefix+platform+'-'+arch;
  const selected = Object.hasOwn(optional,native) ? native : prefix+'wasm';
  if (!Object.hasOwn(kit.dependencies,selected))
    throw new Error('Missing dependency '+selected+' at '+kit.location);
  for (const name of Object.keys(optional)) {
    if (name.startsWith(prefix) && name !== selected) delete kit.dependencies[name];
  }
}

export async function releaseLayout(root, runtimeRoots, pluginRoots, signal, {hostPeers,build,runtimeTarget}={}) {
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
      else if (pluginRoots.length && Object.hasOwn(item.peerDependencies ?? {},name) && !Object.hasOwn(item.dependencies ?? {},name)) {
        if(hostPeers && Object.hasOwn(hostPeers,name))record.dependencies[name]='node_modules/'+name;
      }
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
      record.owners.add(owner);
      if(runtimeTarget && owner==='runtime' && record.name==='@deepseek-ai/libreoffice-kit')
        selectOfficeEngine(record,runtimeTarget);
      for(const dependency of Object.values(record.dependencies))if(records.has(dependency))todo.push(dependency);
    }
  }
  for (const name of runtimeRoots) mark(name,'runtime');
  for (const name of pluginRoots) mark(name,name);
  if(build) {
    const builds=[...records.values()].filter(row=>row.owners.size && !row.owners.has('runtime')
      && !row.item.inBundle && row.item.hasInstallScript);
    if(await build(builds)) return releaseLayout(root,runtimeRoots,pluginRoots,signal,{hostPeers,runtimeTarget});
  }
  const groups = new Map();
  for (const record of [...records.values()].sort((a,b)=> a.location < b.location ? -1 : 1)) {
    if (!record.owners.size) continue;
    const owner = record.owners.has('runtime') ? 'runtime' : [...record.owners].sort().join('+');
    const files = [];
    const terminalTarget = runtimeTarget && owner === 'runtime' && record.location === 'node_modules/node-pty'
      ? `${runtimeTarget.platform}-${runtimeTarget.arch}` : undefined;
    if (!hostPeers || owner !== 'runtime') await walkFiles(record.directory, async (path,bytes,executable) => {
      files.push({path:record.location+'/'+path, source:resolve(record.directory,path), bytes, executable});
    }, {signal, exclude:(path,entry)=>path==='node_modules' ||
      (terminalTarget && entry.isDirectory() && path==='prebuilds/'+entry.name && entry.name!==terminalTarget)});
    const group = groups.get(owner) ?? [];
    group.push({location:record.location, dependencies:record.dependencies, version:record.version, files});
    groups.set(owner,group);
  }
  return groups;
}

function* dependencyComponents(packages) {
  const byLocation = new Map(packages.map(pkg => [pkg.location, pkg]));
  const neighbors = new Map(packages.map(pkg => [pkg, new Set()]));
  for (const pkg of packages) {
    for (const location of Object.values(pkg.dependencies)) {
      const dependency = byLocation.get(location);
      if (dependency) {
        neighbors.get(pkg).add(dependency);
        neighbors.get(dependency).add(pkg);
      }
    }
  }
  for (const root of neighbors.keys()) {
    const component = new Set([root]);
    for (const pkg of component) {
      for (const dependency of neighbors.get(pkg)) component.add(dependency);
      neighbors.delete(pkg);
    }
    yield component;
  }
}

const digestPlaceholder = '0'.repeat(64);
const emptyHeaderBytes = Buffer.byteLength(JSON.stringify({ format: 1, files: [] }));

function footprint(packages) {
  const directories = new Set();
  let files = 0, body = 0, records = 0;
  for (const pkg of packages) {
    if (!pkg.files.length) throw new Error('Empty release package: '+pkg.location);
    for (const {path, bytes, executable = false} of pkg.files) {
      files++;
      body += bytes;
      records += Buffer.byteLength(JSON.stringify({path, bytes, digest:digestPlaceholder, executable})) + 1;
      for (let parent = posix.dirname(path); parent !== '.' && !directories.has(parent); parent = posix.dirname(parent)) {
        directories.add(parent);
      }
    }
  }
  return { directories, files, body, records };
}

function fits(files, directories, records, body) {
  const header = emptyHeaderBytes + records - 1; // The first record has no leading comma.
  return files + directories <= maximumEntries && header <= maximumHeaderBytes && 12 + header + body <= maximumBytes;
}

/** Pack connected npm dependencies into the same ordinary on-disk lookup tree. */
export function splitPayloads(packages) {
  const shards = [];
  let shard, used;
  function pack(group) {
    const part = footprint(group);
    if (!fits(part.files, part.directories.size, part.records, part.body)) {
      if (group.length === 1) throw new Error('Package exceeds a payload: '+group[0].location);
      for (const pkg of group) pack([pkg]);
      return;
    }
    if (used) {
      let directories = used.directories.size;
      for (const directory of part.directories) {
        if (!used.directories.has(directory)) directories++;
      }
      if (fits(used.files + part.files, directories, used.records + part.records, used.body + part.body)) {
        for (const pkg of group) shard.push(pkg);
        used.files += part.files;
        used.records += part.records;
        used.body += part.body;
        for (const dir of part.directories) used.directories.add(dir);
        return;
      }
    }
    used = part;
    shard = group;
    shards.push(shard);
  }
  for (const component of dependencyComponents(packages)) pack([...component]);
  return shards;
}
