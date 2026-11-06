const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

/** One captured horizon, one retained page; callers may advance through several anchors. */
export function historyReader(request, identity, after, horizon, signal) {
  if (!integer(after) || !integer(horizon) || after > horizon) throw new Error('invalid history horizon');
  let cursor = after, through = after, facts = [], next = 0;
  return async (until, consume) => {
    signal?.throwIfAborted();
    if (!integer(until) || until < cursor || until > horizon) throw new Error('invalid history anchor');
    while (cursor < until) {
      if (cursor === through) {
        facts = [];
        const page = await readPage(request, 'agent.history.read', { ...identity, through_seq: horizon }, cursor, horizon, signal);
        through = page.through; facts = page.value; next = 0;
        if (!Array.isArray(facts) || facts.length > 512 || facts.some((fact, i) => !integer(fact.seq) || fact.seq <= (i ? facts[i - 1].seq : cursor) || fact.seq > through)) {
          throw new Error('invalid captured Fact page');
        }
      }
      while (next < facts.length && facts[next].seq <= until) {
        signal?.throwIfAborted();
        await consume(facts[next], facts);
        next++;
      }
      cursor = Math.min(through, until);
    }
    return cursor;
  };
}

export async function readHistory(request, identity, after, horizon, consume, signal) {
  return historyReader(request, identity, after, horizon, signal)(horizon, consume);
}

export async function readControls(call, after, horizon, signal) {
  const {through,value}=await readPage((_method,{offset})=>call({type:'controls',after_seq:after,
    through_seq:horizon,offset}), 'controls', {}, after, horizon, signal);
  if(!Array.isArray(value)||value.length>64||value.some((event,i)=>
    !integer(event.seq)||event.seq<=(i?value[i-1].seq:after)||event.seq>through))
    throw Error('Invalid captured control page');
  return {through,events:value};
}

async function readPage(request, method, identity, after, horizon, signal) {
  let offset = 0, through, total; const fragments = [];
  do {
    signal?.throwIfAborted();
    const page = await request(method, { ...identity, after_seq: after, offset }, signal);
    if (!integer(page.through_seq) || page.through_seq <= after || page.through_seq > horizon
        || !integer(page.total_bytes) || page.total_bytes < 2 || page.total_bytes > 36 * 1024 * 1024 + 2
        || page.offset !== offset || !integer(page.next_offset) || page.next_offset <= offset
        || page.next_offset > page.total_bytes || typeof page.json !== 'string'
        || page.next_offset - offset > 128 * 1024 || Buffer.byteLength(page.json) !== page.next_offset - offset
        || through !== undefined && (through !== page.through_seq || total !== page.total_bytes)) throw new Error('invalid history fragment');
    through = page.through_seq; total = page.total_bytes; offset = page.next_offset; fragments.push(page.json);
  } while (offset < total);
  return { through, value: JSON.parse(fragments.join('')) };
}
export async function readNativeMessage(call, messageId, seq, signal) {
  const {through,value}=await readPage((_method,{offset})=>call({type:'message',message_id:messageId,
    accepted_control_seq:seq,offset}), 'message', {}, seq-1, seq, signal);
  if(through!==seq||value.message_id!==messageId)throw new Error('Native inbox acceptance identity mismatch');
  return value;
}
