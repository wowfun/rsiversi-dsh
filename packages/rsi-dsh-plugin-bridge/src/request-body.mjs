import {randomBytes} from 'node:crypto';

export const INLINE_BODY_BYTES = 256 * 1024;
export const BODY_FRAGMENT_BYTES = 512 * 1024;

/** Immutable bytes belong to the pending business request, never to a transfer session. */
export function requestBodies(maximum) {
  const retained = new Map();
  return {
    async send(value, identity, signal, dispatch) {
      signal?.throwIfAborted();
      const encoded = JSON.stringify(value), bytes = Buffer.byteLength(encoded);
      if (bytes > maximum) throw Error('Request body exceeds its byte limit');
      if (bytes <= INLINE_BODY_BYTES) return dispatch({kind:'inline', value});
      if (retained.size >= 2) throw Error('Request body capacity exhausted');
      const token = randomBytes(16).toString('hex');
      retained.set(token, {identity, signal, buffer:Buffer.from(encoded)});
      try {return await dispatch({kind:'paged', token, bytes});}
      finally {retained.delete(token);}
    },
    read({token, offset, ...identity}) {
      const body = retained.get(token);
      if (!body || Object.keys(body.identity).length !== Object.keys(identity).length ||
          Object.entries(body.identity).some(([key,value]) => identity[key] !== value) ||
          !Number.isSafeInteger(offset) || offset < 0 || offset >= body.buffer.length)
        throw Error('Request body is unavailable');
      body.signal?.throwIfAborted();
      return {offset,data:body.buffer.subarray(offset,offset+BODY_FRAGMENT_BYTES).toString('base64')};
    },
    close() {retained.clear();},
  };
}

/** Reconstruct only the declared body; the caller owns cancellation and admission. */
export async function resolveBody(body, maximum, read) {
  if (body?.kind === 'inline') return body.value;
  if (body?.kind !== 'paged' || !Number.isSafeInteger(body.bytes) || body.bytes <= INLINE_BODY_BYTES ||
      body.bytes > maximum || typeof body.token!=='string' || !body.token.length || body.token.length>256) throw Error('Invalid request body');
  const buffer = Buffer.allocUnsafe(body.bytes);
  for (let offset=0; offset<buffer.length;) {
    const part = await read(body.token,offset);
    offset=writeBodyFragment(buffer,offset,part);
  }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
}

export function writeBodyFragment(buffer,offset,part) {
  if (part?.offset !== offset || typeof part.data !== 'string' || part.data.length > Math.ceil(BODY_FRAGMENT_BYTES/3)*4 ||
      part.data.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) throw Error('Invalid request body fragment');
  const decoded = part.data.length/4*3-(part.data.endsWith('==')?2:part.data.endsWith('=')?1:0);
  if (!decoded || decoded > BODY_FRAGMENT_BYTES || decoded > buffer.length-offset ||
      buffer.write(part.data,offset,decoded,'base64')!==decoded) throw Error('Invalid request body fragment');
  return offset+decoded;
}
