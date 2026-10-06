import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Member } from '@/types';

// The unit runner has no React plugin, so the component's JSX compiles to the
// classic `React.createElement` and needs `React` in scope.
(globalThis as unknown as { React: typeof React }).React = React;
let StepCustomerType: typeof import('@/components/till/StepCustomerType').StepCustomerType;
beforeAll(async () => {
  ({ StepCustomerType } = await import('@/components/till/StepCustomerType'));
});

/**
 * SCRUM-494 unit "money" — gate: the member banner on the customer-type step
 * shows the re-verify flag only when a recorded expiry has passed, and keeps
 * the verified badge either way (the rate holds).
 */
const member = (reverifyDue: boolean): Member =>
  ({
    id: '018f0000-0000-7000-8000-000000000495',
    phone: '+66634940495',
    nickname: 'Gate',
    children: [],
    tierVerification: {
      tier: 'expat',
      proofType: 'Passport',
      verifiedBy: 'Reception',
      verifiedById: 'api',
      verifiedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-06-01',
      ...(reverifyDue ? { reverifyDue: true } : {}),
    },
  }) as unknown as Member;

const render = (m: Member) =>
  renderToStaticMarkup(
    React.createElement(StepCustomerType, { member: m, selectedTier: 'expat', onPickTier: () => {}, onRequestVerify: () => {} }),
  );

describe('s494 money gate — re-verify flag at the till', () => {
  it('shows the flag beside the verified badge when the document expiry has passed', () => {
    const html = render(member(true));
    expect(html).toContain('Document expired — re-verify');
    expect(html).toContain('· verified');
  });

  it('shows no flag while the document is in date', () => {
    const html = render(member(false));
    expect(html).not.toContain('re-verify');
    expect(html).toContain('· verified');
  });
});
