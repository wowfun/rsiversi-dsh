import {toolPipeline} from '../../src/tools/tool-pipeline.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadCohort} from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('a released registry cannot dispatch a withdrawn registration after an asynchronous hook', {skip:!root},async()=>{
  const cohort=await loadCohort(root);
  const {Context}=await cohort.import('@deepseek-ai/cordis'), tools=await cohort.import('@deepseek-ai/dsh-tools');
  const ctx=new Context(), agent={id:'selection'},signal=AbortSignal.timeout(10000);
  const entered=Promise.withResolvers(), resume=Promise.withResolvers();
  try {
    await ctx.plugin((await cohort.import('@deepseek-ai/dsh-session-projection')).default);
    await ctx.plugin((await cohort.import('@deepseek-ai/dsh-system-prompt')).default);
    await (await ctx.plugin(tools.default)).await();
    const invoke=toolPipeline(ctx,await cohort.subpath('@deepseek-ai/dsh-tools','pipeline'),tools);
    let bodies=0;
    const definition=tools.defineTool({name:'sample',description:'sample',parameters:{},
      output:{schema:{type:'string'},render:(_,text)=>[{type:'text',text}]},
      async execute(){bodies++;return 'executed';}});
    const remove=ctx.tools.register(definition);
    ctx.on('tools/execute',async(exec,next)=>{
      if(exec.callId==='old') {entered.resolve();await resume.promise;}
      return next();
    });
    const old=await ctx.tools.resolve({agent,signal});
    assert.equal(old.view(agent).get('sample'),definition);
    const run=(callId,toolSet)=>invoke({callId,toolSet,agent,signal,name:'sample',arguments:{}});
    const pending=run('old',old);
    await entered.promise;remove();ctx.tools.register(definition);resume.resolve();
    assert.equal((await pending).error.info.code,'UNKNOWN_TOOL');
    assert.equal(old.view(agent).size,0);
    const next=await ctx.tools.resolve({agent,signal});
    assert.equal(next.view({id:'other'}).size,0);
    const swapped=await invoke({callId:'swapped',toolSet:next,agent:{id:'other'},signal,name:'sample',arguments:{}});
    assert.equal(swapped.error.info.code,'UNKNOWN_TOOL');
    assert.equal((await run('fresh',next)).value,'executed');
    next.dispose();
    assert.equal((await run('closed',next)).error.info.code,'UNKNOWN_TOOL');
    assert.equal(bodies,1);
  } finally {resume.resolve();await ctx.fiber.dispose();}
});
