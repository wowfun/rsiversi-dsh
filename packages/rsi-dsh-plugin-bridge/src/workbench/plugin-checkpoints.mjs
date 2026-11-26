import {AsyncLocalStorage} from 'node:async_hooks';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {loaderEntry} from './subagents.mjs';
import {installedResult,runRegion} from './compaction.mjs';

const mounted = new WeakMap();
const transactions = new AsyncLocalStorage();

export function bindCheckpointSession(session, binding) {
  mounted.set(session, binding);
}

// The released engine computes and prices its replacement before appending it.
// Its temporary sequence numbers stay within that call. The published result
// always refers to the events projected from the Host's durable receipt.
export function captureCheckpointAppend(session, type, data, options) {
  const transaction = transactions.getStore();
  if (!transaction || transaction.session !== session) return;
  if (type === 'compaction/start' && !transaction.id) {
    transaction.id = data.compactionId;
    transaction.opening = data;
    return transaction.binding.lifecycle(type,data);
  }
  else if (type === 'compaction/summary' && data.compactionId === transaction.id) transaction.summary = data;
  else if (type === 'user/message' && data.source?.compactionId === transaction.id &&
      options.surfaceOp?.op === 'replace') transaction.message = data;
  else if (type !== 'compaction/end' || data.compactionId !== transaction.id) return;
  else if (data.error !== undefined) return transaction.binding.lifecycle(type,data);
  const seq = Math.max(session.seq, transaction.next);
  transaction.next = seq + 1;
  return {seq, time: Date.now(), type, data, ...options};
}

export function checkpointEngine(Basic) {
  return class extends Basic {
    async compactRegion(start, end, agent, signal) {
      const session = agent.session;
      const binding = mounted.get(session);
      if (!binding) return super.compactRegion(start, end, agent, signal);
      const entry = loaderEntry(this.ctx);
      if (!entry) throw Error('A plugin checkpoint requires its active Loader entry');
      const region = binding.region(start, end);
      return runRegion(session, () => binding.scope.withCaller(async stop => {
        await binding.scope.checkpointOwner(agent.id, stop);
        const transaction = {session, binding, next: session.seq};
        await transactions.run(transaction, () => super.compactRegion(start, end, agent, stop));
        const {summary, message, opening} = transaction;
        try {
          this.ctx.fiber.assertActive();
          stop?.throwIfAborted();
        } catch(error) {
          binding.lifecycle('compaction/end',{...opening,error:error.message});
          throw error;
        }
        const {shadowedSeqs, shadowedRange, compactionId, summary: blocks, ...presentation} = summary;
        const {turn_id:turn, ...coordinates} = region;
        const receipt = await binding.scope.command(agent.id, {type:'install_plugin_checkpoint', turn, effect:compactionId,
          checkpoint:{...coordinates, plugin:entry.options.name, message:{role:'user',content:message.content},
            summary_blocks:{start:1,end:1+blocks.length}, presentation}}, stop);
        if (receipt?.rejected !== undefined) {
          binding.lifecycle('compaction/end',{...opening,error:receipt.rejected});
          throw Error(receipt.rejected);
        }
        if (receipt !== null) throw Error('Invalid plugin checkpoint receipt');
        await binding.refresh(stop);
        return installedResult(session, data => data?.compactionId === compactionId);
      }, signal));
    }
  };
}

// Bind the exported base so a package's own subclass keeps its summarize()
// override, including packages the bridge has never loaded before.
export function installCheckpointEngine(entry) {
  const url = pathToFileURL(entry).href;
  const upstream = JSON.stringify(url + '?rsi-compaction-implementation');
  const source = `export * from ${upstream};
import Basic from ${upstream};
import {checkpointEngine} from ${JSON.stringify(import.meta.url)};
export const BasicCompactionEngine = checkpointEngine(Basic);
export default BasicCompactionEngine;`;
  return registerHooks({load(id, context, next) {
    return id === url ? {format:'module', shortCircuit:true, source} : next(id, context);
  }});
}
