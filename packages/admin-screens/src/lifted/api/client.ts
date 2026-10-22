/** A host error is recognised structurally; screens never import an app error class. */
export function isApiError(error: unknown): error is Error & { status: number; code: string; details?: unknown } {
  return error instanceof Error && 'status' in error && typeof error.status === 'number' && 'code' in error && typeof error.code === 'string';
}

export function isMissingRoute(error: unknown): boolean {
  return isApiError(error) && error.status === 404 && error.code === 'UNKNOWN';
}

export const idemKey = (): string => crypto.randomUUID();
