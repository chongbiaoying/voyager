/**
 * Development-only diagnostics for the declarative plugin pipeline.
 *
 * `LoggerService` bottoms out at WARN in every built bundle, so a debug channel
 * for the catalog → host → engine chain has to be compiled in explicitly. The
 * flag is injected by Vite (`VOYAGER_PLUGIN_DEBUG`): dev builds get it for free,
 * release builds only when the operator opts in. When the flag is empty the
 * helpers below reduce to a single string comparison.
 */
export function isPluginDebugEnabled(): boolean {
  try {
    return import.meta.env.VOYAGER_PLUGIN_DEBUG === '1';
  } catch {
    return false;
  }
}

export function pluginDebug(
  scope: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  if (!isPluginDebugEnabled()) return;
  const line = `[Voyager:${scope}] ${message}`;
  // oxlint-disable-next-line no-console -- this channel exists to emit the debug line LoggerService will not
  console.debug(...(details ? [line, details] : [line]));
}
