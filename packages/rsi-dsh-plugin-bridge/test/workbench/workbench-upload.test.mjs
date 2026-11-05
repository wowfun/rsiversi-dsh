import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,symlink} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {sessionController} from '../../src/workbench/session-controller.mjs';
import {dshImage} from '../../src/agent/file-input.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('original streamed uploads resume a cold authorized Session and retain receipt ownership', {skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-workbench-upload-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  await mkdir(join(profile,'node_modules'));
  await symlink(join(root,'node_modules/@deepseek-ai'),join(profile,'node_modules/@deepseek-ai'),process.platform==='win32'?'junction':'dir');
  const require=createRequire(join(root,'package.json')),key=randomBytes(32).toString('hex'),agents=new Map(),calls=[];
  const submissions=[];let failSubmission=true;
  const scope=applicationSessions(async(method,args)=>{
    if(method==='application.submit'){
      submissions.push(args);
      if(failSubmission)throw Error('fixture: native mailbox unavailable');
      return {session_id:args.session_id,message_id:args.message_id,accepted_control_seq:1};
    }
    assert.equal(method,'application.actor');assert.equal(args.request,'issued');calls.push(args.session_id);
    if(args.session_id!=='cold')throw Error('Session unavailable');
    return {id:args.session_id,cwd:profile};
  },{owner:'owner',agent:id=>agents.get(id)});
  t.after(()=>scope.close());
  const activate=async id=>{const agent={id,session:{id,header:{id,createdAt:1}}};agents.set(id,agent);return agent;};
  const hostModules=new Map(),modules={entry:name=>require.resolve(name),directory:name=>dirname(require.resolve(name+'/package.json'))};
  const app=await createApplication({profile,modules,hostModules,provide:async(ctx,load)=>{
    await provideHttp(ctx,load,key,scope);
    hostModules.set('@deepseek-ai/dsh-api-session-controller',sessionController(
      (await load('@deepseek-ai/dsh-typert-protocol')).TypertRemoteService,scope,{},undefined,activate));
    ctx.provide('agents',{get:id=>agents.get(id)});
    ctx.provide('profileContext',{name:'upload',dir:profile,installAnchor:join(root,'package.json')});
    await ctx.plugin((await load('@deepseek-ai/dsh-app-boot')).PluginPackages);
  }});
  t.after(()=>app.close());
  const entries=['dsh-typert-registry','dsh-typert-loader','dsh-api-remote-access','dsh-api-gateway',
    'dsh-api-remotes','dsh-commands','dsh-client-file-upload','dsh-api-session-controller'];
  await app.reconcile([{insert:[{id:'attachments',name:'@deepseek-ai/dsh-attachment-local',config:{dshHome:profile}},
    ...entries.map(id=>({id,name:'@deepseek-ai/'+id}))]}]);
  const data=Buffer.alloc(1024*1024+17,0x5a);
  const upload=async id=>{
    const response=await fetch(app.ctx.webServer.getOrigin()+'/document/api/session/uploadFileBinary?'+new URLSearchParams({sessionId:id,name:'receipt.bin'}),{
      method:'POST',headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued','content-type':'application/octet-stream'},body:data});
    assert.equal(response.status,200);return response.json();
  };
  const receipt=await upload('cold');assert.equal(receipt.ok,true,JSON.stringify(receipt));
  assert.deepEqual(calls,['cold']);
  assert.deepEqual(await readFile(app.ctx.attachments.fileHostPath(receipt.value.file)),data);
  const own=app.ctx.fileUploads.resolve(agents.get('cold'),receipt.value.receiptId);
  assert.deepEqual(own?.attachment??own,receipt.value.file);
  assert.equal(app.ctx.fileUploads.resolve({session:{id:'other'}},receipt.value.receiptId),undefined);
  const refused=await upload('unknown');assert.equal(refused.ok,false);assert.equal(agents.has('unknown'),false);
  assert.deepEqual(calls,['cold','unknown']);
  const requestId=randomUUID();
  const prompt=async(content=[{type:'file',receiptId:receipt.value.receiptId}],id=requestId)=>{
    const response=await fetch(app.ctx.webServer.getOrigin()+'/api/session/prompt',{method:'POST',
      headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued','content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/prompt',payload:{args:{request:{
        sessionId:'cold',requestId:id,mode:'queue',content}}}})});
    return response.json();
  };
  const rejected=await prompt();assert.match(rejected.result?.error?.message,/fixture: native mailbox unavailable/);
  assert.equal(submissions.length,1);
  app.ctx.fileUploads.retirePrompt(agents.get('cold'),requestId);
  assert.ok(app.ctx.fileUploads.resolve(agents.get('cold'),receipt.value.receiptId),'failed delivery rolls back its binding');
  failSubmission=false;
  const accepted=await prompt();assert.deepEqual(accepted.result?.value,{accepted:true},JSON.stringify(accepted));
  assert.deepEqual(submissions.at(-1).content,[{kind:'file',file:{id:receipt.value.file.attachmentId.slice(7),name:receipt.value.file.name,bytes:data.length}}]);
  assert.ok(Buffer.byteLength(JSON.stringify(submissions.at(-1)))<1024,'only metadata crosses native IPC');
  assert.deepEqual(calls,['cold','unknown'],'a staged upload already retains its authorized Agent');
  app.ctx.fileUploads.retirePrompt(agents.get('cold'),requestId);
  assert.equal(app.ctx.fileUploads.resolve(agents.get('cold'),receipt.value.receiptId),undefined,'accepted binding retires with the original upload service');
  const sharp=createRequire(require.resolve('@deepseek-ai/dsh-attachment-local'))('sharp');
  const jpeg=await sharp({create:{width:64,height:48,channels:3,background:'red'}}).jpeg().toBuffer();
  const input={type:'image',name:'source/fixture.jpg',mediaType:'image/jpeg',data:jpeg.toString('base64')};
  const imageReply=await prompt([{type:'text',text:'inspect'},input],randomUUID());
  assert.deepEqual(imageReply.result?.value,{accepted:true},JSON.stringify(imageReply));
  const image=submissions.at(-1).content[1];
  assert.equal(image.kind,'image');assert.equal(image.media.mime,'image/jpeg');
  assert.deepEqual(image.presentation,{name:'fixture.jpg'});
  assert.ok(!('data' in image));
  const stored=await app.ctx.attachments.readImage(dshImage(image));
  assert.deepEqual(Buffer.from(stored.data),jpeg);
  const count=submissions.length;
  const rejectedImage=await prompt([{...input,data:'broken'}],randomUUID());
  assert.ok(rejectedImage.result?.error);assert.equal(submissions.length,count);
  if(typeof app.ctx.fileUploads.uploadImageStream==='function'){
    const response=await fetch(app.ctx.webServer.getOrigin()+'/document/api/session/uploadFileBinary?'+
      new URLSearchParams({sessionId:'cold',name:'staged.jpg',mediaType:'image/jpeg'}),{method:'POST',
      headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued','content-type':'application/octet-stream'},body:jpeg});
    const staged=await response.json();assert.equal(staged.ok,true,JSON.stringify(staged));
    const part={type:'file',receiptId:staged.value.receiptId};
    const excessive=await prompt(Array(app.ctx.attachments.imageLimits.maxImagesPerMessage+1).fill(part),randomUUID());
    assert.ok(excessive.result?.error);assert.equal(submissions.length,count);
    assert.equal((await prompt([part,input],randomUUID())).result?.value?.accepted,true);
    assert.deepEqual(submissions.at(-1).content.map(block=>block.presentation.name),['staged.jpg','fixture.jpg']);
    assert.deepEqual(submissions.at(-1).content.map(block=>block.media.id),[image.media.id,image.media.id]);
  }
  // Replacing the controller must release the previous original resolver.
  const controller=[...app.ctx.loader.entries()].find(entry=>entry.options.name==='@deepseek-ai/dsh-api-session-controller');
  await controller.refresh();await app.ctx.loader.await();
  agents.delete('cold');assert.equal((await upload('cold')).ok,true);
});
