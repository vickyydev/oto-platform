import React, { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { ErrorNote, PermissionRequired, Unreadable } from '@/components/Panel';

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());
describe('SCRUM-682 native common error presentation', () => {
  it('hides unexpected diagnostics and exposes only a validated copyable reference', () => {
    const failure = Object.assign(new ApiError(500, 'INTERNAL', 'SQL SELECT private-canary from provider_secret', { password: 'private-canary' }), { requestId: 'zz-test-request-682' });
    const html = renderToStaticMarkup(createElement(ErrorNote, { message: failure.message, error: failure } as ComponentProps<typeof ErrorNote> & { error: unknown }));
    expect(html).not.toContain('private-canary');
    expect(html).not.toContain('SELECT');
    expect(html).toContain('zz-test-request-682');
    expect(html).toContain('Copy reference');
  });
  it('names the non-box resource and keeps an answered refusal distinct from no answer', () => {
    const html = renderToStaticMarkup(createElement(Unreadable, { what: 'The employee directory', message: 'Access to these employees was refused.' }));
    expect(html).toContain('The employee directory could not be read');
    expect(html).toContain('Access to these employees was refused.');
    expect(html).not.toContain('this box');
    expect(html).not.toContain('did not answer');
  });
  it('directs access requests to the current account and role pages', () => {
    const html = renderToStaticMarkup(createElement(PermissionRequired, { permission: 'admin:account:read' }));
    expect(html).toContain('Accounts');
    expect(html).toContain('Roles');
    expect(html).not.toContain('Login Users');
  });
  it('explains actual platform-wide authority instead of implying a park grant is enough', () => {
    const html = renderToStaticMarkup(createElement(PermissionRequired, { permission: 'admin:role:read', platformWide: true } as ComponentProps<typeof PermissionRequired> & { platformWide: boolean }));
    expect(html).toContain('platform-wide');
    expect(html).toContain('park');
    expect(html).not.toContain('A manager can grant');
  });
  it('retains an existing safe domain-specific reason', () => {
    expect(renderToStaticMarkup(createElement(ErrorNote, { message: 'No booth with that id' }))).toContain('No booth with that id');
  });
});
