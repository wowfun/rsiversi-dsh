import { Context } from '@deepseek-ai/cordis';
export const name = 'import-fixture';
export const inject = ['commands'];
export function apply(ctx) {
  if (!(ctx instanceof Context)) throw new Error('Split Cordis identity');
  ctx.effect(() => ctx.commands.register({name:'imported',description:'Imported command',
    handler:() => ({kind:'success',text:'Imported DSH command executed.'})}));
}
