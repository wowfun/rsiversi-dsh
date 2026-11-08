import assert from 'node:assert/strict';

/** Publish an exact read-only source using the installed public Session API. */
export function publishLiveSource(ctx,api,{header,inheritedEventCount,events}) {
  let session;
  if(header.isSeeded){
    const marker=events[inheritedEventCount];
    assert.equal(marker?.type,'session/end-seed');assert.equal(marker.data.inherited,true);
    session=api.Session.create(header.id,events,header,inheritedEventCount,ctx.sessions.messageProjections);
  }else{
    assert.equal(inheritedEventCount,0);
    session=api.Session.create(header.id,undefined,header,0,ctx.sessions.messageProjections);
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
  }
  assert.deepEqual(session.header,header);
  assert.equal(session.inheritedEventCount,inheritedEventCount);
  assert.deepEqual(session.snapshotEvents(),events,'Live and persisted sources must have identical logs');
  // Without announce, this published Session remains read-only.
  return ctx.sessions.enter(session);
}
