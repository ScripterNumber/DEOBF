/** development traces: environment variable when running under Node (undefined in the browser) */
export const devEnv = (name: string): string | undefined => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p && p.env ? p.env[name] : undefined;
};
