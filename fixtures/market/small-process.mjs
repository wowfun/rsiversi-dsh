// Isolate the native application lifecycle from npm graph verification.
import {createServer} from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Peer} from './transport.mjs';
import {applicationSessions} from './bridge/application/sessions.mjs';
import {BODY_FRAGMENT_BYTES} from './bridge/request-body.mjs';
let key,api,lastRead;
const trace={submissions:[],fragments:0,largestFragment:0};
const sha=text=>createHash('sha256').update(text).digest('hex');
async function submitProbe() {
  return api.runOwned(async signal=>{
    const text='"\\\n\t'.repeat(256*1024),message_id='probe-'+randomUUID();
    assert.equal(Buffer.byteLength(text),1024*1024);
    const created=await api.create({cwd:process.env.RSI_SUBMISSION_PROBE_WORKSPACE},signal);
    const input={message_id,delivery:'next_turn',content:[{kind:'text',text}]};
    assert(Buffer.byteLength(JSON.stringify(input))>2*1024*1024);
    const receipt=await api.submit(created.id,input,signal);
    assert.throws(()=>api.readSubmission(lastRead),/unavailable/);
    const reader='probe-'+randomUUID();let offset=0,total,encoded='';
    try {
      do {
        const part=await api.history(created.id,{type:'message',reader,message_id,
          accepted_control_seq:receipt.accepted_control_seq,offset},signal);
        assert.equal(part.offset,offset);assert(part.next_offset>offset);
        total??=part.total_bytes;assert.equal(part.total_bytes,total);
        assert.equal(Buffer.byteLength(part.json),part.next_offset-offset);
        encoded+=part.json;offset=part.next_offset;
      } while(offset<total);
    } finally {await api.releaseHistory(created.id,{type:'page_close',reader});}
    const accepted=JSON.parse(encoded);
    assert.equal(accepted.message_id,message_id);
    assert.equal(accepted.content.length,1);assert.equal(accepted.content[0].text,text);
    const replay=await api.submit(created.id,input,signal);
    assert.equal(replay.accepted_control_seq,receipt.accepted_control_seq);
    assert.equal(replay.message_id,message_id);
    assert(trace.submissions.length===2&&trace.submissions.every(row=>row.kind==='paged'&&row.bytes>2*1024*1024&&row.envelope_bytes<1024));
    assert(trace.fragments>2&&trace.largestFragment<=BODY_FRAGMENT_BYTES);
    return {session:created.id,message:message_id,text_bytes:Buffer.byteLength(text),text_sha256:sha(text),
      accepted_control_seq:receipt.accepted_control_seq,durable_text_sha256:sha(accepted.content[0].text),
      replay_same_acceptance:true,retired_body_unreadable:true,fragment_limit:BODY_FRAGMENT_BYTES,...trace};
  });
}
const server=createServer(async(req,res)=>{
  if(req.headers['x-rsi-upstream-key']!==key || !req.headers['x-rsi-upstream-request']) {res.writeHead(403).end();return;}
  try {
    if(req.method==='POST'&&req.url==='/document/submit') {
      const result=await submitProbe();res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
    } else res.writeHead(200).end('native application probe');
  } catch(error) {res.writeHead(500,{'content-type':'text/plain'}).end(String(error.stack));}
});
const peer=new Peer({input:process.stdin,output:process.stdout,generation:process.argv[2],handler:async(method,args)=>{
  if(method==='extension.hello') return {protocol:2};
  if(method==='extension.ping') return null;
  if(method==='extension.close') {await api?.close();server.close();return null;}
  if(method==='application.submit.read') {
    assert.throws(()=>api.readSubmission({...args,message_id:'another-message'}),/unavailable/);
    const part=api.readSubmission(args);lastRead=args;trace.fragments++;
    trace.largestFragment=Math.max(trace.largestFragment,Buffer.from(part.data,'base64').length);return part;
  }
  if(method!=='application.open' || args.protocol!==14) throw new Error('Unknown application operation or protocol');
  key=args.key;
  api=applicationSessions((method,payload,signal)=>{
    if(method==='application.submit')trace.submissions.push({kind:payload.body.kind,bytes:payload.body.bytes,envelope_bytes:Buffer.byteLength(JSON.stringify(payload))});
    return peer.request(method,payload,{signal});
  },{owner:args.owner});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {protocol:args.protocol,port:server.address().port,prefixes:['/document']};
},onClose:()=>{void api?.close();server.close();process.stdin.destroy();}});
