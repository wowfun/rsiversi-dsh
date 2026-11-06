export function historyPage(value,through,offset=0) {
  const bytes=Buffer.from(JSON.stringify(value));
  let end=Math.min(offset+128*1024,bytes.length);
  while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
  return {through_seq:through,offset,next_offset:end,total_bytes:bytes.length,json:bytes.subarray(offset,end).toString()};
}
