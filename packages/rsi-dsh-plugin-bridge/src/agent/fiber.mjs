/** Explain a pending Fiber using the injections Cordis resolved in its own scope. */
export function inactiveFiber(label,fiber) {
  if(!fiber) return label;
  const missing=Object.keys(fiber.inject).filter(name=>fiber.ctx.get(name)===undefined);
  return missing.length ? label+' requires '+missing.join(', ') : label;
}
