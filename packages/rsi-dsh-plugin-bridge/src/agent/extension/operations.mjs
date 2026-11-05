export function agentOperations({get,registry,request}) {
  return {
    async agentTool({ session_id, operation_id, name, arguments: args, fact_horizon }, signal) {
      try {
        const { payload, token } = await this.tool(session_id, operation_id, name, args, signal, fact_horizon);
        signal?.throwIfAborted();
        if (payload.inputs.length) throw new Error('Tool returned inputs requiring atomic input admission');
        return { kind: 'staged', operation_id, expected_revision: payload.expectedRevision, token, events: payload.suffix,
          checkpoint: payload.checkpoint, conclude_turn: payload.result.concludeTurn,
          result: { value: payload.result.value, content: payload.result.content, is_error: payload.result.isError, enforcement: [],
            ...(payload.result.metadata === undefined ? {} : {metadata: payload.result.metadata}),
            ...(payload.result.contexts.length ? {additional_contexts:payload.result.contexts} : {}) } };
      } catch (error) {
        await this.abandon(session_id, operation_id);
        return { kind: 'rejected', diagnostic: String(error?.message ?? error).slice(0, 1000) || 'Tool rejected' };
      }
    },
    async agentCommand({ session_id, operation_id, name, input, fact_horizon }, signal) {
      if (typeof input !== 'string' || Buffer.byteLength(input) > 16 * 1024) throw new Error('invalid command input');
      try {
        const { payload, token } = await this.command(session_id, operation_id, name, input, signal, fact_horizon);
        signal?.throwIfAborted();
        if (payload.result.kind !== 'success') throw new Error(payload.result.text || 'command rejected');
        const inputs = payload.inputs.map(({ kind, message }) => {
          if (!['inject', 'steer'].includes(kind) || !Array.isArray(message.content) || message.content.length !== 1
            || message.content[0].type !== 'text' || typeof message.content[0].text !== 'string') throw new Error('unsupported command message');
          return { delivery: kind, text: message.content[0].text };
        });
        return { kind: 'staged', operation_id, expected_revision: payload.expectedRevision, token,
          events: payload.suffix, checkpoint: payload.checkpoint, inputs };
      } catch (error) {
        await this.abandon(session_id, operation_id);
        return { kind: 'rejected', diagnostic: String(error?.message ?? error).slice(0, 1000) || 'Command rejected' };
      }
    },
    readStepDecision({session_id,operation_id,token,offset}) {
      const staged = get(session_id).staged, buffer = staged?.decisionBytes;
      if (!buffer || staged.operationId !== operation_id || staged.token !== token ||
          !Number.isSafeInteger(offset) || offset < 0 || offset >= buffer.length || (buffer[offset] & 0xc0) === 0x80)
        throw Error('no such staged decision fragment');
      let end = Math.min(offset + 128 * 1024, buffer.length);
      while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
      return buffer.toString('utf8', offset, end);
    },
    async agentBeforeStep({ session_id, operation_id, turn_id, step_id, tools: offered, model_selection, fact_horizon, previous }, signal) {
      if (typeof turn_id !== 'string' || !turn_id || typeof step_id !== 'string' || !step_id
          || !Array.isArray(offered) || offered.length > 64 || offered.some(name => typeof name !== 'string')
          || new Set(offered).size !== offered.length) throw new Error('invalid Step authority');
      try {
        if (previous && Object.hasOwn(previous,'bytes')) {
          const total = previous.bytes, parts = [];
          if (!Number.isSafeInteger(total) || total <= 0 || total > 32 * 1024 * 1024 + 64) throw Error('Invalid prior decision size');
          for (let offset = 0; offset < total;) {
            const part = await request('agent.step-decision.read',{session_id,operation_id,offset},signal);
            const size = typeof part === 'string' && Buffer.byteLength(part);
            if (!size || size > 128 * 1024 || size > total - offset) throw Error('Invalid prior decision fragment');
            parts.push(part); offset += size;
          }
          previous = JSON.parse(parts.join(''));
        }
        const modelSelection = { provider: model_selection.model.deployment, model: model_selection.model.model,
          ...(model_selection.reasoning_effort ? {reasoningEffort: model_selection.reasoning_effort} : {}) };
        const { payload, token } = await this.beforeStep(session_id, operation_id, signal,
          fact_horizon === undefined ? undefined : { turn_id, step_id, fact_horizon }, modelSelection, previous);
        signal?.throwIfAborted();
        if (payload.inputs.length) throw new Error('pre-step emitted unsupported direct message delivery');
        const owned = new Set(registry.definitions().map(definition => definition.name));
        const selected = new Set(payload.result.tools);
        return { kind: 'staged', operation_id, expected_revision: payload.expectedRevision, token,
          events: payload.suffix, checkpoint: payload.checkpoint, instructions: payload.result.instructions,
          decision: payload.result.decision, tools: offered.filter(name => !owned.has(name) || selected.has(name)) };
      } catch (error) {
        await this.abandon(session_id, operation_id);
        return { kind: 'rejected', diagnostic: String(error?.message ?? error).slice(0, 1000) || 'Step rejected' };
      }
    },
  };
}
