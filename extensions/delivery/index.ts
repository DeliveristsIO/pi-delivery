import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerDelivery } from './extension.mjs';
import { SCHEMAS } from './policy.mjs';

export default function (pi: ExtensionAPI) {
  registerDelivery(pi, Object.fromEntries(Object.entries(SCHEMAS).map(([name, schema]) => [name, Type.Unsafe(schema)])));
}
