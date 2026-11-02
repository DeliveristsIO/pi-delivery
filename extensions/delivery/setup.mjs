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
  for(const key of Object.keys(config))if(!['version','routes','approval','commit','timeouts','profiles'].includes(key))ignored(key);
  for(const key of Object.keys(config.timeouts || {}))if(key!=='commandMs')ignored(`timeouts.${key}`);
  return {
    active:{
      routes:Object.fromEntries(roles.filter(role=>config.routes?.[role]!==undefined).map(role=>[role,config.routes[role]])),
      profiles:profileNames(config),
      activeProfile:activeProfile(config),
      approval:config.approval==='manual'?'manual':'autonomous',
      commit:config.commit!==false,
      timeouts:{commandMs:commandTimeout(config)},
    },
    inactiveSettings,
  };
}

// Profiles: named, explicit sets of exact provider/model routes the user switches between.
// Switching only rewrites `routes`; no fallback, escalation or automatic selection.
const PROFILE_NAME=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const PROFILE_ROLES=['planning','coder','quality','security'];
export function profileNames(config) {
  const profiles=config.profiles;
  return profiles && typeof profiles==='object' && !Array.isArray(profiles) ? Object.keys(profiles).filter(name=>PROFILE_NAME.test(name) && PROFILE_ROLES.every(role=>typeof profiles[name]?.[role]==='string' && profiles[name][role])) : [];
}
export function checkProfileName(name) {
  if(typeof name!=='string' || !PROFILE_NAME.test(name) || name==='__proto__')throw new Error('Profile name must be 1-40 characters: letters, digits, dot, underscore or dash.');
  return name;
}
export function saveProfile(config,name,routes) {
  checkProfileName(name);
  const saved={};
  for(const role of PROFILE_ROLES){
    if(typeof routes?.[role]!=='string' || !routes[role])throw new Error(`Cannot save profile: route "${role}" is not configured.`);
    saved[role]=routes[role];
  }
  return {...config,profiles:{...(config.profiles||{}),[name]:saved}};
}
export function deleteProfile(config,name) {
  if(!profileNames(config).includes(name))throw new Error(`Unknown profile "${name}".`);
  const {[name]:_removed,...rest}=config.profiles;
  return {...config,profiles:rest};
}
export function profileRoutes(config,name) {
  if(!profileNames(config).includes(name))throw new Error(`Unknown profile "${name}". Known: ${profileNames(config).join(', ')||'none'}.`);
  const profile=config.profiles[name];
  return Object.fromEntries(PROFILE_ROLES.map(role=>{
    if(typeof profile?.[role]!=='string' || !profile[role])throw new Error(`Profile "${name}" lacks route "${role}".`);
    return [role,profile[role]];
  }));
}
// Name of the profile whose routes equal the current routes, if any.
export function activeProfile(config) {
  return profileNames(config).find(name=>PROFILE_ROLES.every(role=>config.profiles[name][role]===config.routes?.[role]))||null;
}
