import {resolveBody} from '../../src/request-body.mjs';

export async function nativeSubmission({body,...identity}, sessions) {
  return {...identity,...await resolveBody(body,8*1024*1024,
    (token,offset)=>sessions.readSubmission({...identity,token,offset}))};
}
