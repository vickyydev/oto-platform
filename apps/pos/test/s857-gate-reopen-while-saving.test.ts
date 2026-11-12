import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-857 with SCRUM-887 — THE GATE DOES NOT OPEN AGAIN UNDER ITS OWN RUN.
 *
 * The family's Done runs the gate while staff may be anywhere, and a run whose
 * link dropped is retried online for a while (SCRUM-887). Staff can go Back to
 * the cart while it runs (the smoke's Back and Cancel case). Pressing "Done
 * adding" or Pay then used to open the gate afresh under the running write:
 * the registration, stay, waiver and child ids it writes with and the online
 * hold were all cleared, and the run, still the sale's own, then landed on a
 * new blank form. Opening waits for the run instead: once it lands the sale
 * carries the children and is not gated again; if it fails, the next press
 * opens the gate as before.
 */
describe('opening the drop-off gate while a run of it is saving', () => {
  const till = readFileSync(resolve(import.meta.dirname, '../src/pages/Till.tsx'), 'utf8');
  const open = till.slice(till.indexOf('const openSupervisionGate'), till.indexOf('const handleUpdateSlot'));

  it('is refused before anything the run writes with is cleared, and staff are told why', () => {
    const guard = open.indexOf('if (gateRunningRef.current) {');
    expect(guard).toBeGreaterThan(-1);
    expect(open.slice(guard)).toMatch(/^if \(gateRunningRef\.current\) \{\s*toast\(\{\s*title: 'Still registering the children',[\s\S]*?\}\);\s*return;\s*\}/);
    for (const cleared of ['gateRegistrationIdRef.current = null;', 'gateStayIdsRef.current = new Map();',
      'gateChildIdsRef.current = new Map();', 'gateOnline.reset();', 'setSuperSlots(']) {
      expect(open.indexOf(cleared), cleared).toBeGreaterThan(guard);
    }
  });

  it('the run holds the flag from its press until it has landed or failed, whoever pressed', () => {
    const run = till.slice(till.indexOf('const runSupervisionGate'), till.indexOf('const findOrCreateGateMember'));
    expect(run).toMatch(/if \(gateRunningRef\.current\) return;\s*gateRunningRef\.current = true;/);
    expect(run).toMatch(/resolveSupervisionGate\(\)\.finally\(\(\) => \{\s*gateOnline\.endPress\(\);\s*gateRunningRef\.current = false;/);
    expect(till.match(/gateRunningRef\.current = false;/g)).toHaveLength(1);
  });

  it('every caller stops when the gate is not opened: none goes on to payment', () => {
    expect(till).toMatch(/if \(!supervisionResolved && evaluateUnaccompanied\(\)\) \{\s*openSupervisionGate\(\);\s*return;\s*\}\s*proceedToPayment\(\);/);
    expect(till).toMatch(/if \(!supervisionResolved && evaluateUnaccompanied\(\)\) \{\s*openSupervisionGate\(\);\s*return false;\s*\}/);
    expect(till).toMatch(/if \(entitled\.dropOff\) \{\s*openSupervisionGate\(\{[^}]*\}\);\s*\}\s*\};/);
    expect(till.match(/openSupervisionGate\(/g)).toHaveLength(4);
  });
});
