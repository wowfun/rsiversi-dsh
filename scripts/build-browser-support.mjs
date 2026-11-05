import {build} from 'esbuild';
import {copyFile, mkdir, readdir, unlink, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceIdentity} from './source-identity.mjs';

const upstream=resolve(process.argv[2]);
const output=resolve(process.argv[3]??fileURLToPath(new URL('../packages/rsi-dsh-plugin-bridge/generated/browser/',import.meta.url)));
const client=join(upstream,'packages/client');
const {revision}=sourceIdentity(upstream);
const external=['react','react/jsx-runtime','react-dom','react-dom/client','@deepseek-ai/cordis','zod','@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-primitives','@deepseek-ai/dsh-client-ui-dockkit'];

// Re-export only the bindings consumed by this document. The multi-entry build
// keeps a single instance of dependencies shared by Chat and Conversation.
const entries={
  conversation:['ui-conversation/src/client/conversation/assembly.ts','UiConversation'],
  nodes:['ui-chat/src/client/conversation-nodes/register.ts','registerConversationNodes'],
  theme:['ui-layout/src/client/theme-presenter.ts','ThemePresenter'],
  common:['locale/src/locales/en.ts','en'],
  messages:['ui-conversation/src/client/locales.ts','en'],
};
const result=await build({
  absWorkingDir:upstream,entryPoints:Object.keys(entries).map(name=>({in:'dsh-entry:'+name,out:name})),
  plugins:[{name:'dsh-exports',setup(builder){
    builder.onResolve({filter:/^dsh-entry:/},args=>({path:args.path.slice(10),namespace:'dsh-exports'}));
    builder.onLoad({filter:/.*/,namespace:'dsh-exports'},({path})=>{
      const [source,binding]=entries[path];
      return {contents:'export { '+binding+' } from '+JSON.stringify('./'+source),resolveDir:client};
    });
  }}],
  bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',external,
  outdir:output,outExtension:{'.js':'.mjs'},chunkNames:'shared/[hash]',write:false,
  banner:{js:'// Generated from DeepSeek Harness'+(revision?' '+revision:'')+'. See LICENSE.'},
  legalComments:'eof',
});
for(const file of result.outputFiles){
  await mkdir(dirname(file.path),{recursive:true});await writeFile(file.path,file.contents);
}
await copyFile(join(upstream,'LICENSE'),join(output,'LICENSE'));
const shared=join(output,'shared'),current=new Set(result.outputFiles.map(file=>basename(file.path)));
for(const name of await readdir(shared).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){
  if(/^[A-Z0-9]{8}\.mjs$/.test(name)&&!current.has(name))await unlink(join(shared,name));
}
