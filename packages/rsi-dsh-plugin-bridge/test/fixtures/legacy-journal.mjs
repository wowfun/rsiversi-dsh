import {createHash} from 'node:crypto';

export function legacySources(journal) {
  return Array.from({length:journal.nativeSeq},(_,index)=>{
    const {event,...row}=journal.sourceAt(index);
    return {...row,hash:createHash('sha256').update(JSON.stringify(event)).digest('hex')};
  });
}

export function legacyPrefix(rows) {
  const prefix=createHash('sha256').update('rsi.dsh.native-source-prefix.v1\0');
  for(const {hash} of rows)prefix.update(hash);
  return prefix.digest('hex');
}
