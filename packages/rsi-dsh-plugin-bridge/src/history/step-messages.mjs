export function stepMessageText(message) {
  if (!message || message.role !== 'user' || typeof message.id !== 'string' ||
      typeof message.source?.kind !== 'string' || !Array.isArray(message.content) ||
      message.content.some(part => part.type !== 'text' || typeof part.text !== 'string')) {
    throw new Error('unsupported pre-step message');
  }
  return message.content.map(part => part.text).join('\n');
}

export function toolContextOutput(messages) {
  if (!Array.isArray(messages) || messages.length > 64) throw Error('Tool context capacity');
  const output=messages.map(message=>{
    if (!stepMessageText(message).trim()) throw Error('Empty Tool context');
    return {id:message.id,source:message.source,text:message.content.map(block=>block.text)};
  });
  if (Buffer.byteLength(JSON.stringify(output)) > 64*1024) throw Error('Tool context byte capacity');
  return output;
}

export function toolUserMessage(id, source, content) {
  return {id,role:'user',source:typeof source?.kind === 'string' ? source : {kind:'rsi-tool',original:source},content};
}

export function takeCommittedMessage(mapping, fact) {
  if (!mapping.pendingMessages.length || fact.type !== 'input_message_claimed' ||
      fact.source.type !== 'plugin_context' || fact.source.contribution_id !== 'rsi.extension.before-step') return;
  const message = mapping.pendingMessages[0];
  if (mapping.turnId !== fact.turn_id || mapping.stepId !== fact.step_id ||
      fact.content.length !== 1 || fact.content[0].type !== 'text' || fact.content[0].text !== stepMessageText(message)) {
    throw new Error('committed Step input differs from staged message');
  }
  mapping.pendingMessages.shift();
  return message;
}
