import {join} from 'node:path';
import {appendFile} from 'node:fs/promises';

// RSI's five homes resolve independently, including the package and credential store.
export function homeOptions(home) {
  return ['--config-home',join(home,'config/rsi'),'--data-home',join(home,'data/rsi'),
    '--state-home',join(home,'state/rsi'),'--cache-home',join(home,'cache/rsi'),'--tmp-home',join(home,'tmp')];
}

export function fixtureWorkspaceContext(config) {
  const context={user_instruction_file:join(config,'AGENTS.md'),user_agent_roots:[join(config,'agents')],
    user_skill_roots:[join(config,'skills')]};
  return `\n[[steps]]\nkind = 'patch'\ntarget = 'rsi-agent-workspace-context'\nconfig_json = ${JSON.stringify(JSON.stringify(context))}\n`;
}

export async function writeFixtureMarketServiceProfile(options,config) {
  const {writeMarketServiceProfile}=await import('../../scripts/market-service-profile.mjs');
  await writeMarketServiceProfile(options);
  await appendFile(options.output,fixtureWorkspaceContext(config));
}
