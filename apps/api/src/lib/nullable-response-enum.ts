import type { SwaggerTransform } from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

const targets = {
  drift: { url: '/console/analytics/drift', fields: [
    ['comparisons', 'items', 'reason'],
  ] },
  menu: { url: '/branches/:branchId/menu', fields: [
    ['categories', 'items', 'taxableCategory'], ['categories', 'items', 'defaultPrepStation'],
    ['categories', 'items', 'effectiveTaxCategory'], ['categories', 'items', 'effectivePrepStation'],
    ['products', 'items', 'prepStationOverride'], ['products', 'items', 'taxCategoryOverride'],
  ] },
  credentials: { url: '/branches/:branchId/credentials', fields: [
    ['credentials', 'items', 'lastRejectedCode'],
  ] },
} as const;

interface JsonSchema {
  type?: unknown;
  nullable?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

/** The installed converter omits null from these native nullable enums.
 * OpenAPI nullable does not extend enum. Correct only these response fields;
 * the original Zod schemas still validate and serialize every native reply.
 */
export function nullableResponseEnumTransform(target: keyof typeof targets): SwaggerTransform {
  return args => {
    const { url, fields } = targets[target];
    if (args.url !== url) throw new Error('Nullable response enum route mismatch');
    const result = jsonSchemaTransform(args);
    const responses = result.schema.response as Record<string, JsonSchema> | undefined;
    for (const path of fields) {
      let node = responses?.['200'];
      for (const part of path) node = part === 'items' ? node?.items : node?.properties?.[part];
      if (node?.type !== 'string' || node.nullable !== true || !Array.isArray(node.enum)
        || node.enum.length === 0 || node.enum.some(value => value !== null && typeof value !== 'string')) {
        throw new Error('Nullable response enum schema mismatch');
      }
      // Replace the generated array; never mutate a shared Zod enum's values.
      if (!node.enum.includes(null)) node.enum = [...node.enum, null];
    }
    return result;
  };
}
