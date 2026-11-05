import {attachTerminal} from './stream.mjs';

function shellOf(catalog) {
  return {path:catalog.program,name:catalog.program.split(/[\\/]/).at(-1),args:catalog.arguments};
}

export function terminalController(TypertRemoteService,scope,config) {
  return class extends TypertRemoteService {
    titles=new Map();
    constructor(ctx) {super(ctx,'terminalController',{namespace:'terminal'});}
    async environment(agent,signal) {
      const {cwd}=await scope.terminal(agent.id,null,signal);
      return {cwd,maxInputBytes:Math.min(config.maxInputBytes,65536),maxBufferedBytes:config.maxBufferedBytes,
        maxCols:Math.min(config.maxCols,500),maxRows:Math.min(config.maxRows,200),scrollback:config.scrollback};
    }
    async shells(agent,signal) {return [shellOf(await scope.terminal(agent.id,null,signal))];}
    info(session,key,terminal,catalog) {
      const shell=shellOf(catalog);
      return {id:key,title:this.titles.get(session+'\0'+key)??shell.name,shell,cwd:catalog.cwd,
        cols:terminal.size.columns,rows:terminal.size.rows,state:terminal.phase.state,exitCode:terminal.phase.exit_code??null};
    }
    async binding(session,key,signal) {
      const catalog=await scope.terminal(session,null,signal);
      const bound=catalog.bindings.find(row=>row.key===key);
      if(!bound) throw new Error('Terminal is unavailable in this Session');
      return {terminal:bound.terminal,catalog};
    }
    async list(session) {
      const catalog=await scope.terminal(session,null);
      return catalog.bindings.map(({key,terminal})=>this.info(session,key,terminal,catalog));
    }
    async create(agent,request,signal) {
      const catalog=await scope.terminal(agent.id,null,signal);
      if(request.shellPath && request.shellPath!==catalog.program)throw new Error('Shell unavailable in this Session');
      const reply=await scope.terminal(agent.id,{type:'create',key:request.id,size:{rows:request.rows,columns:request.cols}},signal);
      if(reply.type!=='terminal')throw new Error('Missing native terminal receipt');
      return this.info(agent.id,request.id,reply.value,catalog);
    }
    async *retain(session,key,signal) {
      await this.binding(session,key,signal);
      yield {type:'retained'};
      await scope.waitTerminal(session,key,signal);
    }
    attach(agent,key,signal) {
      const invocation=this.ctx.invocation;
      if(!invocation)throw new Error('Terminal attachment requires a Remote invocation');
      return attachTerminal(scope,this,agent.id,key,invocation.uplink(),invocation.uplinkWindow,signal);
    }
    async rename(agent,key,title) {
      if(!title.trim()||title.length>120)throw new Error('Invalid terminal title');
      await this.binding(agent.id,key);
      const name=agent.id+'\0'+key;
      if(!this.titles.has(name)&&this.titles.size>=8192)throw new Error('Terminal title capacity');
      this.titles.set(name,title);
    }
    async close(agent,key) {
      const catalog=await scope.terminal(agent.id,null);
      const terminal=catalog.bindings.find(row=>row.key===key)?.terminal;
      if(terminal)await scope.terminal(agent.id,{type:'operate',operation:{type:'close',terminal:terminal.id}});
      this.titles.delete(agent.id+'\0'+key);
    }
  };
}
