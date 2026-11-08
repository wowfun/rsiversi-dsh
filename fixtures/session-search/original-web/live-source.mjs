import assert from 'node:assert/strict';

/** Replay a fixture's exact unseeded log using the installed public Session API. */
export function publishLiveSource(ctx,api,{header,inheritedEventCount,events}) {
  assert.equal(header.isSeeded,false,'This live-source fixture requires an unseeded corpus');
  assert.equal(inheritedEventCount,0);
  const session=api.Session.create(header.id,undefined,header,0,ctx.sessions.messageProjections);
  const now=Date.now;
  try {
    // No await or publication while this detached fixture uses recorded time.
    for(const event of events){
      Date.now=()=>event.time;
      if(event.ignorable)api.appendPluginRecord(session,event.type,event.data);
      else session.append(event.type,event.data,{
        ...(event.surfaceOp===undefined?{}:{surfaceOp:event.surfaceOp}),
        ...(event.sourceEventSeqs===undefined?{}:{sourceEventSeqs:event.sourceEventSeqs}),
      });
    }
  }finally{Date.now=now;}
  assert.deepEqual(session.header,header);
  assert.deepEqual(session.snapshotEvents(),events,'Live and persisted sources must have identical logs');
  // Without announce, this published Session remains read-only.
  return ctx.sessions.enter(session);
}
