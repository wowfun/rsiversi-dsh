/** These DSH event payloads carry no event positions or model-surface edits. */
export function isForkAnnotation(type) {
  return type === 'working-directory/change' || type === 'subagent/descriptor';
}

export function isInheritedMarker(event) {
  return event?.type === 'session/end-seed' && event.data?.inherited === true;
}

export function assertForkAnnotation(event) {
  if (Object.keys(event).some(key => !['type', 'data', 'time', 'seq', 'ignorable'].includes(key)) ||
      (event.ignorable !== undefined && event.ignorable !== true) ||
      !Number.isSafeInteger(event.time) || event.time < 0 || !Object.hasOwn(event, 'data')) {
    throw Error('Fork annotation requires a timed, reference-free log event');
  }
}

/** Take only the constructor's metadata at the cut, before yielding to native creation. */
export function snapshotForkAnnotations(seed, cut, snapshotJsonValue) {
  if (cut === undefined || cut === 0) return [];
  if (!Number.isSafeInteger(cut) || cut < 0 || cut > seed.length ||
      (cut < seed.length && !isInheritedMarker(seed[cut]))) throw Error('Invalid inherited Session seed cut');
  let start = cut;
  while (start > 0 && isForkAnnotation(seed[start - 1].type)) start--;
  if (start === cut) return [];
  const events = snapshotJsonValue(seed.slice(start, cut));
  if (!events) throw Error('Fork annotation requires lossless JSON');
  for (const [offset, event] of events.entries()) {
    if (event.seq !== start + offset) throw Error('Invalid fork annotation position');
    assertForkAnnotation(event);
  }
  return events;
}
