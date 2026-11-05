import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workbenchModel} from '../../src/workbench/model.mjs';

test('native next selection stays independent of temporary requests and fork-inherited headers',()=>{
  const baseline={model:{deployment:'native',model:'default'},reasoning_effort:null};
  let header;
  const session={requestHeader:()=>header};
  const parent=workbenchModel(baseline);
  assert.deepEqual(parent.snapshot(session),{lastUsed:null,next:{provider:'native',model:'default'}});
  const chosen={model:{deployment:'other',model:'selected'},reasoning_effort:'high'};
  const reopened=workbenchModel(chosen);
  header={config:{provider:'temporary',model:'override',reasoningEffort:'low'},adapterDefaults:{reasoningEffort:true}};
  assert.deepEqual(reopened.snapshot(session),{lastUsed:{provider:'temporary',model:'override'},
    next:{provider:'other',model:'selected',reasoningEffort:'high'}});
  const child=workbenchModel(baseline);
  assert.deepEqual(child.snapshot(session),{lastUsed:{provider:'temporary',model:'override'},
    next:{provider:'native',model:'default'}});
  delete header.adapterDefaults;
  assert.equal(child.snapshot(session).lastUsed.reasoningEffort,'low');
});
