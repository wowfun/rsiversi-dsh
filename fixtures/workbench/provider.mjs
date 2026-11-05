import http from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function startFixtureProvider(report, port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid fixture port');
  await mkdir(report, {recursive:true});
const requests = [];
const provider = http.createServer(async (request, response) => {
  try {
    const chunks=[]; let size=0;
    for await (const chunk of request) { size+=chunk.length; if(size>4*1024*1024) throw new Error('request capacity'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks));
    if (requests.length>=100) throw new Error('fixture request capacity');
    requests.push(body);
    await writeFile(join(report,'provider-requests.json'),JSON.stringify(requests,null,2));
    const messages=body.messages??[];
    const index=messages.findLastIndex(message=>message.role==='user');
    const text=typeof messages[index]?.content==='string'?messages[index].content:JSON.stringify(messages[index]?.content??'');
    const completed=messages.slice(index+1).some(message=>message.role==='tool');
    let delta={content:'Recorded the requested change.'}, finish='stop';
    if (!completed && /todo/i.test(text)) {
      delta={tool_calls:[{index:0,id:`todo-${requests.length}`,type:'function',function:{name:'todo_write',arguments:JSON.stringify({todos:[
        {content:'Read original DSH source',status:'completed'},
        {content:'Verify real workbench integration',status:'in_progress'},
        {content:'Run live provider acceptance',status:'pending'},
      ]})}}]}; finish='tool_calls';
    } else if (!completed && /submit.*plan/i.test(text)) {
      delta={tool_calls:[{index:0,id:`plan-${requests.length}`,type:'function',function:{name:'exit_plan_mode',arguments:JSON.stringify({plan:'# Original DSH integration\n\nVerify the **recorded plan** inside the RSI workbench.\n\n```typescript\nconst verified = { original: true, receipt: "canonical" };\n```\n\n- Read the exact journal\n- Preserve the draft\n- Verify the provider result'})}}]}; finish='tool_calls';
    }
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.end(`data: ${JSON.stringify({choices:[{delta:{role:'assistant',...delta},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:30}})}\n\ndata: [DONE]\n\n`);
  } catch(error) { response.writeHead(500).end(String(error.message)); }
});
provider.listen(port,'127.0.0.1'); await once(provider,'listening');
  return provider;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startFixtureProvider(resolve(process.argv[2]), Number(process.argv[3] ?? 0));
  console.log(JSON.stringify({port:server.address().port}));
}
