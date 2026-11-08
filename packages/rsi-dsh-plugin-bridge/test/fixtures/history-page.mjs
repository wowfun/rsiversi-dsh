export function historyPage(value,through,offset=0) {
  const bytes=Buffer.from(JSON.stringify(value));
  let end=Math.min(offset+128*1024,bytes.length);
  while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
  return {through_seq:through,offset,next_offset:end,total_bytes:bytes.length,json:bytes.subarray(offset,end).toString()};
}

export function historyCapture(meta,operation,facts=[],controls=[]) {
  if(meta===null)return historyPage(null,0,operation.offset);
  const cut=meta.selection_cursor;
  const slice=(rows,after,through,limit)=>{
    if(rows===null||after===through)return null;
    const value=rows.filter(row=>row.seq>after&&row.seq<=through).slice(0,limit);
    return {through:value.length===limit?value.at(-1).seq:through,value};
  };
  return historyPage({meta,
    facts:slice(facts,operation.after.fact_seq,cut.fact_seq,512),
    controls:slice(controls,operation.after.control_seq,cut.control_seq,64),
  },cut.fact_seq,operation.offset);
}
