import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const tsx = fileURLToPath(new URL('../../oto-app/node_modules/tsx/dist/cli.mjs', import.meta.url));

describe('SCRUM-1063 tablet clock-in and clock-out', () => {
  it('reports the switch enforced by the face clock on the existing public branch read', () => {
    const routes = readFileSync(new URL('../../oto-app/server/routes.ts', import.meta.url), 'utf8');
    const branch = routes.split('app.get("/api/public/branches/:id"')[1]?.split('app.post(')[0];
    expect(branch).toContain('faceClockInEnabled: faceClockInOn()');
  });

  it.skipIf(!existsSync(tsx))('shows the required photo immediately only when the server explicitly switches face off', () => {
    const output = execFileSync(process.execPath, [tsx, 'tests/kiosk-clock-ui.check.ts'], {
      cwd: app,
      env: { ...process.env, TSX_TSCONFIG_PATH: 'tests/tsconfig.jsx.json' },
      encoding: 'utf8',
    });
    expect(output).toContain('off, on and older branch replies passed');
  });
});
