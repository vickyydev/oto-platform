# Support refusal regression — 28 October 2026

Staging refused a Console-capable subject with HTTP403 but immediately removed
the explanation and entered account id. `refreshSession()` remounted the page.
The same unconditional refresh let a delayed action from an old session refresh
the replacement actor. Both findings are fixed in `Support.tsx`.

The built-browser review uses the real App and session lifecycle with local API
fixtures. On unchanged production source it reported two failures (missing
refusal; replacement actor received extra session reads) and one passing control
(successful start/end updates the banner). The same three tests pass after the
fix. No guards, API contracts or session-provider behavior changed.

- Baseline Support SHA256:94effb13e1bfc8a1f2f29beec13dc0a8e180b7a6e4c1b16a55119f851efc6927.
- Fixed Support SHA256:d5bd93cbfa8cf7b8167eba327103c0e4f006eb3f7f2e14d18c1d9c29062e584b.
- Unchanged regression SHA256:4040b313cc94ec16d5797d173ae3c6dc4132b7fc906251273ecdc4e14b40665a.
- Baseline terminal log SHA256:64f814809668a80e9594f5450b708337317255e9f1622cbcf14b148f06a4b299.
- Focused green log SHA256:a7f555c5cbc14a03399e413de60f2b92b4f725e5d0f4ba7c17560237b333f2e0.
- Full built-browser log SHA256:f77c57b976e34955a2a9ecfac3cf294ca168948fcf1dfe948a3794e8cb4f44c3.

Full local validation completed2026-10-28T13:44:54Z:327 browser cases passed;
490 Console unit cases passed with three existing TODOs; all three Console
compiler configurations and changed-file eslint passed. The private embedded
Postgres was stopped and its databases dropped. No Docker was started.

Harness history is retained under `C:/oto-lanes/proof-tools`: the first launch
had a Windows import-URL error; the next fixture lacked the existing page-entry
grant. Neither is counted as the defect reproduction. The corrected baseline
terminal says two failed/one passed, despite its enclosing process returning0.
The verification wrapper now requires a successful terminal test summary as
well as the process result, and preserves each attempt separately. These local
checks do not substitute for the post-deploy staging walkthrough.
