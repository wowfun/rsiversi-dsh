import {createHash} from 'node:crypto';
import {open,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {constants,zstdCompress,zstdDecompress} from 'node:zlib';
import {maximumJournalBytes} from './journal-document.mjs';

const marker='{"header":';
const markerBytes=Buffer.from(marker);
const compress=promisify(zstdCompress),decompress=promisify(zstdDecompress);
const checksum={params:{[constants.ZSTD_c_checksumFlag]:1}};
export function journalCatalog(document) {
  if(!document?.startsWith(marker))return;
  const end=document.indexOf(',\n');
  if(end<0)throw Error('Incomplete application journal catalog');
  const value=JSON.parse(document.slice(0,end)+'}');
  if(value.ownedEventCount!==undefined&&(!Number.isSafeInteger(value.ownedEventCount)||value.ownedEventCount<0
    ||Object.is(value.ownedEventCount,-0)||value.ownedEventCount>100_000))throw Error('Invalid application journal catalog count');
  return value;
}

/** The application profile owns one writer; atomic replacement gives cold readers a complete log. */
export function sessionJournalStore(directory,{writeFileAtomic},changed) {
  let plainFiles;
  async function file(id) {
    // The single writer creates only packed journals. Existing flat files keep their encoding.
    plainFiles??=readdir(directory).then(names=>new Set(names.filter(name=>name.endsWith('.json'))),error=>{
      if(error.code==='ENOENT')return new Set();
      plainFiles=undefined;
      throw error;
    });
    const stem=createHash('sha256').update(id).digest('hex'),plain=stem+'.json';
    return (await plainFiles).has(plain)?join(directory,plain):join(directory,'packed',stem+'.journal');
  }
  const catalog=new Map();
  async function readCatalog(id) {
    let handle;
    try {
      handle=await open(await file(id),'r');
      const chunks=[];let length=0;
      for(;;){
        const buffer=Buffer.allocUnsafe(4096),{bytesRead}=await handle.read(buffer);
        if(!bytesRead)return;
        const chunk=buffer.subarray(0,bytesRead);
        if(!length&&!chunk.subarray(0,markerBytes.length).equals(markerBytes))return;
        const end=chunk.indexOf(10);
        chunks.push(end<0?chunk:chunk.subarray(0,end+1));length+=chunks.at(-1).length;
        if(length>maximumJournalBytes)throw Error('Application journal document capacity');
        if(end>=0)return journalCatalog(Buffer.concat(chunks,length).toString());
      }
    }catch(error){if(error.code!=='ENOENT')throw error;}
    finally{await handle?.close();}
  }
  async function metadata(id) {
    if(catalog.has(id))return catalog.get(id);
    const pending=readCatalog(id);
    catalog.set(id,pending);
    try {
      const hint=await pending;
      if(catalog.get(id)===pending)catalog.set(id,hint);
      return hint;
    }catch(error){if(catalog.get(id)===pending)catalog.delete(id);throw error;}
  }
  return {
    metadata,
    async decorate(rows,signal) {
      signal?.throwIfAborted();
      const visible=new Set(rows.map(row=>row.id));
      for(const id of catalog.keys())if(!visible.has(id))catalog.delete(id);
      for(const row of rows) {
        const hint=await metadata(row.id).catch(error=>{console.warn('Session catalog hint:',error.message);});
        signal?.throwIfAborted();
        const {header,catalogTitle}=hint??{};
        if(header?.id!==row.id||header.createdAt!==row.createdAt)continue;
        if(header.origin==='subagent'&&typeof header.parentSession==='string')row.parent=header.parentSession;
        if(typeof catalogTitle?.value==='string'&&Number.isSafeInteger(catalogTitle.seq)&&catalogTitle.seq>=0)
          row.projections={kind:'cached',asOfSeq:catalogTitle.seq,values:{title:catalogTitle.value}};
      }
      return rows;
    },
    async read(id) {
      let handle;
      try {
        const path=await file(id);
        handle=await open(path,'r');
        const info=await handle.stat();
        const packed=path.endsWith('.journal');
        // A 128 MiB incompressible input can expand by up to ZSTD_compressBound.
        const fileLimit=packed?maximumJournalBytes+maximumJournalBytes/256:maximumJournalBytes;
        if(!info.isFile()||info.size>fileLimit)throw Error('Application journal document capacity');
        if(!packed)return await handle.readFile('utf8');
        const bytes=await handle.readFile(),body=bytes.indexOf(10)+1;
        if(!body||body>=maximumJournalBytes)throw Error('Invalid application journal catalog');
        const json=await decompress(bytes.subarray(body),{maxOutputLength:maximumJournalBytes-body});
        return bytes.toString('utf8',0,body)+json.toString('utf8');
      }catch(error){if(error.code!=='ENOENT')throw error;}
      finally{await handle?.close();}
    },
    async save(id,value) {
      const path=await file(id),after=journalCatalog(value);
      let bytes=value;
      if(path.endsWith('.journal')){
        const body=value.indexOf('\n')+1;
        if(!body)throw Error('Incomplete application journal catalog');
        bytes=Buffer.concat([Buffer.from(value.slice(0,body)),await compress(value.slice(body),checksum)]);
      }
      await writeFileAtomic(path,bytes,{mode:0o600,dirMode:0o700});
      const before=catalog.get(id);
      catalog.set(id,after);
      if(before?.catalogTitle?.seq!==after?.catalogTitle?.seq || before?.header?.origin!==after?.header?.origin)changed?.();
    },
  };
}
