import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_WORDS, type Permission } from '../src/permissions';

describe('plain permission sentences (SCRUM-612)', () => {
  it('covers exactly the declared vocabulary through the public permissions module', () => {
    expect(Object.keys(PERMISSION_WORDS).sort()).toEqual([...PERMISSIONS].sort());
    for (const permission of PERMISSIONS) {
      const sentence: string = PERMISSION_WORDS[permission];
      expect(sentence, permission).toMatch(/^[A-Z][^\n]+\.$/);
      expect(sentence.trim(), permission).toBe(sentence);
      expect(sentence.split(/\s+/).length, permission).toBeGreaterThanOrEqual(4);
      expect(sentence, permission).not.toMatch(/[:_]/);
      expect(sentence, permission).not.toContain(permission);
    }
  });

  it('distinguishes a single member lookup from browsing the customer register', () => {
    expect(PERMISSION_WORDS['pos:member:read']).toMatch(/one member/i);
    expect(PERMISSION_WORDS['pos:member:list']).toMatch(/register.*phone numbers/i);
    expect(PERMISSION_WORDS['pos:booking:read']).toMatch(/families.*online booking/i);
    expect(PERMISSION_WORDS['pos:booking:redeem']).toMatch(/claim.*paid online booking/i);
  });

  it('keeps app entry, booth staffing and whole-operator recognition distinct from action grants', () => {
    const appEntries = PERMISSIONS.filter((permission) => permission.startsWith('app:'));
    for (const permission of appEntries) {
      expect(PERMISSION_WORDS[permission]).toMatch(/^Open .+actions.*own permissions/);
    }
    expect(PERMISSION_WORDS['booth:staff:sign_in']).toMatch(/also assigned as staff/);
    expect(PERMISSION_WORDS['admin:operator:all']).toMatch(/whole operator.*without adding other permissions/);
    expect(PERMISSION_WORDS['assistant:ask:use']).toMatch(/existing access allows/);
  });

  it('describes the menu workbook import without promising merchandise import', () => {
    expect(PERMISSION_WORDS['catalog:menu:import']).toMatch(/menu.*spreadsheet/i);
    expect(PERMISSION_WORDS['catalog:menu:import']).not.toMatch(/merchandise/i);
  });

  it('describes salary visibility without promising pay editing or payroll approval', () => {
    const sentence = PERMISSION_WORDS['hr:salary:view'];
    expect(sentence).toMatch(/view.*salary.*pay details.*OTO App/i);
    expect(sentence).toMatch(/platform access is enabled/i);
    expect(sentence).not.toMatch(/edit|approve|confirm|lock/i);
  });

  it('explains the sensitive, approval and payment distinctions in park terms', () => {
    const examples: [Permission, RegExp][] = [
      ['admin:audit:read_sensitive', /unmasked.*child health notes.*phone numbers/i],
      ['pos:payment:confirm', /unresolved.*terminal or gateway/i],
      ['pos:refund:approve', /refunds.*voids after payment/i],
      ['pos:cash:approve', /countersign.*paid-out.*safe drop.*variance/i],
      ['pos:cash:session_close', /close.*drawer session/i],
      ['pos:cash:day_close', /close.*trading day/i],
      ['pos:party:charge', /party.*tab/],
      ['pos:party:payment', /payment.*party.*balance/],
      ['pos:stock:receive', /deliveries.*stock/],
      ['pos:stock:order', /purchase orders/],
    ];
    for (const [permission, meaning] of examples) {
      expect(PERMISSION_WORDS[permission], permission).toMatch(meaning);
    }
  });
});
