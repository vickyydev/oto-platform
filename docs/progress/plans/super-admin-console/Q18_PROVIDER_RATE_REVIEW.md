# Q18 / Q21 initial provider-rate research

Checked on 26 October 2026 for the planner's SCRUM-638 delivery. This is a
public-price research note, not an approved rate configuration or a staging
write. The planner still supplies the initial rate versions at combined
landing under Q18/Q21.

Both `INTERNAL_AI_MODEL` and `INBOX_AI_MODEL` default to
`claude-opus-5-5` in `apps/api/src/env.ts`. The current source does not
establish which model overrides or provider endpoint staging uses.

The provider's current model page and full price list agree on these
standard Claude API rates for that model:

| Setting field | USD per million tokens |
| --- | ---: |
| `inputUsdPerMillion` | 4 |
| `outputUsdPerMillion` | 20 |
| `cacheReadUsdPerMillion` | 0.20 |

Sources checked directly:

- [Claude Opus 5.5 model pricing](https://platform.claude.com/docs/en/models/opus-5-5/overview#pricing)
- [Claude API price list](https://platform.claude.com/docs/en/about-claude/pricing#model-pricing)

These are standard online rates. Batch, fast-mode and inference-geography
modifiers have separate pricing; this research does not establish that any
modifier applies to the deployed runtime. The estimate continues to exclude
cache writes, as Q18 requires, because their counters are not persisted.

Planner delivery still needed: confirm the active model identifiers and
applicable price basis, then supply the initial versions with their UTC
`effectiveFrom` values. No effective time or historical price is inferred
here. Other models remain unpriced until a matching effective version is
provided. The seed remains empty, and this note makes no provider request,
changes no cap and saves no setting.

## Planner delivery (2026-10-26) — the initial rate version, approved

Independently re-verified by the planner on 26 October 2026 against the live
price list (platform.claude.com/docs/en/about-claude/pricing): Claude Opus 5.5
is $4 base input, $20 output and $0.20 cache hits per million tokens
(0.05x input). Staging's api sets neither `INTERNAL_AI_MODEL` nor
`INBOX_AI_MODEL`, so both engines run the source default `claude-opus-5-5`.
Neither engine requests fast mode or US-only inference (`packages/assistant`
sends no speed, inference_geo or service tier), so the standard rates apply
with no multiplier.

Both engines were created defaulting to that model on 2026-10-20 (commits
9f49b4d5 and 4923234d), so the version is effective from that day: every ask
or turn this deployment has recorded under the model is priced, and nothing
under any other model is. Saved rate history is immutable and a later version
can never start earlier, which is why the date is anchored to the model's
first use here rather than to today.

The one version to save for the OTO operator:

```json
{
  "model": "claude-opus-5-5",
  "effectiveFrom": "2026-10-20T00:00:00.000Z",
  "inputUsdPerMillion": 4,
  "outputUsdPerMillion": 20,
  "cacheReadUsdPerMillion": 0.2
}
```

How it lands: the seed stays empty (Q18). The 638 lane enters this version
through the native Assistant settings screen on staging as part of its
post-deploy proof — an ordinary audited, revisioned save the owner can see and
extend later — not through a migration, seed or direct database write. The
figure is shown as an estimate in USD excluding cache writes; other models
stay in `unpricedTokens` until someone adds a version for them. If staging
later sets a different model id, that model needs its own version.
