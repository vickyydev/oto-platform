# Bundled fonts

Every file in this directory is licensed under the **SIL Open Font License,
Version 1.1**, whose full text is in `OFL.txt` beside them. OFL 1.1 permits
bundling and redistributing a font inside a larger work, requires the copyright
and licence notice to travel with the font files, forbids selling the fonts on
their own, and forbids using a Reserved Font Name on a modified version. This
file is the notice that travels with them.

| File | Upstream | Version / commit | Modified |
|---|---|---|---|
| `NotoSans-Regular.ttf` | https://github.com/notofonts/notofonts.github.io — `fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf` | `main`, fetched 2026-09-20 | no |
| `NotoSans-Bold.ttf` | same, `NotoSans-Bold.ttf` | `main`, fetched 2026-09-20 | no |
| `NotoSansThai-Regular.ttf` | same repository — `fonts/NotoSansThai/hinted/ttf/NotoSansThai-Regular.ttf` | `main`, fetched 2026-09-20 | no |
| `NotoSansThai-Bold.ttf` | same, `NotoSansThai-Bold.ttf` | `main`, fetched 2026-09-20 | no |
| `OtoPrintSC-Regular.ttf` | https://github.com/google/fonts — `ofl/notosanssc/NotoSansSC[wght].ttf` | `main`, fetched 2026-09-20 | **yes — see below** |
| `OFL.txt` | https://github.com/google/fonts — `ofl/notosansthai/OFL.txt` | — | no |

## Why the Chinese face is renamed

`OtoPrintSC-Regular.ttf` is **not** Noto Sans SC. It is derived from it by
`../scripts/subset-cjk.ts`, which does two things:

1. **Subsets** it to the few dozen code points the park actually prints — the
   full face is about 17 MB a weight and a thermal head needs a handful of
   Chinese words and the two star characters on the booth voucher.
2. **Instances** it at weight 400. The upstream file is variable and its
   *default* instance is wght 100, so its `glyf` outlines are Thin; Thin
   Chinese at 22 dots on a 203 dpi head comes out faint and broken next to the
   Latin and Thai beside it. The subsetter applies the `gvar` deltas for
   wght 400 and writes real Regular outlines.

Both of those are modification, and "Noto" is a Reserved Font Name under
OFL 1.1 §5, so the result may not carry it. Hence `OtoPrintSC`. The rename is
an obligation, not a preference.

## What happens to a character no bundled face covers

It is **drawn as a hollow box** and named in the job's `overflow`. It is not an
error and it never stops the job.

That matters because the Chinese face is a 39-character subset and a member
nickname is free text. `王小明` is an ordinary name in Phuket and only `小` is in
the subset, so a receipt for that member prints `□小□` with the note:

```
no bundled font covers U+738B 王, U+660E 明 in "Member: 王小明"; printed as
boxes. Widen the repertoire in scripts/subset-cjk.ts if this is common
```

A box was chosen over the alternatives deliberately:

- **Dropping the run** would print "Member:" and nothing after it, with no sign
  that a name was lost — a silent wrong receipt rather than a visibly partial
  one.
- **Transliterating** would need a pinyin or romanisation table per script, and
  it invents content the park never entered.
- **Throwing** is what this used to do, and it meant the first Chinese name a
  visitor typed stopped the till mid-sale.

The note is not decoration: whatever queues the job is expected to record it
(the `print_job` row and the Box log drawer), because a receipt quietly missing
a guest's name is its own failure. `test/fonts.test.ts` covers Chinese, Korean,
kana, a symbol and an unassigned code point, and `test/fixtures.test.ts` asserts
that none of the nine printouts prints a box with its normal data.

## Widening the Chinese repertoire

Edit `REPERTOIRE` in `../scripts/subset-cjk.ts` and re-run it against an
upstream copy of `NotoSansSC[wght].ttf`:

```
node --experimental-transform-types scripts/subset-cjk.ts /path/to/NotoSansSC[wght].ttf
```

Nothing else in the package knows which glyphs are in the file.

**The 39-character subset is very probably the wrong trade.** It was sized for
a bundle, and the thing it is bundled into is a Raspberry Pi with a disk. The
park is in Phuket, Chinese-reading visitors are a daily occurrence, and member
nicknames are free text, so the subset's failure mode — boxes in a guest's own
name on their receipt — is a routine event rather than an edge case. A face
covering GB/T 2312 level 1 (3,755 hanzi, which is effectively all modern
personal and place names) instanced at wght 400 is on the order of 2-4 MB; the
full face is about 17 MB. Either is nothing next to the Pi's storage and neither
is loaded by a browser, because this package never runs in one. The cost is
build time and repository size, not runtime. See `../README.md`.

## What is deliberately not bundled

- **Noto Sans Symbols**, which is where U+26A0 WARNING SIGN lives. The allergy
  triangle is drawn as vectors instead (`src/raster/fill.ts`): three polygons
  render crisply at 25 dots where a symbol-font glyph does not, and it keeps a
  fourth font out of the bundle.
- **Sarabun** and **IBM Plex Sans Thai**. Both are OFL and both are Thai plus
  Latin only — no CJK, no Cyrillic — so neither replaces anything here.
- A bold weight of the Chinese face. Bold Chinese falls back to
  `OtoPrintSC-Regular.ttf` rather than carrying a second 17 MB source through
  the build. If the park starts printing Chinese headings, instance a second
  weight and add it to the `bold` chain in `src/fonts/stack.ts`.
