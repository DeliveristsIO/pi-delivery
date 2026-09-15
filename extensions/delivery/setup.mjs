export const ROLE_HELP = {
  planning: 'researches the repository, discusses designs and writes the plan; no implementation',
  coder: 'implements approved tasks and adds/runs tests; needs reliable coding and tool use',
  spec: 'checks acceptance criteria and scope in a fresh read-only review',
  quality: 'checks correctness, edge cases, maintainability and test coverage in a fresh review',
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
