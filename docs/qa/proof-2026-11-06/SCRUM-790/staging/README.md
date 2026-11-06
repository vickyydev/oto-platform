# SCRUM-790 staging proof: the wristband box opens the tab itself

Run on 6 November 2026, 15:56 Bangkok, on staging at commit
`bcdd042a393aff405505024c0785ea1e6436db91` (oto-pos-web-staging and
oto-pos-staging both live on it), in Edge, signed in as the staging reception
account on a throwaway till, "ZZ TEST SCRUM-790 till 2", on Virtual box 1 at
Central Floresta. The code entered is the ZZ TEST wristband `Z762-SGEP2S`.
Every step is a read-only lookup: nothing was sold, printed or paid.

| Step | What was done | What happened |
|---|---|---|
| 1 | The code pasted into the wristband box at F&B | One lookup, the tab opened with no Enter and no Load Tab (`s790-st-02`) |
| 2 | The code typed at a scanner's pace (15 ms a key), no Enter | One lookup, the tab opened (`s790-st-03`) |
| 3 | The same, with Enter after it | The tab opened on exactly one lookup |
| 4 | The code typed by hand (140 ms a key) | No lookup, the code stayed in the box (`s790-st-04`); Enter then opened the tab |

`receipt.json` holds each step's lookups and the clean-up. `proof.mjs.txt` is
the script that ran it.

## Clean-up

The till was archived through its own route and read back as archived. A first
run stopped at the script's own sign-in step, before the wristband box, and
archived its till ("ZZ TEST SCRUM-790 till") the same way.

## Not proved

The real scanner on the iPad. The script types at a scanner's pace in a desktop
browser; the scanner itself is tried at the counter.
