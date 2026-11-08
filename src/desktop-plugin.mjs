import { apply as applyRuntime } from './runtime.mjs';
export { name, inject } from './runtime.mjs';
export function apply(ctx, options = {}) {
  return applyRuntime(ctx, { ...options, hostMode: 'desktop' });
}
