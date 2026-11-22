import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {installNpm,rebuildApproved} from '../../src/registry/npm-install.mjs';
import {releaseLayout} from '../../src/release/layout.mjs';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {runtimeEnvironment} from '../../src/runtime/node.mjs';

const npm=process.env.RSI_DSH_NPM_ROOT;
test('registry script decisions use the resolved version for each instance',async()=>{
  const instance=version=>({name:'@sample/build',version,location:'node_modules/@sample/build',
    item:{resolved:'https://registry.example/build-'+version+'.tgz'}});
  const builds=[instance('1.0.0'),instance('2.0.0')];
  const review=policy=>rebuildApproved(undefined,'','',builds,policy,new AbortController().signal);
  await assert.rejects(review({}),{message:'Ignored build scripts: @sample/build@1.0.0, @sample/build@2.0.0'});
  await assert.rejects(review({'@sample/build@1.0.0':true}),{message:'Ignored build scripts: @sample/build@2.0.0'});
  assert.equal(await review({'@sample/build':true,'@sample/build@1.0.0':false,'@sample/build@2.0.0':false}),false);
});
test('real npm stages both scripts inert and runs only the approved resolved instance', {skip:!npm},async t=>{
  const base=await mkdtemp(join(tmpdir(),'rsi-build-review-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const root=join(base,'stage'),work=join(base,'work'),names=['build-first','build-second'];
  await mkdir(root);await mkdir(work);
  await writeFile(join(root,'package.json'),'{"name":"build-check","private":true}');
  for(const name of names) {
    const dir=join(base,name);await mkdir(dir);
    await writeFile(join(dir,'package.json'),JSON.stringify({name,version:'1.0.0',scripts:{postinstall:'node build.cjs'}}));
    await writeFile(join(dir,'build.cjs'),"require('node:fs').appendFileSync('receipt','built\\n');");
  }
  const signal=AbortSignal.timeout(60000);
  await installNpm(npm,root,work,names.map(name=>join(base,name)),signal,'http://127.0.0.1:1/');
  const marker=name=>join(root,'node_modules',name,'receipt');
  for(const name of names) await assert.rejects(readFile(marker(name)),{code:'ENOENT'});
  const layout=policy=>releaseLayout(root,[],names,signal,true,
    builds=>rebuildApproved(npm,root,work,builds,policy,signal));
  await assert.rejects(layout({}),/Ignored build scripts: build-first, build-second/);
  const groups=await layout({'build-first':true,'build-second':false});
  assert.equal(await readFile(marker('build-first'),'utf8'),'built\n');
  await assert.rejects(readFile(marker('build-second')),{code:'ENOENT'});
  assert.ok(groups.get('build-first')[0].files.some(file=>file.path.endsWith('/receipt')));
  if(process.platform==='win32'){
    const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`
      import {workerData} from 'node:worker_threads';
      const {rebuildApproved}=await import(workerData.module);
      await rebuildApproved(...workerData.args,new AbortController().signal);
    `)),{env:{...runtimeEnvironment(),Path:process.env.PATH},workerData:{
      module:new URL('../../src/registry/npm-install.mjs',import.meta.url).href,
      args:[npm,root,work,[{name:'build-second',version:'1.0.0',location:'node_modules/build-second',
        item:{resolved:'file:../build-second'}}],{'build-second':true}],
    }});
    assert.equal((await once(worker,'exit'))[0],0);
    assert.equal(await readFile(marker('build-second'),'utf8'),'built\n');
  }
});
