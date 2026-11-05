import assert from 'node:assert/strict';

// One independent Host profile for tests that substitute the native Store.
export function rootSet() {
  let retained={};
  return request=>{
    if(!request.next)return structuredClone(retained);
    assert.deepEqual(request.expected,retained);
    retained=structuredClone(request.next);
    return null;
  };
}

export function stage(roots,args,packages) {
  const next={...args.expected_roots,...Object.fromEntries(Object.entries(packages).map(([name,digest])=>[digest,name]))};
  roots({expected:args.expected_roots,next});
  return {packages,roots:next};
}
