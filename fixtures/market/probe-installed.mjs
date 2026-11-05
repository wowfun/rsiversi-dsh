import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';

// Reach a market-installed plugin through the public native listener. Keep
// the one-use launch ticket and device credential out of the receipt.
const [bin,home,document]=process.argv.slice(2,5).map(path=>resolve(path));
const options=process.argv.slice(5);
const [session,second]=options.filter(arg=>arg!=='--check-paired-device');
const started=performance.now();
const cli=(...args)=>execFileSync(bin,['--config-home',join(home,'config/rsi'),
  '--state-home',join(home,'state/rsi'),'--cache-home',join(home,'cache/rsi'),...args],
  {cwd:home,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const launch=new URL(cli('web','--no-open','--port','0','--assets',document).match(/https?:\/\/[^\s]+/)[0]);
const origin=launch.origin;
const bootstrap=await fetch(origin+'/api/v2/browser-bootstrap',{method:'POST',headers:{
  origin,'sec-fetch-site':'same-origin','x-rsi-csrf':'1','x-rsi-launch-ticket':launch.hash.slice('#rsi-launch='.length)}});
assert.equal(bootstrap.status,200);
const bootstrapMs=Math.round(performance.now()-started);
const headers={origin,'sec-fetch-site':'same-origin',cookie:bootstrap.headers.get('set-cookie').split(';')[0]};
let paired;
if(options.includes('--check-paired-device')) {
  const issued=JSON.parse(cli('devices','register','market boundary probe'));
  try {
    const other={...headers,cookie:headers.cookie.split('=')[0]+'='+issued.token};
    const recognized=await fetch(origin+'/api/v2/browser-bootstrap',{method:'POST',headers:{...other,'x-rsi-csrf':'1'}});
    assert.equal(recognized.status,200);
    assert.equal((await recognized.json()).device_id,issued.id);
    const route=await fetch(origin+'/sidebar/bundle/editor.js',{method:'HEAD',headers:other});
    const market=await fetch(origin+'/dsh-market/',{headers:other});
    assert.equal(route.status,401);assert.equal(market.status,401);
    paired={recognized:recognized.status,sidebar:route.status,market:market.status};
  } finally {cli('devices','revoke',issued.id);}
}
const chunk=origin+'/sidebar/bundle/mermaid.js';
const requested=performance.now();
const response=await fetch(chunk,{headers});
assert.equal(response.status,200);
const responseHeadersMs=Math.round(performance.now()-requested);
const bytes=Buffer.from(await response.arrayBuffer()),etag=response.headers.get('etag');
const completeResourceMs=Math.round(performance.now()-requested);
assert.ok(bytes.length>1024*1024 && etag);
const conditional=await fetch(chunk,{method:'HEAD',headers:{...headers,'if-none-match':etag}});
assert.equal(conditional.status,304);
const api=(method,value)=>fetch(origin+'/sidebar/api/'+method,{method:'POST',headers:{...headers,'content-type':'application/json'},
  body:JSON.stringify(value)});
const read=(id,cwd)=>api('fs.read',{sessionId:id,path:'sidebar-proof.txt',cwd});
const unknown=await read('missing-market-proof');
assert.equal(unknown.status,403);
const report={origin,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
  conditional:conditional.status,unknown:unknown.status,paired,bootstrapMs,responseHeadersMs,completeResourceMs};
const settings=body=>fetch(origin+'/sidebar/api/settings.get',{method:'POST',headers:{...headers,'content-type':'application/json'},body});
const global=await settings('');
assert.equal(global.status,200);
assert.equal((await global.json()).ok,true);
const malformed=await settings('{');
assert.equal(malformed.status,400);
assert.equal((await malformed.json()).error.code,'bad-request');
report.globalSettings=true;
for(const name of ['editor','terminal']) {
  const resource=await fetch(origin+'/sidebar/bundle/'+name+'.js',{method:'HEAD',headers});
  assert.equal(resource.status,200);
  assert.match(resource.headers.get('content-type'),/javascript/);
  report[name+'Bytes']=Number(resource.headers.get('content-length'));
  assert.ok(report[name+'Bytes']>0);
}
if(session) {
  const file=await read(session);assert.equal(file.status,200);
  const value=await file.json();
  assert.ok(JSON.stringify(value).includes('native market session'));
  report.nativeFile=true;
  const status=await api('git.status',{sessionId:session});
  assert.equal(status.status,200);
  assert.equal((await status.json()).ok,true);
  report.nativeGit=true;
  const path=join(home,'proof-workspace','sidebar-proof.html').replaceAll('\\','/').replace(/^\/(?!\/)/,'');
  const html=await fetch(origin+'/sidebar/html/'+encodeURIComponent(session)+'/'+path.split('/').map(encodeURIComponent).join('/'),{headers});
  assert.equal(html.status,200);
  const csp=html.headers.get('content-security-policy');
  assert.ok(csp?.includes('sandbox') && !csp.includes('allow-same-origin'));
  assert.ok((await html.text()).includes('native sandbox preview'));
  report.sandboxedHtml=true;
  if(second) {
    const other=await read(second);
    assert.equal(other.status,200);
    assert.ok(JSON.stringify(await other.json()).includes('native market session two'));
    assert.ok(!JSON.stringify(value).includes('native market session two'));
    const swapped=await read(session,join(home,'proof-workspace-two'));
    assert.equal(swapped.status,403);
    report.crossWorkspace=swapped.status;
    if(process.env.RSI_DSH_MARKET_COHORT) {
      const WebSocket=createRequire(join(process.env.RSI_DSH_MARKET_COHORT,'package.json'))('ws');
      const sockets=[];
      try {
        for(const id of [session,second]) {
          const socket=new WebSocket(origin.replace('http:','ws:')+'/sidebar/ws/fs-watch?sessionId='+encodeURIComponent(id),
            {origin,headers:{cookie:headers.cookie},handshakeTimeout:10000});
          sockets.push(socket);
          await once(socket,'open',{signal:AbortSignal.timeout(10000)});
          const ack=once(socket,'message',{signal:AbortSignal.timeout(10000)});
          socket.send(JSON.stringify({op:'watch',path:'.'}));
          const answer=JSON.parse((await ack)[0]);
          assert.equal(answer.ok,true,JSON.stringify(answer));
        }
        let otherEvents=0;
        sockets[1].on('message',()=>otherEvents++);
        const change=once(sockets[0],'message',{signal:AbortSignal.timeout(10000)});
        const write=body=>fetch(origin+'/sidebar/write?sessionId='+encodeURIComponent(session)+'&path=sidebar-proof.txt',
          {method:'POST',headers,body});
        assert.equal((await write('native market session changed')).status,200);
        await change;
        await sleep(200);
        assert.equal(otherEvents,0);
        assert.equal((await write('native market session')).status,200);
        report.nativeWatch=true;
      } finally {for(const socket of sockets) socket.close();}
    }
  }
}
console.log(JSON.stringify(report));
