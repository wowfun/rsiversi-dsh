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
  return {packages,stage:crypto.randomUUID()};
}
