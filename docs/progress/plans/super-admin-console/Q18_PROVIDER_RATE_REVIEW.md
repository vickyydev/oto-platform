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
