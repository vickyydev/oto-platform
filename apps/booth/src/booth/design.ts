/**
 * `layout.design` and `layout.assetManifest` — the two fields the frozen
 * bundle leaves as `unknown` and hands to whoever draws the wheel. That is
 * this app, so the shapes live here.
 *
 * **Nothing in this file throws and nothing refuses to render.** A design is
 * edited by an administrator and travels to a booth that may be a version
 * behind; a field nobody here recognises, a colour somebody typed wrong, a
 * manifest with a slot missing — each of those has to end in a wheel that
 * still turns, because the alternative is a dark television in a shopping
 * mall on a Saturday. Every reader below takes what it understands and falls
 * back for the rest.
 *
 * This is the same reason the bundle types them `unknown` in the first place,
 * so the leniency belongs here rather than in a zod schema that would reject
 * the whole document over one slice colour.
 */

/** The park's six brand colours, in the order the live wheel runs them. */
const DEFAULT_PALETTE = ['#FFE72E', '#FF7BC5', '#FF8A3D', '#55B9FF', '#A6E22C', '#CD8CFF'];
const DEFAULT_TEXT_COLOR = '#111111';
const DEFAULT_LABEL_MAX_LINES = 2;

/**
 * A colour, or null.
 *
 * CSS colours are a large grammar and this is a television, not a validator,
 * so the test is deliberately coarse: could this string be a colour. Two
 * different jobs rest on it, and the second is the reason it is exported.
 *
 *  1. Keeping a stray number or an empty string out of an SVG `fill`, where
 *     it would silently paint a slice black.
 *  2. **Keeping a quote out of one.** The wheel is built as SVG text and
 *     assigned with `innerHTML`, and a colour is interpolated into an
 *     attribute — so a `sliceColor` containing `" onload="` would not be a
 *     wrong colour, it would be markup. Labels are escaped on the way in;
 *     colours cannot be escaped without breaking `rgb(0, 0, 0)`, so they are
 *     rejected instead. Every pattern below excludes quotes, angle brackets
 *     and backslashes.
 *
 * It is called on the design's palette AND on each prize's own colours,
 * because both reach the same attribute and only one of them comes from a
 * field this file owns.
 */
export function readColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;
  if (/^[a-zA-Z]+$/.test(trimmed)) return trimmed; // `rebeccapurple`, `tomato`
  if (/^(rgb|hsl)a?\([^()]*\)$/.test(trimmed)) return trimmed;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export interface WheelDesign {
  /** Slice colours for prizes that carry none of their own. Never empty. */
  palette: string[];
  defaultTextColor: string;
  /** How many lines a slice label may wrap to before it is simply long. */
  labelMaxLines: number;
}

export function readDesign(raw: unknown): WheelDesign {
  const record = asRecord(raw);
  const palette = Array.isArray(record?.palette)
    ? record.palette.map(readColor).filter((c): c is string => c !== null)
    : [];
  const lines = record?.labelMaxLines;
  return {
    palette: palette.length > 0 ? palette : DEFAULT_PALETTE,
    defaultTextColor: readColor(record?.defaultTextColor) ?? DEFAULT_TEXT_COLOR,
    labelMaxLines:
      typeof lines === 'number' && Number.isInteger(lines) && lines >= 1 && lines <= 4
        ? lines
        : DEFAULT_LABEL_MAX_LINES,
  };
}

/**
 * One entry of the asset manifest.
 *
 * The manifest names what the wheel wants and where it is expected to come
 * from; it carries no bytes (D23). A slot nobody has filled is not an error —
 * it is the normal state of a booth that has been set up but not dressed, and
 * the fallback is what the wheel uses until somebody uploads something.
 *
 * `source: 'slot'` with no `url` and `source: 'bundled'` both mean the same
 * thing to this page today: there is nothing to fetch. They are kept distinct
 * because the difference matters to whoever fills the slots.
 */
export interface AssetSlot {
  name: string;
  source: 'slot' | 'bundled' | 'url';
  fallback: 'generated' | 'silent' | 'none';
  /** Only ever set by `source: 'url'`. Same-origin or absolute; not checked here. */
  url: string | null;
}

export interface AssetManifest {
  /** Keyed by slot name — `face`, `tick`, `win`, `thaiFont`, whatever a design adds. */
  slots: Record<string, AssetSlot>;
}

function readSlot(name: string, raw: unknown): AssetSlot | null {
  const record = asRecord(raw);
  if (!record) return null;
  const source = record.source;
  const fallback = record.fallback;
  const url = typeof record.url === 'string' && record.url.trim() !== '' ? record.url.trim() : null;
  return {
    name: typeof record.name === 'string' && record.name !== '' ? record.name : name,
    source: source === 'slot' || source === 'bundled' || source === 'url' ? source : 'slot',
    fallback:
      fallback === 'generated' || fallback === 'silent' || fallback === 'none' ? fallback : 'none',
    url,
  };
}

export function readAssetManifest(raw: unknown): AssetManifest {
  const record = asRecord(raw);
  const slots: Record<string, AssetSlot> = {};
  if (record) {
    for (const [key, value] of Object.entries(record)) {
      const slot = readSlot(key, value);
      if (slot) slots[key] = slot;
    }
  }
  return { slots };
}

/**
 * The URL to play or draw for a slot, or null when there is nothing there.
 *
 * Null is the expected answer for every slot in the seeded manifest, whose
 * sounds fall back to silence and whose wheel face falls back to the SVG this
 * app draws itself.
 */
export function assetUrl(manifest: AssetManifest, slotName: string): string | null {
  const slot = manifest.slots[slotName];
  if (!slot) return null;
  return slot.source === 'url' ? slot.url : null;
}
