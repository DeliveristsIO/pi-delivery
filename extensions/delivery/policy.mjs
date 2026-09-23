export const ROLES = ['planning', 'coder', 'quality', 'security'];
export const AGENTS = {coder:'delivery-coder', quality:'delivery-reviewer', security:'delivery-security'};
const string = maxLength => ({type:'string',minLength:1,maxLength});
const list = (items,maxItems,minItems=0) => ({type:'array',items,minItems,maxItems});
const object = (properties,required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
const checks = list(string(2000),10);
export const PLAN_SCHEMA = object({
  mode:{type:'string',enum:['implementation','review']}, title:string(200),
  tasks:list(object({title:string(200),instructions:string(16000),files:list(string(512),100,1),acceptance:list(string(2000),30,1),checks,sensitive:{type:'boolean'}},['title','instructions','files','acceptance','checks']),12,1),
  checks, security:{type:'boolean'}
});
export const REPORT_SCHEMA = object({status:{type:'string',enum:['approved','changes_requested','blocked']},summary:string(8000),findings:list(string(2000),50)});
export const SCHEMAS = {empty:object({}),plan:PLAN_SCHEMA,configure:object({routes:object(Object.fromEntries(ROLES.map(role=>[role,string(256)])),[])},[])};

// The public JSON schemas and runtime share this small validator (no coercion).
export function validate(schema,value,path='input') {
  if(schema.type==='object') {
    if(!value || typeof value!=='object' || Array.isArray(value))throw new Error(`${path}: expected object`);
    for(const key of schema.required)if(!(key in value))throw new Error(`${path}.${key}: required`);
    for(const key of Object.keys(value)) {
      if(!schema.properties[key])throw new Error(`${path}.${key}: unsupported field`);
      validate(schema.properties[key],value[key],`${path}.${key}`);
    }
  } else if(schema.type==='array') {
    if(!Array.isArray(value) || value.length<schema.minItems || value.length>schema.maxItems)throw new Error(`${path}: invalid array length`);
    value.forEach((item,i)=>validate(schema.items,item,`${path}[${i}]`));
  } else if(typeof value!==schema.type || (schema.type==='string' && (!value.trim() || value.includes('\0') || value.length>(schema.maxLength ?? Infinity))) || (schema.enum && !schema.enum.includes(value)))throw new Error(`${path}: invalid ${schema.type}`);
  return value;
}
export function validatePlan(input) {
  validate(PLAN_SCHEMA,input,'plan');
  if(JSON.stringify(input).length>64000)throw new Error('Plan exceeds 64k characters');
  const plan=structuredClone(input);
  for(const task of plan.tasks) {
    if(task.files.some(p=>p.startsWith('/') || p.startsWith(':') || /[\\*?\[]/.test(p) || p.split('/').some(part=>['.','..','.git',''].includes(part))))throw new Error('Use literal repository-relative files or directories');
    if(plan.mode==='implementation' && !task.checks.length)throw new Error('Each implementation task needs executable checks');
    if(plan.mode==='review' && task.checks.length)throw new Error('Read-only review cannot execute shell checks');
    if(/auth|bank|payment|secret|upload|dependenc|deploy|network|permission|package(-lock)?\.json|Gemfile|\.github/i.test(task.files.join('\n')))task.sensitive=true;
  }
  if(plan.mode==='review' && plan.checks.length)throw new Error('Read-only review cannot execute shell checks; supply existing evidence in instructions');
  return plan;
}
export function validateReport(report) {
  validate(REPORT_SCHEMA,report,'report');
  if(report.status==='approved' && report.findings.length)throw new Error('Approved report has unresolved findings');
  if(report.status==='changes_requested' && !report.findings.length)throw new Error('Correction report needs concrete findings');
  return report;
}
export function validateRoutes(routes,available,roles=ROLES) {
  return Object.fromEntries(roles.map(role=>{
    const id=routes?.[role];
    if(typeof id!=='string' || !available.includes(id))throw new Error(`Missing/unavailable exact model route: ${role}. Use /delivery setup or delivery_configure; no model was substituted.`);
    return [role,id];
  }));
}
export function isApproval(text) {
  return /^(?:approved|approve(?: the (?:displayed )?plan)?|(?:please )?(?:implement|execute)(?: the| this)? (?:displayed |unchanged )?plan|go ahead)[.!]?$/i.test(text.trim());
}
export const inScope=(path,files)=>files.some(file=>path===file || path.startsWith(file+'/'));
export function assertUnchanged(before,after,files=[]) {
  for(const path of new Set([...Object.keys(before),...Object.keys(after)]))if(!inScope(path,files) && before[path]!==after[path])throw new Error(`Workspace changed outside ${files.length?'approved task scope':'the approved snapshot'}: ${path}. Preserve edits and inspect; no rollback was attempted.`);
}
export function assertScope(snapshot,files) {
  for(const [path,value] of Object.entries(snapshot))if(value.startsWith('symlink:') && (inScope(path,files) || files.some(file=>file.startsWith(path+'/'))))throw new Error(`Approved scope traverses an opaque symlink: ${path}. Resolve the dependency before approval.`);
}
