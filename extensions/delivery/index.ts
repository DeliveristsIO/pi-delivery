import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerDelivery } from './extension.mjs';

export default function (pi: ExtensionAPI) {
  registerDelivery(pi, {
    empty: Type.Object({}),
    configure: Type.Object({profile: Type.Optional(Type.String({enum:['default','dev'],description:'Execution profile for newly proposed runs. dev shortens budgets and removes the optimizer pass.'})),routes: Type.Optional(Type.Object(
      Object.fromEntries(['planning','coder','spec','quality','security'].map(role=>[role,Type.Optional(Type.String({maxLength:256,description:'Exact provider/model ID explicitly chosen by the user.'}))])),
      {additionalProperties:false,description:'Omit to inspect configured routes and available models. Changes show a confirmation and preserve retained work.'}
    )),fallbacks: Type.Optional(Type.Object(
      Object.fromEntries(['planning','coder','spec','quality','security'].map(role=>[role,Type.Optional(Type.Array(Type.String({maxLength:256}),{maxItems:3,description:'Ordered exact provider/model failover routes.'}))])),
      {additionalProperties:false,description:'Optional ordered failover routes. Only recognized transport failures may use them.'}
    ))}),
    resume: Type.Object({taskChecks: Type.Optional(Type.Array(Type.Array(Type.String(), {minItems:1,maxItems:10}), {minItems:1,maxItems:12,description:'Legacy check-order recovery only: derive executable checks for EVERY existing task from the approved source plan. Keeps final checks, task scope and completed coder evidence; shows a correction confirmation. It is separate from correction-bound extension and final-exhaustion inspection.'}))}),
    scope: Type.Object({decision: Type.Optional(Type.String({enum:['approve','reject','split'],description:'approve the exact discovered files after confirmation; reject or split preserve them and keep delivery blocked. Omit after an explicit user acceptance to approve.'}))}),
    execute: Type.Object({planFile: Type.Optional(Type.String({description:'Existing Markdown plan under docs/spark/plans/ explicitly requested for execution; no prior registration needed.'}))}),
    diff: Type.Object({ offset: Type.Optional(Type.Integer({minimum:0,description:'Continue a truncated diff from this character offset.'})), commits: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Read the last N committed changes rather than the working-tree diff.' })) }),
    plan: Type.Object({
      planFile: Type.Optional(Type.String({description:'Authoritative existing Markdown plan. After delivery_execute adopts it, derive its tasks here without changing scope; execution starts without repeated approval.'})),
      mode: Type.String({enum:['implementation','review'],description:'Infer from request and conversation: requested review runs read-only; explicit implementation intent starts the displayed unchanged proposal, while planning-only or ambiguous intent does not.'}),
      changeType: Type.Optional(Type.String({enum:['feature','bug','chore'],description:'Required for fresh implementation plans; omitted for review-plan schema compatibility.'})),
      reviewPolicy: Type.Optional(Type.String({enum:['balanced','strict'],description:'Implementation review lifecycle: balanced (default) combines specification and quality review; strict opts into separate reviews.'})),
      executionProfile: Type.Optional(Type.String({enum:['dev','default'],description:'Override the configured profile for this proposal. dev is recommended for small low-risk changes; default is the full delivery flow.'})),
      scopePolicy: Type.Optional(Type.String({enum:['adaptive','strict'],description:'Scope boundary for implementation. adaptive pauses for explicit approval when necessary files are discovered; strict blocks until the plan is changed.'})),
      start: Type.Optional(Type.Boolean({description:'Set false only when the user requested planning without execution. It always prevents launch.'})),
      executionIntent: Type.Optional(Type.Object({
        kind: Type.Literal('explicit-implementation'),
        userTurn: Type.String({minLength:1,maxLength:16000,description:'Exact current interactive/RPC user turn whose conversational meaning explicitly requests implementation. Never attest questions, planning-only requests, rejection, deferral or ambiguity.'})
      }, {additionalProperties:false,description:'Planner attestation for explicit implementation intent. The controller binds it to this exact proposal, session, repository, workspace, routes, budgets, correction and review/security policy, then starts only the unchanged displayed plan.'})),
      reviewAttachment: Type.Optional(Type.Object({kind:Type.Literal('retained-recovery')},{additionalProperties:false,description:'Attach this requested read-only review to a matching failed retained implementation review. The controller verifies task scope, candidate, session, repository, routes and budgets; standalone reviews must omit it.'})),
      correctionAdoption: Type.Optional(Type.Object({
        kind: Type.Literal('retained-candidate'),
        userTurn: Type.String({minLength:1,maxLength:16000,description:'Exact current interactive/RPC user turn explicitly authorizing corrective implementation of the retained dirty candidate.'})
      },{additionalProperties:false,description:'Implementation-only recovery for a stopped failed review or implementation. Binds exact Git ownership, inventory, index and candidate fingerprint; never infer from findings or generic continuation text.'})),
      commits: Type.Optional(Type.Integer({minimum:1,maximum:20,description:'In review mode, pin the last N commits for validation.'})),
      title: Type.String({ maxLength: 200 }),
      tasks: Type.Array(Type.Object({
        title: Type.String({ maxLength: 200 }),
        instructions: Type.String({ maxLength: 16000 }),
        files: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
        sensitive: Type.Optional(Type.Boolean({description:'Explicitly mark this task security-sensitive; balanced policy runs task security review only when true.'})),
        browser: Type.Optional(Type.Boolean({description:'Use an installed browser-control extension for bounded web/UI checks. Browser access is granted only to this task and only when browser tools are available.'})),
        checks: Type.Optional(Type.Array(Type.String(), {minItems:1,maxItems:10,description:'Implementation checks run after THIS task, before its independent reviews. Required for every implementation task. Never require files delivered by a later task.'})),
        acceptance: Type.Array(Type.String(), { minItems: 1, maxItems: 30 }),
      }), { minItems: 1, maxItems: 12 }),
      checks: Type.Array(Type.String({description:'An actual executable test command, e.g. bundle exec rails test. NEVER a checklist sentence. Put human review criteria in task.acceptance.'}), { minItems: 0, maxItems: 10, description:'Final/release checks, run after ALL implementation tasks. For read-only review, these run before reviewers and at final verification. [] permits static review without claiming tests ran.' }),
      risk: Type.String({ description: 'low for ordinary bounded changes; high for security-sensitive work', enum: ['low', 'high'] }),
      security: Type.Boolean({ description: 'Request independent security review; sensitive paths force it on.' }),
    }),
  });
}
