import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';

export function crashProfile(profile,checkpoint=()=>{}) {
  let version='1.0.0',directory;
  const state=join(profile,'state'),rootsPath=join(profile,'roots.json');
  const digest=value=>(value==='1.0.0'?'a':'b').repeat(64);
  const payload=value=>join(profile,'payload-'+value);
  const modules={
    installationDependency(){},directory:()=>directory,
    prepare(layout){const target=payload(layout.locations['node_modules/fixture'].version);return {
      directory:()=>target,publish(){directory=target;return ()=>{};},
    };},
    add(layout){return modules.prepare(layout).publish();},
  };
  return {setVersion(value){version=value;},digest,payload,options:{profile,state,modules,
    boot:{readProfileManifest:(_,dir)=>JSON.parse(readFileSync(join(dir,'package.json'),'utf8')),
      readProfileVersionExemptions:()=>({}),getDshRuntimeVersion:()=>'',assertBundlePlatform(){},
      evaluatePluginCompatibility(){},bundlePatchPaths:()=>[],composeEntries:()=>[]},
    active:()=>true,reconcile(){checkpoint('reconciled');},
    async call(method,args){
      if(method==='application.roots'){
        const current=await fs.readFile(rootsPath,'utf8').then(JSON.parse).catch(error=>{if(error.code!=='ENOENT')throw error;return {};});
        if(args.next){await fs.writeFile(rootsPath,JSON.stringify(args.next));
          if(args.next[digest('2.0.0')])checkpoint('roots');return null;}
        return current;
      }
      if(method==='application.stage')return {stage:version,packages:{'rsi-dsh-selection-fixture':digest(version)}};
      if(method==='application.payloads')return {profile:payload(args.digest===digest('1.0.0')?'1.0.0':'2.0.0'),roots:{}};
      if(method==='application.stage.release'||method==='application.release')return null;
      throw Error('unexpected '+method);
    },
  }};
}

if(import.meta.main){
  const [profile,point]=process.argv.slice(2);let armed=false;
  const checkpoint=name=>{if(armed&&name===point)process.exit(71);};
  const fixture=crashProfile(profile,checkpoint);
  const rename=fs.rename;
  fs.rename=async(from,to)=>{
    await rename(from,to);
    if(!armed)return;
    if(to===join(profile,'state/selections.json.recovery'))checkpoint('snapshot');
    if(to===join(profile,'state/selections.json')){
      const value=JSON.parse(await fs.readFile(to,'utf8'));
      if(value.rollback)checkpoint('intent');else checkpoint('committed');
    }
    if(to===join(profile,'package.json'))checkpoint('links');
  };
  syncBuiltinESMExports();
  const {createMarketProfile}=await import('../../src/market/market-profile.mjs');
  for(const version of ['1.0.0','2.0.0']){
    await fs.mkdir(fixture.payload(version));
    await fs.writeFile(join(fixture.payload(version),'package.json'),JSON.stringify({name:'fixture',version,dsh:{bundle:{}}}));
    await fs.writeFile(join(fixture.payload(version),'layout.json'),JSON.stringify({plugins:['fixture'],locations:{'node_modules/fixture':{version}}}));
  }
  const market=await createMarketProfile(fixture.options);
  const signal=new AbortController().signal,log={write(){}};
  const first=await market.prepare('fixture@1.0.0',signal,undefined,log);
  await market.exclusive(()=>market.commitBundle(first,true,()=>{},signal));await first.dispose();
  await fs.copyFile(join(profile,'package.json'),join(profile,'before.json'));
  armed=true;fixture.setVersion('2.0.0');
  const candidate=await market.prepare('fixture@2.0.0',signal,undefined,log);checkpoint('prepared');
  await market.exclusive(()=>market.commitBundle(candidate,true,()=>{},signal));
  throw Error('crash point was not reached: '+point);
}
