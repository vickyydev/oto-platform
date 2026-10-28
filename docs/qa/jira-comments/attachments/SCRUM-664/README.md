# SCRUM-664 locale proof — 28 October 2026

`SCRUM-664-04-end-of-day-de-DE.png` is an inspected native staging screen.
The browser uses de-DE (default example:1.234,56), while the actual opening
float of600000 satang displays as ฿6,000. Eight expected channel amounts
matched their native zero values. No amount was fabricated or typed.

The API and POS stayed live on23d4cd552aa0c9c4de1d28fc7e21e6496bab8405
before and after the capture at13:41:42Z. That source includes the locale fix
78fa8542e8c5c50c4c1ff2aad19dee30f4d18102. Only the test's own Reception Till1
session was selected. No business, payment, settlement or hardware action
was performed. Sign-out returned200 and the revoked session returned401.

The final v4 receipt and review bind the screenshot, source, locale and
canonical amounts. Earlier helper attempts are retained honestly: a deploy
transition, a station-list shape assumption and a currency-literal encoding
error. They are not product failures or acceptance evidence. Settlement was
still loading in the screenshot; no settlement result or nonzero fractional
amount is claimed. The money table and float are unobscured.
