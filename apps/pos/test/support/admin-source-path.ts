import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const POS_SOURCE = fileURLToPath(new URL('../../src/', import.meta.url));
export const LIFTED_SOURCE = fileURLToPath(new URL('../../../../packages/admin-screens/src/lifted/', import.meta.url));

/** Source guards inspect the implementation after the move, never its POS re-export. */
export const adminSourcePath = (path: string): string =>
  join(path.replaceAll('\\', '/').startsWith('components/admin/') ? LIFTED_SOURCE : POS_SOURCE, path);
