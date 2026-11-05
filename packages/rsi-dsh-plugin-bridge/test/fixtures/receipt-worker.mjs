import {appendFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {applicationTools} from '../../src/tools/application-tools.mjs';

const [directory,key]=process.argv.slice(2);
const require=createRequire(join(process.env.RSI_DSH_MARKET_COHORT,'package.json'));
const load=name=>import(pathToFileURL(require.resolve(name)));
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
    return id;
  }}));
process.send(await applicationTools(ctx,{load,key,generation:String(process.pid),directory,sessions}));
