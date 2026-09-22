export class PluginError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PluginError';
  }
}

export function safeError(error: unknown): string {
  return error instanceof PluginError ? error.code : 'Unexpected operation failure';
}
