import { uuidv7 } from 'uuidv7';

/**
 * The one ID generator for the whole platform (CLAUDE.md §3): UUIDv7,
 * generated in the application so IDs stay client-generatable for the
 * later offline queue.
 */
export function newId(): string {
  return uuidv7();
}
