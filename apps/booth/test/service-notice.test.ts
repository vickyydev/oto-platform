import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { BOOTH_ERROR_CODES } from '../src/booth/contract.ts';
import { kioskServiceNeed, type KioskState } from '../src/booth/kiosk.ts';
import { COPY, SERVICE_COPY, refusalLine } from '../src/copy.ts';

/**
 * SCRUM-403 — what the television says when the box's store cannot be used.
 *
 * It used to say nothing: the box exited before it served a page, and the
 * television showed Chromium's own error page, turned sideways. Now the box
 * serves the page and its state says it needs service, and the page shows a
 * full-screen notice — in both languages for the guest, with the way back for
 * staff, and nothing that identifies the box.
 *
 * The notice is the real component, rendered to markup. This runner strips
 * types and cannot load `.tsx`, so the hooks below compile a `.tsx` module
 * with the TypeScript this app already builds with, and give extensionless
 * relative imports the extension the source leaves off.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (relative && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const extension of ['.ts', '.tsx']) {
        try {
          return nextResolve(`${specifier}${extension}`, context);
        } catch {
          // Not this one; try the next, then let the resolver say why.
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    const file = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  },
});

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { NeedsServiceScreen } = await import('../src/components/KioskScreens.tsx');

function render(store: 'unreadable' | 'damaged'): string {
  return renderToStaticMarkup(createElement(NeedsServiceScreen, { store }));
}

/** The words a person reads: markup out, entities in. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const box: KioskState = {
  registered: true,
  online: true,
  booths: [],
  selectedStationId: null,
  agentVersion: '0.1.0',
};

test('the notice renders full screen, in both languages, with the way back', () => {
  for (const store of ['unreadable', 'damaged'] as const) {
    const html = render(store);
    const text = textOf(html);
    // The guest's line, English and Thai, under the wordmark.
    assert.ok(text.includes(SERVICE_COPY.guest.en), `${store}: the English line`);
    assert.ok(text.includes(SERVICE_COPY.guest.th), `${store}: the Thai line`);
    assert.match(html, /class="k-setup-line k-th"/, 'the Thai line in the Thai style');
    assert.match(html, /data-wordmark="oto"/, 'the booth it is, not an error page');
    assert.match(html, /class="k-body k-body--center"/);
    assert.match(html, /class="k-terms"/);

    // The staff panel: what is wrong, and the guide's recovery step.
    assert.match(html, /data-booth-panel="service"/);
    assert.ok(text.includes(SERVICE_COPY.title));
    assert.ok(text.includes(store === 'damaged' ? SERVICE_COPY.damaged : SERVICE_COPY.unreadable));
    assert.match(text, /Console → Devices → Add a box/);
    assert.match(text, /sudo oto-box claim --force/);
    assert.match(text, /type the new code at its prompt/);
    assert.match(text, /PI_BOOTH\.md, section 7/);
  }
  assert.notEqual(textOf(render('damaged')), textOf(render('unreadable')));
});

test('the notice shows no code and no credential', () => {
  for (const store of ['unreadable', 'damaged'] as const) {
    const text = textOf(render(store));
    // No claim code (the Console's are XXXXX-XXXXX), no six-digit pairing code.
    assert.doesNotMatch(text, /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/);
    assert.doesNotMatch(text, /\b\d{6}\b/);
    // No box id, no secret, no key, no file of the box's.
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    assert.doesNotMatch(text, /secret|password|private key|BEGIN|credential\.json|box\.sqlite|\/var\/lib/i);
    // And no field for one: the notice asks for nothing.
    assert.doesNotMatch(render(store), /<input|<form/);
  }
});

test('the box says it needs service: the page reads it, whatever else the state says', () => {
  assert.equal(kioskServiceNeed(null), null);
  assert.equal(kioskServiceNeed(box), null, 'an older box never sends the field');
  assert.equal(kioskServiceNeed({ ...box, service: null }), null);
  assert.deepEqual(kioskServiceNeed({ ...box, service: { store: 'damaged' } }), { store: 'damaged' });
  assert.deepEqual(kioskServiceNeed({ ...box, service: { store: 'unreadable' } }), {
    store: 'unreadable',
  });
  // A kind this page does not know is still a box that needs service.
  const odd = { ...box, service: { store: 'melted' } } as unknown as KioskState;
  assert.deepEqual(kioskServiceNeed(odd), { store: 'unreadable' });
});

test('a press refused with needs_service gets the notice’s line, not "Booth not ready"', () => {
  assert.ok((BOOTH_ERROR_CODES as readonly string[]).includes('needs_service'));
  for (const online of [true, false, null] as const) {
    assert.deepEqual(refusalLine('needs_service', online), SERVICE_COPY.guest);
    assert.notDeepEqual(refusalLine('needs_service', online), COPY.notReady);
  }
  assert.notEqual(SERVICE_COPY.guest.th.trim(), '', 'a Thai line as well, like every guest line');
});
