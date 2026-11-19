// SCRUM-1016 — the OTO look's tokens, read from the stylesheet itself so a
// changed value is measured, never a hand-copied one: every token has a light
// and a dark value, every Tailwind colour names a token, every text pair the
// components use meets WCAG 4.5 : 1 in both themes, and the faces come from
// this build rather than an outside host.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (file: string) => readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');
const css = src('src/index.css');

function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`No ${selector} block`);
  const body = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--oto-([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const light = block(':root');
const dark = block('html.dark');

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255]
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
}
function contrast(theme: Record<string, string>, ink: string, ground: string): number {
  const a = theme[ink], b = theme[ground];
  if (!a?.startsWith('#') || !b?.startsWith('#')) throw new Error(`Not a hex token: ${ink} on ${ground}`);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Every text-on-ground pair the shell and the recoloured surfaces use. */
const TEXT_PAIRS: Array<[ink: string, ground: string]> = [
  ...['ground', 'card', 'wash', 'band', 'line'].flatMap((g): Array<[string, string]> => [['ink', g], ['ink-soft', g]]),
  ['ink-muted', 'ground'], ['ink-muted', 'card'], ['ink-muted', 'wash'], ['ink-muted', 'band'],
  ['on-ink', 'ink'], ['on-coral', 'coral'], ['on-staff', 'staff'],
  ['coral-ink', 'ground'], ['coral-ink', 'card'], ['coral-ink', 'band'],
  ['teal', 'mint'], ['money-ink', 'money'], ['money-ink', 'money-badge'], ['needs-ink', 'needs'],
  // The list (SCRUM-1016): a Ready to book row's name, time and quiet text on
  // its green ground, the group's count pill, and the contacts' faces.
  ['ink', 'money'], ['ink-soft', 'money'], ['money', 'money-ink'],
  ['face-violet-ink', 'face-violet'], ['face-sky-ink', 'face-sky'],
  // The chat (SCRUM-1016): the assistant's line and its Resume, its label and
  // "Correct the assistant" on the thread's ground, the open-question line;
  // a refusal's red; the paid deposit's card; the GM's inverted face.
  ['teal', 'mint-soft'], ['teal', 'card'], ['teal', 'ground'],
  ['danger-ink', 'danger'], ['money-ink', 'card'],
  ['ink-muted', 'money'], ['ink-soft', 'mint-soft'],
  // The dialogs and settings (SCRUM-1016): a choice waiting on a person (the
  // amber of Book the date's two readings, a draft, an approval to come) on
  // its ground and under its field; the filled red of a confirmation that
  // cannot be undone; a disabled main button's muted words on the band.
  ['ask-ink', 'ask'], ['ask-ink', 'ground'], ['ask-ink', 'card'], ['ink', 'ask'],
  ['danger', 'danger-ink'], ['ink-muted', 'band'],
  // A refusal said on the page itself (sign-in, the figures, the simulator).
  ['danger-ink', 'card'], ['danger-ink', 'ground'],
  // The chosen segment of a switch (SCRUM-1016 review): its words and the
  // tab's coral count.
  ['ink', 'segment'], ['coral-ink', 'segment'],
  // The view-as banner's words (SCRUM-648), on tokens since the review.
  ['banner-ink', 'banner'],
];

describe('SCRUM-1016: the OTO tokens', () => {
  it('names the same tokens in the light and the dark theme', () => {
    expect(Object.keys(light).length).toBeGreaterThan(20);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  it('holds the approved light values', () => {
    expect(light).toMatchObject({
      ground: '#fbf5ef', card: '#fefdfb', ink: '#3b281c', 'ink-muted': '#766456', 'ink-soft': '#5f4f43',
      line: '#eae0d7', 'line-soft': '#efe6dc', band: '#f1e9df',
      coral: '#ca3500', 'coral-ink': '#9f2d00', mint: '#d4edea', teal: '#234343',
      money: '#f1f7ee', 'money-line': '#c9e0c3', 'money-ink': '#1f4d2b', 'money-badge': '#d3ead0',
      needs: '#fde6da', 'needs-ink': '#8a2a05', staff: '#3b281c', 'on-staff': '#fbf5ef',
      'topic-birthdays': '#6d28d9', 'topic-general': '#0369a1', 'topic-marketing': '#be185d', 'topic-gm': '#b45309',
    });
    expect(dark).toMatchObject({
      ground: '#0f1729', card: '#141f38', line: '#24304a', 'line-soft': '#1c2740', ink: '#f1f5f9', 'ink-muted': '#a9b6ca',
      coral: '#ff9a70', 'coral-ink': '#ffb596',
    });
  });

  it('hands every colour token to Tailwind under its own name, and the shadow as one shadow', () => {
    const theme = css.slice(css.indexOf('@theme inline {'), css.indexOf('}', css.indexOf('@theme inline {')));
    const colours = [...theme.matchAll(/--color-([a-z-]+):\s*var\(--oto-([a-z-]+)\);/g)];
    expect(colours.map((m) => m[1])).toEqual(colours.map((m) => m[2]));
    expect(colours.map((m) => m[2]).sort()).toEqual(Object.keys(light).filter((k) => k !== 'shadow').sort());
    expect(theme).toContain('--shadow-pop: 0 12px 40px -16px var(--oto-shadow);');
  });

  it.each([['light', light], ['dark', dark]] as const)('every text pair meets 4.5 : 1 (%s)', (_, theme) => {
    for (const [ink, ground] of TEXT_PAIRS) {
      expect(contrast(theme, ink, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([['light', light], ['dark', dark]] as const)('the coral ring and focus outline stand out at 3 : 1 (%s)', (_, theme) => {
    // The pressed "Needs reply" figure's ring, and the app bar's focus outline.
    for (const ground of ['needs', 'ground', 'card']) {
      expect(contrast(theme, 'coral', ground), `coral against ${ground}`).toBeGreaterThanOrEqual(3);
    }
    // A list row's focus outline, on the row grounds (SCRUM-1016).
    for (const ground of ['band', 'wash', 'money']) {
      expect(contrast(theme, 'coral', ground), `coral against ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each([['light', light], ['dark', dark]] as const)('a field read two ways stands out by its amber edge at 3 : 1 (%s)', (_, theme) => {
    for (const ground of ['card', 'ground']) {
      expect(contrast(theme, 'ask-edge', ground), `ask-edge against ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the chosen segment of a switch stands up from its band in both themes, as Dark.dc.html draws it', () => {
    // SCRUM-1016 (review): in dark, the card (#141f38) is darker than the
    // band (#1f2b45), so a chosen tab on the card's ground read as sunken.
    expect(light.segment).toBe(light.card);
    expect(dark.segment).toBe('#2a3a5c');
    for (const theme of [light, dark]) {
      expect(luminance(theme.segment!)).toBeGreaterThan(luminance(theme.band!));
    }
    expect(src('src/components/Rail.tsx')).toContain("active ? 'bg-segment font-bold text-ink");
    expect(src('src/components/ui.ts')).toContain("export const SEGMENT_ON = 'bg-segment ");
  });

  // SCRUM-1043: an edge that marks a control (a field, a search box, a pill,
  // an outlined button, Resume on the assistant's line) reaches 3 : 1 against
  // every surface it sits on, by colour at 1 px. Before, a field's edge was
  // 1.44 : 1 on the card (1.63 in dark), an outlined button's 2.27 (2.41) and
  // Resume's 1.79. Card edges and dividers keep their drawn values; the
  // field's old shade lives on as `line-deep` for dashed frames that are not
  // controls.
  it('holds the control edges at the smallest step to 3 : 1, and the decorative lines as drawn', () => {
    expect(light).toMatchObject({ field: '#998879', edge: '#998879', 'mint-control': '#6b9690', 'line-deep': '#e0d3c6', 'mint-edge': '#9cc9c2' });
    expect(dark).toMatchObject({ field: '#5d6e90', edge: '#5d6e90', 'mint-control': '#3a7671', 'line-deep': '#34425f', 'mint-edge': '#2f6b66' });
    expect(dark).toMatchObject({ line: '#24304a', 'line-soft': '#1c2740', 'money-line': '#1f4030' });
    expect(light).toMatchObject({ line: '#eae0d7', 'line-soft': '#efe6dc', 'money-line': '#c9e0c3' });
  });

  it.each([['light', light], ['dark', dark]] as const)('every control edge stands out at 3 : 1 on the surfaces it sits on (%s)', (_, theme) => {
    // Fields, pills and the search sit on the card, the page's ground and the
    // template box's wash; Create BEO sits on the paid deposit's green too.
    for (const ground of ['card', 'ground', 'wash']) {
      expect(contrast(theme, 'field', ground), `field against ${ground}`).toBeGreaterThanOrEqual(3);
      expect(contrast(theme, 'edge', ground), `edge against ${ground}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(theme, 'edge', 'money'), 'edge against money').toBeGreaterThanOrEqual(3);
    // Resume and Pause: a card-coloured pill on the assistant's soft mint.
    for (const ground of ['mint-soft', 'card']) {
      expect(contrast(theme, 'mint-control', ground), `mint-control against ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('draws every control on a control edge, and only decoration on the drawn lines', () => {
    const ui = src('src/components/ui.ts');
    expect(ui).toMatch(/export const INPUT =\s*'[^']*border border-field /);
    expect(ui).toMatch(/export const BTN_OUTLINE = `[^`]*border border-edge /);
    expect(ui).toMatch(/export const BTN_SMALL = `[^`]*border border-edge /);
    expect(src('src/components/atoms.tsx')).toContain("PILL_OFF = 'border-field bg-card");
    expect(src('src/components/ChatActions.tsx')).toMatch(/SECONDARY_BUTTON =\s*'[^']*border border-edge /);
    const chat = src('src/components/ChatPanel.tsx');
    expect(chat).toContain('rounded-full border border-mint-control bg-card'); // Resume / Pause
    expect(chat).toContain('ring-1 ring-field hover:bg-wash'); // Earlier messages
    expect(chat).toContain('rounded-xl border border-edge bg-card px-3 py-2'); // the BEO's chip
    expect(src('src/components/MessageBubble.tsx')).toContain('ring-1 ring-edge hover:bg-wash'); // a file's Open
    // Decoration keeps its drawn shade: the withdrawn line, the refused hand-off's note.
    expect(src('src/components/MessageBubble.tsx')).toContain('border-dashed border-line-deep bg-ground');
    expect(src('src/components/SignOnPanels.tsx')).toContain('border-dashed border-line-deep');
  });

  // SCRUM-1045: the selected row's edge is a quiet 1 px of the muted ink.
  it.each([['light', light], ['dark', dark]] as const)('the selected row’s muted ink edge stands out at 3 : 1 (%s)', (_, theme) => {
    for (const ground of ['band', 'money']) {
      expect(contrast(theme, 'ink-muted', ground), `ink-muted edge against ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('no source file carries a raw palette class, a raw rgba colour or a dark: variant of its own', () => {
    // SCRUM-1016 (review): the view-as banner kept amber-400 and black, the
    // sign-in card the old slate rgba shadow. Every colour is a token now.
    const dir = path.resolve(import.meta.dirname, '..', 'src');
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(30);
    const palette =
      /(?:bg|text|border|ring|outline|fill|stroke|from|to|via|shadow|decoration|divide|accent|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d|\b(?:bg|text|border|ring)-(?:white|black)\b|rgba?\(|\bdark:/;
    for (const f of files) expect(readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(palette);
    expect(src('src/components/ImpersonationBanner.tsx')).toContain('border-banner-line bg-banner');
    expect(src('src/components/SignOnPanels.tsx')).toContain('shadow-pop');
  });

  it('paints the page on the token ground, with no slate gradient left', () => {
    expect(css).toMatch(/body\s*{[^}]*background: var\(--oto-ground\);/);
    expect(css).not.toContain('linear-gradient');
    expect(css).not.toContain('--color-slate');
  });
});

describe('SCRUM-1016: the faces come from this build', () => {
  const fonts = src('src/fonts.css');
  const html = src('index.html');

  it('loads no font from an outside host', () => {
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(fonts).not.toMatch(/https?:/);
  });

  it('declares Inter 400 to 800 for each subset, and the till’s Thai face from the printer fonts', () => {
    expect(fonts.match(/font-family: 'Inter';\s*font-style: normal;\s*font-weight: 400 800;/g)).toHaveLength(3);
    expect(fonts).toContain("url('../../../packages/print/fonts/NotoSansThai-Regular.ttf')");
    expect(fonts).toContain("url('../../../packages/print/fonts/NotoSansThai-Bold.ttf')");
    expect(css).toContain("--font-sans: 'Inter', 'Till Thai',");
    expect(src('src/main.tsx').indexOf("import './fonts.css'")).toBeLessThan(src('src/main.tsx').indexOf("import './index.css'"));
  });
});
