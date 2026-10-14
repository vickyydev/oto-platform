import { z } from 'zod';

/**
 * MONEY IS WHOLE SATANG, AT EVERY DOOR (SCRUM-271, SCRUM-294).
 *
 * Every money field on a wire is named for its unit and declared `.int()`. A
 * discount's or a promo's `value` cannot be: it is a percentage for `percent`
 * — which may be 12.5 — and satang for `fixed` (and, on a promo, for a free
 * item's price). So the whole-satang rule is checked on the types that carry
 * money, and a fraction of a satang is refused by name rather than rounded or
 * handed to an engine that works in integers.
 *
 * Three doors use it: the counter's `POST /sales` and `/sales/quote`, the
 * box's station bridge (a till selling through its box), and the cloud's sync
 * push (`sale.finalised` from a box that sold offline). The issue carries
 * `params.reason = FRACTIONAL_MONEY_REASON`, which is how the box and the sync
 * path name the refusal (`fractionalMoneyRefusal`) instead of filing it as an
 * unreadable payload.
 */
export const FRACTIONAL_MONEY_REASON = 'fractional_money';

export function wholeSatangWhenMoney(moneyTypes: readonly string[]) {
  return (discount: { type: string; value: number }, ctx: z.RefinementCtx): void => {
    if (moneyTypes.includes(discount.type) && !Number.isInteger(discount.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `A ${discount.type} discount's value is money, and money is whole satang`,
        params: { reason: FRACTIONAL_MONEY_REASON },
      });
    }
  };
}

/**
 * The sentence for a refusal, when `error` is a validation failure that
 * includes a fractional money amount; null for anything else.
 *
 * The sentence names the field's path and the rule, never the value: a sync
 * payload is somebody's sale, and what is wrong with it is the rule it broke.
 */
export function fractionalMoneyRefusal(error: unknown): string | null {
  if (!(error instanceof z.ZodError)) return null;
  const issue = error.issues.find(
    (i) =>
      i.code === z.ZodIssueCode.custom &&
      (i.params as { reason?: unknown } | undefined)?.reason === FRACTIONAL_MONEY_REASON,
  );
  if (!issue) return null;
  return `${issue.path.join('.')}: ${issue.message}. A fraction of a satang is refused, never rounded.`;
}
