import {readFileSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';

/** The original reader owns resolution and localization. Only immutable root packages share its result. */
export function leasedPluginPackages({PluginPackages,resolvePluginResource},leases) {
  const metadata=new WeakMap(),packages=new WeakMap();
  return class extends PluginPackages {
    packageOf(specifier,parentURL) {
      const binding=leases.bindingFor(specifier,parentURL);
      if(!binding)return super.packageOf(specifier,parentURL);
      const cached=packages.get(binding);
      if(cached)return cached;
      const dir=binding.directory,manifestPath=join(dir,'package.json');
      const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
      const pkg={dir,manifestPath,manifest,name:typeof manifest.name==='string'?manifest.name:binding.name,
        version:typeof manifest.version==='string'?manifest.version:undefined};
      packages.set(binding,pkg);return pkg;
    }
    metaOf(specifier,parentURL) {
      const selected=leases.bindingFor(specifier,parentURL);
      if(selected?.name===specifier){
        const cached=metadata.get(selected);
        if(cached)return cached;
      }
      let manifest;
      try {manifest=resolvePluginResource(specifier+'/package.json',parentURL);}
      catch {return super.metaOf(specifier,parentURL);}
      const binding=leases.packageAt(dirname(manifest));
      if(binding?.name!==specifier||basename(manifest)!=='package.json')return super.metaOf(specifier,parentURL);
      const cached=metadata.get(binding);
      if(cached)return cached;
      const meta=super.metaOf(specifier,parentURL);
      if(meta&&!meta.error){
        Object.freeze(meta.title);Object.freeze(meta.description);
        metadata.set(binding,Object.freeze(meta));
      }
      return meta;
    }
  };
}
