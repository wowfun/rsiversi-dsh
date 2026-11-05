import {createHash} from 'node:crypto';
import {glob,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writePayload,writePayloadFiles} from '../packages/rsi-dsh-cordis/src/archive/payload.mjs';

const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
const json = value=>Buffer.from(JSON.stringify(value,null,2)+'\n');

export async function writeNpmToolchain(destination,npmRoot,target) {
  const npm=JSON.parse(await readFile(join(npmRoot,'package.json'),'utf8'));
  if(npm.name!=='npm') throw new Error('Expected a published npm package directory');
  const name='rsi-dsh-npm', directory=join(destination,name);
  await mkdir(directory);
  const tree=await writePayload(npmRoot,join(directory,'npm.rsi'),{prefix:'node_modules/npm'});
  const manifest=json({format:2,name,version:npm.version,target,dependencies:[],requires:[],
    files:[{path:'npm.rsi',bytes:tree.bytes,digest:tree.digest,executable:false}],
    exports:{runtime:{kind:'payload_tree',path:'npm.rsi'}}});
  await writeFile(join(directory,'package.json'),manifest);
  return {name,digest:sha(manifest)};
}

/** The selection narrows executable package roots to this leased layout. */
export async function writeSelection(destination,version,target,plugins,locations,artifacts,toolchain) {
  const name='rsi-dsh-selection-'+sha(json(plugins)).slice(0,16);
  const dir=join(destination,name); await mkdir(dir);
  const body=json({format:1,runtime:'@deepseek-ai/dsh',version,plugins,locations,toolchain});
  const source=join(dir,'layout.json');
  await writeFile(source,body);
  const files = [{path:'layout.json',source,bytes:body.length}];
  const packages=fileURLToPath(new URL('../packages/',import.meta.url));
  const domains=[
    'rsi-dsh-cordis/src/{archive,release}/**/*.mjs',
    'rsi-dsh-cordis/src/{registry/{npm-install,requirements},runtime/{frames,node,transport}}.mjs',
    'rsi-dsh-plugin-bridge/src/{agent,application,history,market,session,terminal,tools,workbench}/**/*.mjs',
    'rsi-dsh-plugin-bridge/src/browser/{brand-host.mjs,brand.client.js,rsiversi.svg}',
  ];
  const exclude=['**/plan-intent.mjs','**/fork-transfer.mjs','**/extension/**'];
  const paths=[];
  for await(const path of glob(domains,{cwd:packages,exclude}))paths.push(path.replaceAll('\\','/'));
  for(const path of paths.sort()){
    const file=join(packages,path);
    files.push({path,source:file,bytes:(await stat(file)).size});
  }
  const data=await writePayloadFiles(files,join(dir,'profile.rsi'));
  const local = path => ({kind:'path',location:{payload:'profile',path}});
  const runtimeArgs=artifacts.flatMap(row=>[{kind:'literal',value:row.name},
    {kind:'path',location:{package:row.name,payload:'runtime',path:''}}]);
  const descriptor=json({format:1,cwd:{package:null,payload:'profile',path:''},
    arguments:[local('rsi-dsh-plugin-bridge/src/application/entry.mjs'),{kind:'generation'},local('layout.json'),
      ...runtimeArgs]});
  await writeFile(join(dir,'application.json'),descriptor);
  const runtimeDependencies=artifacts.map(row=>({name:row.name,digest:row.manifestDigest}));
  const bytes=json({format:2,name,version,target,
    dependencies:runtimeDependencies,
    requires:[{name:'rsi.extension.process',version:1}],
    files:[{path:'profile.rsi',bytes:data.bytes,digest:data.digest,executable:false},
      {path:'application.json',bytes:descriptor.length,digest:sha(descriptor),executable:false}],
    exports:{profile:{kind:'payload_tree',path:'profile.rsi'},application:{kind:'process_extension',path:'application.json'}}});
  await writeFile(join(dir,'package.json'),bytes);
  const selection={name,digest:sha(bytes)};
  let importer;
  if(toolchain) {
    const importerName='rsi-dsh-registry-importer',importerDir=join(destination,importerName);
    await mkdir(importerDir);
    const appPath=path=>({kind:'path',location:{package:name,payload:'profile',path}});
    const launch=json({format:1,cwd:{package:name,payload:'profile',path:''},
      arguments:[appPath('rsi-dsh-plugin-bridge/src/application/entry.mjs'),{kind:'generation'},appPath('layout.json'),
        ...runtimeArgs,{kind:'literal',value:'--npm'},
        {kind:'path',location:{package:toolchain.name,payload:'runtime',path:'node_modules/npm'}}]});
    await writeFile(join(importerDir,'import.json'),launch);
    const manifest=json({format:2,name:importerName,version,target,dependencies:[selection,...runtimeDependencies,toolchain],
      requires:[{name:'rsi.extension.process',version:1},{name:'rsi.packages.importer',version:1}],
      files:[{path:'import.json',bytes:launch.length,digest:sha(launch),executable:false}],
      exports:{import:{kind:'package_importer',path:'import.json'}}});
    await writeFile(join(importerDir,'package.json'),manifest);
    importer={name:importerName,digest:sha(manifest)};
  }
  await writeFile(join(destination,'receipt.json'),json({format:1,version,plugins,selection,toolchain,importer,artifacts}));
}
