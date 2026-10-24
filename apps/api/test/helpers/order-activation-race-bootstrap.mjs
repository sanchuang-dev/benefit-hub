import { register } from 'node:module';

// Registered before the worker module is imported, so every `.js` specifier in
// the API sources resolves to its `.ts` file under Node's type stripping.
register(new URL('./ts-module-loader.mjs', import.meta.url).href);
await import('./order-activation-race-worker.ts');
