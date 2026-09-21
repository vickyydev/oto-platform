# `@oto/print`

Template → layout model → ESC/POS or TSPL2 bytes, plus a PNG of the same dots.

The pure part of the print pipeline: no socket, no clock, no network. The
adapters that open TCP 9100, the `print_job` table, the simulators, the admin
panel and the retry queue are the rest of S2-06 and live outside this package.

This file records the constraints this package imposes on everything that will
be wired to it, because they are not visible from its API.

## It runs on Node. It cannot run in a browser.

Three Node built-ins are reachable from `src/index.ts`:

| Module | Where | Why |
|---|---|---|
| `node:fs`, `node:url` | `src/fonts/stack.ts` | reads the bundled `.ttf` faces at runtime |
| `node:zlib` | `src/emit/preview.ts` | compresses the preview PNG's IDAT |

So **the admin console cannot import this package**, and the Print Templates
panel cannot render a preview itself. `src/emit/preview.ts` says the admin panel
and the simulator "both display this output" and "do not re-draw anything";
that is true, and the way it is true is that the PNG is produced server-side
and fetched:

```
console  ──GET preview──▶  api  ──renderPreviewPng()──▶  PNG bytes  ──▶  <img>
```

The same holds for the test print: the plan's "uses the same renderer as the
preview" is satisfied by both going through this package on the API or the box,
never by a second implementation in the browser. Any future in-browser preview
would be a second drawing path and would fail
`test/single-renderer.test.ts` — which is the point of that test.

If an in-browser build is ever genuinely wanted, the two dependencies have
different costs: `node:zlib` is replaceable (a stored-DEFLATE PNG writer, at
roughly 15x the bytes, or a canvas), but the font loading is not — the faces
would have to be fetched and handed in, which changes the package's API.

## The box agent's build must carry `fonts/`

`src/fonts/stack.ts` resolves `../../fonts/` from `import.meta.url` and reads
the files with `readFileSync`. Nothing imports them, so no bundler will follow
them.

A bundled box agent must therefore copy `packages/print/fonts/` next to its
output and preserve the relative path `<bundle>/../../fonts/`, or the loader
must be pointed at them another way. This fails **silently**: `load()` treats a
missing face as optional so that the shaper can report the uncovered code point
instead of throwing at import time, which means a build with no fonts at all
prints every character as a box rather than crashing. Worth a smoke test in
whatever produces the agent bundle.

## What is reproducible and what is not

- **Reproducible, and the contract:** the device bytes. Same input, same
  `.bin`, on a Pi in the park and on a cloud instance. The committed
  `test/fixtures/*.bin` are compared byte for byte.
- **Reproducible:** the layout model and the rendered dots. Committed as
  `*.layout.json` and compared as text; the bitmap is compared through the PNG.
- **Not reproducible, and not a contract:** the preview PNG's *compressed
  bytes*. DEFLATE output is not byte-specified and Node has shipped different
  zlib builds, so the same bitmap can produce two valid PNGs on two machines.
  `test/fixtures.test.ts` decodes the committed PNG and compares **pixels**.

Wrapping is rule-based rather than ICU-based for the same reason: ICU's Thai
dictionary differs between Node builds, so `useIcuLineBreaking` exists but is
off by default. See `src/layout/wrap.ts`.

## Nothing stops a job

Every degradation is reported, never thrown:

| Situation | What prints | What `overflow` says |
|---|---|---|
| A character no bundled face covers | a hollow box | the code points and the string |
| Text with no break opportunity in a column too narrow | split by measured character | the value, the width, the line count |
| A line wider than its column | as laid out | its measured width |
| A band taller than the stock | as laid out | the height and the stock's |
| A QR too big for the media | shrunk to whole dots per module | the module size it dropped to |

`RenderedJob.overflow` is a `string[]` meant for a human. The caller is expected
to surface it — the `print_job` row and the Box log drawer are the two places in
S2-06 that should carry it. A receipt quietly missing a guest's name is its own
kind of failure, so "the job rendered" is not the same as "the job is fine".

## Nine printouts, six editable templates

`PrintKind` has nine values; the prototype's `PrintTemplateType` has six. The
three without an editable template of their own are `item_voucher` (it borrows
the `credit_voucher` template and honours only its `creditVoucherQr` toggle,
per `printRouting.tsx:125-141`), `booth_voucher` (fixed by DEVICE_INVENTORY §7)
and `test_page` (deliberately never editable — its job is to prove the
renderer, and an editable test page can be edited into passing). See
`src/templates/model.ts`. Whether the first two should get real template types
is a decision for the owner, not for this package.

## Regenerating fixtures

```
pnpm --filter @oto/print fixtures
pnpm --filter @oto/print test
```

Read the diff. A fixture that moved by a dot is usually a metric change worth
understanding; one that moved by a hundred is a mistake.

## Two subpath exports out of `test/`, and why they are not a mistake

```json
"./reader":   "./test/escpos-reader.ts"
"./fixtures": "./test/fixtures.ts"
```

Both are consumed by the box agent's print pipeline (S2-06), and both are
deliberate rather than convenient.

`./reader` is the ESC/POS and TSPL parser this package's own `emit.test.ts`
uses to prove the emitted bytes carry the rendered dots and nothing else. Its
header already says it "is the shape the S2-06 printer simulator's parser
needs, so it is written to be lifted". The printer simulator lifts it. A second
parser written beside it would be a second opinion about what our own bytes
mean, and the first time the two disagreed the simulator would be the one
believed — because it is the one somebody is looking at.

`./fixtures` is the nine sample jobs, each carrying the two strings S2-06's
acceptance criterion names. **A test print's content is fixture content**: it
exists to prove the renderer, the transport and the paper path, and it says
nothing about a sale. Rendering it from these means the picture on the Print
Templates panel, the bytes on the wire and the committed fixture are one input.

Neither export is reachable from `src/index.ts`, so nothing in the ordinary
render path depends on the test tree.
