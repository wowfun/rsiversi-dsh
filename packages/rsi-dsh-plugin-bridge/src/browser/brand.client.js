// A normal DSH client module. The document composes this entry in place of
// the official brand entry; the shell owns the layout, sizing and lifecycle.
window.__ModuleLoader__.load({
  id:'rsi-dsh-plugin-bridge',
  factory(require) {
    if(new URLSearchParams(location.search).get('brand')==='original' && typeof originalBrand!=='undefined')
      return originalBrand.factory(require);
    const {jsx}=require('react/jsx-runtime');
    return {inject:['slots'],apply(ctx) {
      const mark=({size,className})=>jsx('img',{src:'/rsi-brand/logo.svg',alt:'',width:size,height:size,className});
      ctx.slots.inject('sidebar.brand.mark',()=>ctx.slots.inject('sidebar.brand.name',function*(){
        yield ctx.slots.register({name:'sidebar.brand.mark'},mark);
        yield ctx.slots.register({name:'sidebar.brand.name'},()=>jsx('span',{children:'RSIversi'}));
      }));
      ctx.slots.inject('conversation.hero.brand.mark',function*(){
        yield ctx.slots.register({name:'conversation.hero.brand.mark'},mark);
      });
      const previous=document.title;
      const title=document.querySelector('title');
      const name='RSIversi';
      const rename=()=>{
        if(previous===name) return;
        if(document.title===previous) document.title=name;
        else if(previous && document.title.endsWith(' — '+previous))
          document.title=document.title.slice(0,-previous.length)+name;
      };
      const observer=new MutationObserver(rename);
      if(title) observer.observe(title,{childList:true,subtree:true,characterData:true});
      const icons=[...document.querySelectorAll('link[rel~="icon"]')].map(icon=>[icon,icon.href]);
      for(const [icon] of icons) icon.href='/rsi-brand/logo.svg';
      rename();
      ctx.effect(()=>()=>{observer.disconnect();for(const [icon,href] of icons) icon.href=href;
        if(document.title===name) document.title=previous;});
    }};
  },
});
