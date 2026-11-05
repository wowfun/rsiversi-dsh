/** Native choices and canonical request headers have distinct lifetimes. */
const convert=value=>({provider:value.model.deployment,model:value.model.model,
  ...(value.reasoning_effort==null?{}:{reasoningEffort:value.reasoning_effort})});
export function workbenchModel(baseline) {
  return state(convert(baseline));
}

export function lastUsedModel(header) {
  return header?{provider:header.config.provider,model:header.config.model,
    ...(header.adapterDefaults?.reasoningEffort===true||header.config.reasoningEffort===undefined
      ?{}:{reasoningEffort:header.config.reasoningEffort})}:null;
}

function state(selected) {
  return {
    branch:()=>state(selected),
    observe(event,session) {
      selected=convert(event.selection);
      return session.appendObserved('model/selection',selected,event.time);
    },
    snapshot(session) {
      return {lastUsed:lastUsedModel(session.requestHeader()),next:selected};
    },
  };
}
