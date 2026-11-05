import {resolve,join} from 'node:path';
import {publishBrand} from '../packages/rsi-dsh-plugin-bridge/src/application/brand.mjs';

// Reference documents take their artwork directly from the web publisher.
export function buildBrand(rsi,destination) {
  return publishBrand(destination,join(rsi,'apps/web/public/logo.svg'));
}
if(import.meta.main) await buildBrand(resolve(process.argv[2]),resolve(process.argv[3]));
