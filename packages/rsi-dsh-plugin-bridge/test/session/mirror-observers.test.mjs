import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {SessionFacade} from '../../src/session/session.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('extension mirror listeners validate before commit and observe independently afterwards',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();
  t.after(()=>ctx.fiber.dispose());
  const api={...await load('dsh-session'),...await load('dsh-session/surface'),...await load('dsh-util-values')};
  const make=id=>new SessionFacade(ctx,api,{header:api.Session.create(id).header},false);
  const seen=[],warnings=[];
  t.mock.method(ctx.logger,'warn',message=>warnings.push(String(message)));
  ctx.on('session/disposed',()=>{throw Error('bad disposal');});
  ctx.on('session/disposed',s=>seen.push(['disposed',s.id]));
  make('unannounced').retire();
  const vetoCreation=ctx.on('session/created',()=>{throw Error('creation veto');});
  assert.throws(()=>make('vetoed').attach(),/creation veto/);
  vetoCreation();
  ctx.on('session/created',()=>Promise.reject(Error('async creation')));
  const session=make('live');
  session.attach();session.begin();
  const vetoEvent=ctx.on('internal/dispatch',(_mode,name,args)=>{
    if(name==='session/event'){assert.equal(args[0].seq,0);throw Error('event veto');}
  });
  assert.throws(()=>session.append('turn/start',{turn:1}),/event veto/);
  vetoEvent();
  assert.equal(session.seq,0);
  ctx.on('session/event',(s,event)=>{
    if(event.type==='turn/start')s.append('feedback/record',{text:'nested'});
  });
  ctx.on('session/event',()=>Promise.reject(Error('async event')));
  ctx.on('session/event',(s,event)=>seen.push([event.type,s.eventAt(event.seq)===event]));
  const event=session.append('turn/start',{turn:1});
  session.end();session.retire();session.retire();await setImmediate();
  assert.deepEqual(session.snapshotEvents(),[event]);
  assert.deepEqual(seen,[['disposed','vetoed'],['turn/start',true],['disposed','live']]);
  for(const message of ['bad disposal','async creation','cannot reenter','async event'])
    assert.ok(warnings.some(w=>w.includes(message)),message);
});
