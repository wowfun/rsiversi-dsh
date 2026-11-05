import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';

test('packed browser roles share one upstream module and retain their license on rebuild',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-browser-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const producer=fileURLToPath(new URL('../../../../scripts/build-browser-support.mjs',import.meta.url));
  const output=join(root,'built'),client=join(root,'packages/client');
  async function source(path,body){
    const file=join(client,path);
    await mkdir(dirname(file),{recursive:true});await writeFile(file,body);
  }
  await source('shared.ts','export const identity = {};');
  await source('ui-conversation/src/client/conversation/assembly.ts',"export {identity as UiConversation} from '../../../../shared.ts';");
  await source('ui-chat/src/client/conversation-nodes/register.ts',"export {identity as registerConversationNodes} from '../../../../shared.ts';");
  await source('ui-layout/src/client/theme-presenter.ts','export class ThemePresenter {}');
  await source('locale/src/locales/en.ts',"export const en={send:'Send'};");
  await source('ui-conversation/src/client/locales.ts',"export const en={reply:'Reply'}; export const unrelated='unused dictionary';");
  await writeFile(join(root,'LICENSE'),'upstream license');
  const build=()=>execFileSync(process.execPath,[producer,root,output],{windowsHide:true});
  build();
  const role=name=>import(pathToFileURL(join(output,name+'.mjs')));
  assert.equal((await role('conversation')).UiConversation,(await role('nodes')).registerConversationNodes);
  assert.equal(typeof (await role('theme')).ThemePresenter,'function');
  assert.deepEqual((await role('common')).en,{send:'Send'});
  assert.deepEqual((await role('messages')).en,{reply:'Reply'});
  assert.doesNotMatch(await readFile(join(output,'messages.mjs'),'utf8'),/unused dictionary/);
  assert.equal(await readFile(join(output,'LICENSE'),'utf8'),'upstream license');
  const shared=join(output,'shared'),previous=await readdir(shared);assert.equal(previous.length,1);
  await source('shared.ts','export const identity = { changed: true };');build();
  const current=await readdir(shared);assert.equal(current.length,1);assert.notEqual(current[0],previous[0]);
});
