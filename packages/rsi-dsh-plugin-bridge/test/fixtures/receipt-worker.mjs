import {cohortModules} from '../../../../fixtures/market/cohort-modules.mjs';
import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {fixtureTools} from './tool-host.mjs';

const [directory,key]=process.argv.slice(2);
const {load}=await cohortModules(process.env.RSI_DSH_MARKET_COHORT);
const {Context}=await load('@deepseek-ai/cordis');
const tools=await load('@deepseek-ai/dsh-tools');
const ctx=new Context();
const sessions=applicationSessions(()=>{throw Error('unexpected browser request');});
ctx.provide('sessions',sessions.sessions);
for(const id of ['dsh-session-projection','dsh-system-prompt'])await ctx.plugin((await load('@deepseek-ai/'+id)).default);
await (await ctx.plugin(tools.default)).await();
ctx.tools.register(tools.defineTool({name:'receipt_probe',description:'Record one execution.',parameters:{},
  output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},
  async execute(_,execution){
    const id=execution.agent.session.id;
    await appendFile(join(directory,'body-calls'),id+'\n');
    if(id==='unfinished')await new Promise(()=>{});
    execution.concludeTurn();
    return id;
  }}));
process.send(await fixtureTools(ctx,{load,key,generation:String(process.pid),directory,sessions}));
