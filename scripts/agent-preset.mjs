import { isAbsolute } from 'node:path';
import { discoverNode, runtimeEnvironment } from '../packages/rsi-dsh-cordis/src/runtime/node.mjs';

/** Produce an operator-selected profile; installation itself never enables the code. */
export function agentPreset(name, digest, program) {
  if (!/^[a-z][a-z0-9.-]{0,127}$/.test(name) || !/^[a-f0-9]{64}$/.test(digest) || !isAbsolute(program))
    throw new Error('Expected an installed package name, exact SHA-256 and absolute Node executable');
  const vars = Object.entries(runtimeEnvironment()).map(([key,value]) => `${key} = ${JSON.stringify(value)}`).join('\n');
  return `format = 1
[[steps]]
kind = "plugin"
id = "context"
plugin = "rsi.agent.context.default"
[[steps]]
kind = "group"
id = "dsh-runtime"
[steps.isolation]
local = ["rsi.extension.connection"]
[[steps.nodes]]
kind = "plugin"
id = "process"
plugin = "rsi.extension.package"
[steps.nodes.config]
package = ${JSON.stringify(name)}
digest = "${digest}"
export = "process"
program = ${JSON.stringify(program)}
[steps.nodes.config.environment]
${vars}
[[steps.nodes]]
kind = "plugin"
id = "adapter"
plugin = "rsi.extension.agent"
config = { artifact_sha256 = "${digest}" }
`;
}
if (import.meta.main) {
  const [name,digest,executable] = process.argv.slice(2);
  const node = await discoverNode({executable});
  process.stdout.write(agentPreset(name,digest,node.executable));
}
