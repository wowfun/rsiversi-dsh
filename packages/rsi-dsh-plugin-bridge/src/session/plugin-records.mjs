import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';

const writers=new WeakMap();

export function bindPluginRecords(session,write) {
  writers.set(session,write);
}

export function appendRecord(original,session,type,data) {
  const write=writers.get(session);
  return write?write(type,data):original(session,type,data);
}

// The released writer uses a private Session brand. Keep its implementation
// and all exported identities, and dispatch only the public write operation.
export function installSessionRecordWriter(entry) {
  const url=pathToFileURL(entry).href;
  const original=JSON.stringify(url+'?rsi-session-implementation');
  const source=`export * from ${original};
export {default} from ${original};
import {appendPluginRecord as upstream} from ${original};
import {appendRecord} from ${JSON.stringify(import.meta.url)};
export function appendPluginRecord(session,type,data){return appendRecord(upstream,session,type,data)}`;
  return registerHooks({load(id,context,next) {
    return id===url?{format:'module',shortCircuit:true,source}:next(id,context);
  }});
}
