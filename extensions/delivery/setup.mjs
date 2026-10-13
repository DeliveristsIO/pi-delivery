export const ROLE_HELP = {
  planning: 'researches the repository, discusses designs and writes the plan; no implementation',
  coder: 'implements approved tasks and adds/runs tests; needs reliable coding and tool use',
  spec: 'legacy route retained for configuration compatibility; unused by the coordinator',
  quality: 'combined specification compliance, correctness, edge cases, maintainability and tests in a fresh read-only review',
  security: 'checks security risks, trust boundaries and sensitive changes in a fresh read-only review',
};
const tokens=n=>typeof n==='number' && Number.isFinite(n) && n>0 ? `${Math.round(n/1000)}k` : '?';
const clean=s=>String(s).replace(/[\x00-\x1f\x7f-\x9f]/g,'');
export function modelLabel(model) {
  const id=clean(`${model.provider}/${model.id}`);
  const reasoning=typeof model.reasoning==='boolean'?(model.reasoning?'reasoning':'no reasoning'):'reasoning ?';
  const input=Array.isArray(model.input)?model.input.map(clean).join('+'):'input ?';
  const cost=model.cost;
  // Registry prices are estimates, not subscription/quota billing. Zero often means unpriced.
  const priced=Number.isFinite(cost?.input) && cost.input>0 && Number.isFinite(cost?.output) && cost.output>0;
  const price=priced?`catalog $${cost.input}/$${cost.output} in/out per 1M`:'price unknown/unpriced';
  return `${id} · ctx ${tokens(model.contextWindow)} / out ${tokens(model.maxTokens)} · ${reasoning} · ${input} · ${price}`;
}

export function commandTimeout(config) {
  const value=config.timeouts?.commandMs;
  if(value===undefined)return 120000;
  if(!Number.isSafeInteger(value) || value<1000 || value>3600000)throw new Error(`delivery.json timeouts.commandMs must be an integer of milliseconds between 1000 and 3600000; got ${JSON.stringify(value)}.`);
  return value;
}

// Only report ignored field names: their stored values are neither effective nor needed.
export function configurationReport(config) {
  const roles=['planning','coder','quality','security'];
  const inactiveSettings=[];
  const ignored=path=>inactiveSettings.push({path,reason:'Retained in configuration; not used by the coordinator.'});
  for(const role of Object.keys(config.routes || {}))if(!roles.includes(role))ignored(`routes.${role}`);
  for(const key of Object.keys(config))if(!['version','routes','approval','commit','timeouts'].includes(key))ignored(key);
  for(const key of Object.keys(config.timeouts || {}))if(key!=='commandMs')ignored(`timeouts.${key}`);
  return {
    active:{
      routes:Object.fromEntries(roles.filter(role=>config.routes?.[role]!==undefined).map(role=>[role,config.routes[role]])),
      approval:config.approval==='manual'?'manual':'autonomous',
      commit:config.commit!==false,
      timeouts:{commandMs:commandTimeout(config)},
    },
    inactiveSettings,
  };
}
