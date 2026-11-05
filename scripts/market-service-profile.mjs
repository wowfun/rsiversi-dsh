import {resolve,join} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {discoverNode,runtimeEnvironment} from '../packages/rsi-dsh-cordis/src/runtime/node.mjs';
import {profileState,registryEnvironment} from '../packages/rsi-dsh-cordis/src/registry/npm-install.mjs';

/** Emit the single process selection for a background application Host. */
export async function writeMarketServiceProfile({receipt,document,state,profile,output,importer}) {
  const {executable}=await discoverNode({executable:process.execPath});
  const {selection:selected,importer:registry}=JSON.parse(await readFile(receipt,'utf8'));
  if(importer&&!registry) throw new Error('The market profile needs a registry importer selection');
  const privateHome=join(state,'web-applications',profile);
  const quote=value=>JSON.stringify(value);
  const environment={...runtimeEnvironment(),...registryEnvironment(),PATH:process.env.PATH,HOME:privateHome,USERPROFILE:privateHome,DSH_HOME:privateHome};
  const fields=Object.entries(environment).filter(([,value])=>value!==undefined)
    .map(([name,value])=>quote(name)+' = '+quote(value));
  await writeFile(output,`format = 1
[[steps]]
kind = "plugin"
id = "market-files"
plugin = "rsi.media.attachments.local"
config = {root=${quote(join(profileState(privateHome),'attachments','v1'))}}
[[steps]]
kind = "plugin"
id = "market-application"
plugin = "rsi.web.application"
[steps.config]
profile = ${quote(profile)}
tools = true
replace_preset_tools = ["schedule_create", "schedule_list", "schedule_update", "schedule_delete", "schedule_resume"]
routes = ["/document", "/plugins", "/sidebar", "/dsh-market", "/api"]
source = {kind="directory", path=${quote(document)}}
${importer ? `importer = {package=${quote(registry.name)},digest=${quote(registry.digest)},export="import",program=${quote(executable)}}` : ''}
[steps.config.process]
package = ${quote(selected.name)}
digest = ${quote(selected.digest)}
export = "application"
program = ${quote(executable)}
environment = {${fields.join(', ')}}
`);
}
if(import.meta.main) {
  const [receipt,document,state,profile,output,mode] = process.argv.slice(2);
  if(!output) throw new Error('Expected receipt, admitted document, state directory, profile name and output');
  await writeMarketServiceProfile({receipt:resolve(receipt),document:resolve(document),state:resolve(state),profile,output:resolve(output),importer:mode==='--importer'});
}
