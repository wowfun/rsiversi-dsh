import {provideHttp as provideServer} from '../../src/application/http.mjs';

// Standalone carrier fixtures do not compose the release's Web profile.
export async function provideHttp(ctx,load,key,sessions) {
  await provideServer(ctx,load,key,sessions);
  await (await ctx.plugin(await load('@deepseek-ai/dsh-client-connection'))).await();
}
