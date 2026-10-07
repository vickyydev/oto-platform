import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FnbOrder } from '@/types';
import { confirmationLedger } from '@/components/fnb/FnbConfirmation';

/**
 * SCRUM-443 + SCRUM-484 — RE-CHECK of fix lane F3, after its fix round.
 *
 * The layout was measured again in Chromium against the real components
 * (StationHeader, a copy of MobileShell's bar with its real children,
 * StepConfirmation and IssueVoucherRow, each beside origin/main's copy). This
 * runner has no layout engine, so what is pinned here is what those
 * measurements rest on:
 *
 *  1. THE CHIP'S SPLIT. The phone top bar keeps main's one 110px line because
 *     the two-line classes start at Tailwind's `md:` and the till shows the
 *     phone shell below `useIsMobile`'s 768px. Those are two numbers in two
 *     files; if either moves, a width appears where the phone bar gets the
 *     two-line chip again ("Oto / Play…").
 *  2. THE LEDGER LINE'S SOURCE. The screen writes `fnb_order` for the spend; the
 *     platform files a wallet spend under the sale's channel, and both F&B
 *     stations claim `fnb`. The line and the platform's row agree only while
 *     all three hold.
 *  3. WHO DRAWS THE SCREEN. `confirmationLedger` appends this order's spend to
 *     the tab's ledger, right only for a tab read before the spend. Only the two
 *     stations draw it today; a third caller (History re-opening an order with a
 *     fresh wallet read) would show the spend twice.
 *  4. ONE SPEND PER SALE. The screen adds ONE line for the order's credit; the
 *     platform writes one row per spend. The payment stage spends a sale's
 *     credit once (`creditSaleId !== sale.id`).
 */
const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), 'utf8');

describe('1 — the chip’s two-line classes start where the phone shell stops', () => {
  it('useIsMobile hands over at 768px', () => {
    expect(read('../src/hooks/use-mobile.tsx')).toMatch(/const MOBILE_BREAKPOINT = 768\b/);
  });

  it('Tailwind’s md: is 48rem (768px at the root size), and the till does not move it', () => {
    const theme = read('../node_modules/tailwindcss/theme.css');
    expect(theme).toMatch(/--breakpoint-md:\s*48rem;/);
    const css = read('../src/index.css') + read('../src/fonts.css');
    expect(css).not.toMatch(/--breakpoint-md/);
    // A root font size other than the browser's 16px would move 48rem off 768px.
    expect(css).not.toMatch(/html\s*\{[^}]*font-size/);
  });

  it('the chip uses md: and no other breakpoint for its name', () => {
    const source = read('../src/components/shared/BranchSwitcher.tsx');
    const classes = /const BRANCH_NAME_CLASS =\s*'([^']*)'/.exec(source)?.[1]?.split(/\s+/) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.filter((c) => c.includes(':')).every((c) => c.startsWith('md:'))).toBe(true);
    // Both name spans (switcher and single-park) use the one constant.
    expect(source.match(/className=\{BRANCH_NAME_CLASS\}/g)).toHaveLength(2);
  });
});

describe('2 — the ledger line names the source the platform writes for an F&B spend', () => {
  it('the platform files a spend from the fnb channel as fnb_order', () => {
    const sale = read('../../api/src/services/sale.ts');
    expect(sale).toMatch(/if \(row\.salesChannel === 'fnb'\) return 'fnb_order';/);
  });

  it('both F&B stations claim the fnb channel for their sale', () => {
    expect(read('../src/pages/OrderStation.tsx')).toMatch(/channel: 'fnb',/);
    expect(read('../src/components/mobile/order-station/MobileOrderStation.tsx')).toMatch(/channel: 'fnb',/);
  });

  it('the line the screen adds carries that source', () => {
    const order = {
      wristband: { id: 'w', code: 'QR-X', customerNickname: 'Mint', creditBalanceTHB: 350, gateAccess: false, ledger: [] },
      payment: { creditUsed: 60, cash: 0, card: 0, promptpay: 0 },
      operatorName: 'Som (Reception)',
      createdAt: '2026-10-07T10:15:00.000Z',
    } as unknown as FnbOrder;
    expect(confirmationLedger(order)).toEqual([
      { kind: 'spend', amountTHB: -60, source: 'fnb_order', at: '2026-10-07T10:15:00.000Z', by: 'Som (Reception)' },
    ]);
  });
});

describe('3 — only the two F&B stations draw the success screen', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });

  it('no other screen renders FnbConfirmation', () => {
    const callers = files(here('../src'))
      .filter((path) => /<FnbConfirmation\b/.test(readFileSync(path, 'utf8')))
      .map((path) => path.replace(/\\/g, '/').replace(/^.*\/src\//, ''))
      .sort();
    expect(callers).toEqual(['components/mobile/order-station/MobileOrderStation.tsx', 'pages/OrderStation.tsx']);
  });
});

describe('4 — a sale spends its credit once', () => {
  it('the payment stage takes credit only for a sale it has not spent on', () => {
    expect(read('../src/lib/usePaymentStage.ts')).toMatch(
      /if \(wallet\?\.useCredit && wallet\.key && stateRef\.current\.creditSaleId !== sale\.id && stateRef\.current\.outstandingSatang > 0\)/,
    );
  });
});
