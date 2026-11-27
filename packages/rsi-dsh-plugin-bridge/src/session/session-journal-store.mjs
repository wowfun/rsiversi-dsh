import {hash} from 'node:crypto';
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
  const packedDirectory=join(directory,'packed');
  let discovery;
  async function names(path) {
    try{return await readdir(path);}
    catch(error){if(error.code==='ENOENT')return [];throw error;}
  }
  async function discover() {
    const flat=await names(directory),files=new Map();
    if(flat.includes('packed'))for(const name of await names(packedDirectory)) {
      if(name.endsWith('.journal'))files.set(name.slice(0,-8),{plain:false});
    }
    for(const name of flat)if(name.endsWith('.json'))files.set(name.slice(0,-5),{plain:true});
    return files;
  }
  function pathFor(stem,plain) {
    return plain?join(directory,stem+'.json'):join(packedDirectory,stem+'.journal');
  }
  function catalogFiles() {
    return discovery??=discover().catch(error=>{discovery=undefined;throw error;});
  }
  async function readCatalog(path) {
    let handle;
    try {
      handle=await open(path,'r');
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
  async function metadata(files,id) {
    const stem=hash('sha256',id),entry=files.get(stem);
    if(!entry||Object.hasOwn(entry,'hint'))return entry?.hint;
    const pending=readCatalog(pathFor(stem,entry.plain));
    entry.hint=pending;
    try{
      const hint=await pending;
      entry.hint=hint;
      return hint;
    }
    catch(error){delete entry.hint;throw error;}
  }
  return {
    async metadata(id){return metadata(await catalogFiles(),id);},
    async decorate(rows,signal) {
      signal?.throwIfAborted();
      if(!rows.length)return rows;
      const files=await catalogFiles().catch(error=>{console.warn('Session catalog hint:',error.message);});
      signal?.throwIfAborted();
      if(!files?.size)return rows;
      for(const row of rows) {
        const hint=await metadata(files,row.id).catch(error=>{console.warn('Session catalog hint:',error.message);});
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
        const stem=hash('sha256',id),entry=(await catalogFiles()).get(stem);
        if(!entry)return;
        const path=pathFor(stem,entry.plain);
        handle=await open(path,'r');
        const info=await handle.stat();
        const packed=!entry.plain;
        // A 128 MiB incompressible input can expand by up to ZSTD_compressBound.
        const fileLimit=packed?maximumJournalBytes+maximumJournalBytes/256:maximumJournalBytes;
        if(!info.isFile()||info.size>fileLimit)throw Error('Application journal document capacity');
        if(!packed)return await handle.readFile('utf8');
        const bytes=await handle.readFile(),body=bytes.indexOf(10)+1;
        if(!body||body>=maximumJournalBytes)throw Error('Invalid application journal catalog');
        const {buffer:json,engine}=await decompress(bytes.subarray(body),{info:true,maxOutputLength:maximumJournalBytes-body});
        if(engine.bytesWritten!==bytes.length-body)throw Error('Trailing bytes in application journal');
        return bytes.toString('utf8',0,body)+json.toString('utf8');
      }catch(error){if(error.code!=='ENOENT')throw error;}
      finally{await handle?.close();}
    },
    async save(id,value) {
      const files=await catalogFiles(),stem=hash('sha256',id),plain=files.get(stem)?.plain??false;
      const path=pathFor(stem,plain),after=journalCatalog(value);
      let bytes=value;
      if(!plain){
        const body=value.indexOf('\n')+1;
        if(!body)throw Error('Incomplete application journal catalog');
        bytes=Buffer.concat([Buffer.from(value.slice(0,body)),await compress(value.slice(body),checksum)]);
      }
      await writeFileAtomic(path,bytes,{mode:0o600,dirMode:0o700});
      const before=files.get(stem)?.hint;
      files.set(stem,{plain,hint:after});
      if(before?.catalogTitle?.seq!==after?.catalogTitle?.seq || before?.header?.origin!==after?.header?.origin)changed?.();
    },
  };
}
