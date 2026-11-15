import {globSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from 'node:test';
import {spec} from 'node:test/reporters';

if(!process.env.RSI_DSH_MARKET_COHORT) {
  console.error('Set RSI_DSH_MARKET_COHORT to the absolute path of a complete installed DSH cohort before running npm run test:market.');
  process.exitCode=1;
} else {
  const cwd=fileURLToPath(new URL('../',import.meta.url));
  const files=process.argv.length>2?process.argv.slice(2):[
    'packages/rsi-dsh-cordis/test/runtime/transport.test.mjs',
    'packages/rsi-dsh-plugin-bridge/test/application/request-boundary.test.mjs',
    'packages/rsi-dsh-plugin-bridge/test/application/application-replacement.test.mjs',
    'packages/rsi-dsh-plugin-bridge/test/tools/application-tools.test.mjs',
    'packages/rsi-dsh-plugin-bridge/test/workbench/workbench-settings.test.mjs',
    ...globSync('packages/rsi-dsh-plugin-bridge/test/market/*.test.mjs',{cwd}).sort(),
  ];
  let incomplete=false;
  const remaining=new Set(files.map(file=>resolve(cwd,file)));
  const tests=run({files:[...remaining],cwd,concurrency:true});
  tests.on('test:summary',({success,counts,file})=>{
    incomplete ||= !success||counts.skipped>0||counts.todo>0||counts.tests===0;
    if(file!==undefined)remaining.delete(resolve(file));
    if(file===undefined&&(incomplete||remaining.size)) {
      console.error('Market acceptance requires every selected test to execute and pass (no skips, todo or empty files).');
      process.exitCode=1;
    }
  });
  tests.compose(spec).pipe(process.stdout);
}
