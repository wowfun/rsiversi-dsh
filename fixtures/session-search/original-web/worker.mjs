import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [cohort]=process.argv.slice(2),require=createRequire(join(cohort,'package.json'));
const load=name=>import(pathToFileURL(require.resolve(name)));
let runtime,reader,sessionId;
const checks=[];

async function read(id=sessionId){
  const handle=await reader.sessionPersistence.open(id,'read');
  try{return (await handle.read()).events;}finally{await handle.close();}
}
async function command(method,args){
  if(method==='close'){
    await reader?.fiber.dispose();reader=undefined;
    if(runtime)await runtime.shutdown.shutdown(0);
    process.disconnect();
    return;
  }
  if(method==='boot'){
    sessionId=args.sessionId;
    const home=process.env.DSH_HOME,profile=join(home,'profiles/search-acceptance');
    const {PROFILE_TEMPLATES}=await load('@deepseek-ai/dsh-official-bundles');
    const bundles=[...PROFILE_TEMPLATES.web.bundles,'@deepseek-ai/dsh-experimental-session-search'];
    if(!args.resume){
      await mkdir(profile,{recursive:true});
      await writeFile(join(profile,'package.json'),JSON.stringify({name:'dsh-search-acceptance',private:true,dsh:{profile:{bundles}}}),{flag:'wx'});
      await writeFile(join(profile,'cordis.patch.yml'),'[]\n',{flag:'wx'});
    }
    const {runProfile}=await load('@deepseek-ai/dsh/profile-boot');
    const {loadLayeredEnv}=await load('@deepseek-ai/dsh-app-boot');
    runtime=await runProfile({profile:'search-acceptance',patchFiles:[],args:['--no-open','--port','0'],environment:loadLayeredEnv('search-acceptance')});
    const {ctx}=runtime;
    const {Context}=await load('@deepseek-ai/cordis');reader=new Context();
    await reader.plugin(await load('@deepseek-ai/dsh-session-persistence-jsonl'),{root:join(home,'sessions')});
    for(const row of args.corpus){
      const writer=await ctx.sessionPersistence.create(row.header,{inheritedEventCount:row.inheritedEventCount??0});
      try{await writer.append(row.events);}finally{await writer.close();}
    }
    if(args.verifyDurability)ctx.on('tools/execute',async(exec,next)=>{
      if(exec.agent?.session.id===sessionId){
        assert.ok((await read()).some(row=>row.type==='tool/call'&&row.data.callId===exec.callId),'Call must be durable before dispatch');
        checks.push(exec.callId);
      }
      return next();
    });
    if(args.resume){await ctx.typert.lookups.get('agent').resolve(sessionId);}
    else{
      await ctx.sessionController.create({sessionId,cwd:args.cwd,agentPreset:'standard'});
      await ctx.sessionController.selectModel({sessionId,provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off'});
    }
    const manifest=JSON.parse(await readFile(join(profile,'package.json'),'utf8'));
    const version=JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh/package.json'),'utf8')).version;
    return {url:ctx.connection.authenticatedUrl(ctx.webApp.getAdvertisedUrl()),bundles:manifest.dsh.profile.bundles,sessionId,version};
  }
  assert.ok(runtime);
  const {ctx}=runtime;
  if(method==='append'){
    assert.notEqual(args.sessionId,sessionId,'Corpus writes must not bypass the caller Agent');
    const writer=await ctx.sessionPersistence.open(args.sessionId,'write');
    try{await writer.append(args.events);await writer.flush();}finally{await writer.close();}
    return read(args.sessionId);
  }
  if(method==='prompt'){
    const agent=ctx.agents.get(sessionId),offset=agent.session.seq;
    await ctx.sessionController.prompt({sessionId,requestId:args.callId,mode:'queue',content:[{type:'text',text:'Run the selected search tool.'}]},new AbortController().signal);
    await agent.whenIdle();
    const events=agent.session.snapshotEvents().slice(offset),terminal=events.findLast(row=>row.type==='turn/end');
    assert.equal(terminal?.data.reason.kind,'completed',JSON.stringify(terminal));
    const result=events.find(row=>row.type==='tool/result'&&row.data.message.source.callId===args.callId);
    assert.ok(result,'Original Agent must publish its own Tool result');
    return {isError:result.data.message.isError,content:result.data.message.content};
  }
  if(method==='read')return read();
  if(method==='snapshot')return {events:ctx.agents.get(sessionId).session.snapshotEvents(),checks};
  throw Error('Unknown fixture method '+method);
}
process.on('message',async({id,method,args})=>{
  try{const value=await command(method,args);if(process.connected)process.send({id,value});}
  catch(error){if(process.connected)process.send({id,error:error.stack});}
});
