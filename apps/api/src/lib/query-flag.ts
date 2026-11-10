import { z } from 'zod';

/**
 * A yes/no flag in a query string, read the way a caller means it:
 * `?flag=true` or `?flag=1` is yes; `?flag=false`, `?flag=0`, an empty
 * value or no value at all is no. `z.coerce.boolean()` reads every present
 * string as yes, so `?includeBeoOnly=false` returned the BEO-only items
 * (found on staging, SCRUM-828). The OpenAPI shape stays a boolean, so the
 * generated clients keep their types.
 */
export const queryFlag = () =>
  z.preprocess(
    (value) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.trim().toLowerCase()) : value === true),
    z.boolean(),
  );
