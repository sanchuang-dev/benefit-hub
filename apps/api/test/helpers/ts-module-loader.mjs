/**
 * Test-only ESM resolve hook.
 *
 * The API sources are written for `tsc` (`./module.js` specifiers whose files
 * are `.ts` on disk). Node's built-in TypeScript stripping executes `.ts`
 * directly but does not rewrite those specifiers, so retry failed relative
 * `.js` resolutions as `.ts`. This is only used by the Worker-thread race test
 * so it can run the real repository code in two OS threads.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      specifier.startsWith('.') &&
      specifier.endsWith('.js') &&
      context.parentURL?.endsWith('.ts')
    ) {
      return {
        url: new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL).href,
        shortCircuit: true,
      };
    }
    throw error;
  }
}
