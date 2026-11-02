import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const br = promisify(brotliCompress), gz = promisify(gzip);
/** Compress at build time, so Starter spends no request CPU on compression. */
export async function compressStatic(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await compressStatic(path);
    else if (/\.(?:html|js|css|svg|json|webmanifest|txt)$/.test(entry.name)) {
      const bytes = await readFile(path);
      const [brotli, zipped] = await Promise.all([br(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }), gz(bytes)]);
      await Promise.all([writeFile(`${path}.br`, brotli), writeFile(`${path}.gz`, zipped)]);
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await compressStatic(fileURLToPath(new URL('../../dist/public/', import.meta.url)));
}
