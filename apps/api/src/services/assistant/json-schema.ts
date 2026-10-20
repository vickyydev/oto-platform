import { z } from 'zod';

/**
 * A tool's input schema as the model reads it (SCRUM-591, round I2; plan §B.4).
 *
 * The registry's inputs are zod (v3) schemas in `@oto/shared`. The Messages
 * API wants JSON Schema. This converts the small subset the registry uses —
 * strict objects of strings (min, max, uuid, regex, datetime), integers
 * (min, max), enums, arrays of those, and optionals — and THROWS on anything
 * else, so a tool whose input grew a shape this does not know fails the
 * build's census (`assistant-engine.test.ts`) rather than reaching the model
 * as a looser schema than the one the server validates with.
 *
 * The model's arguments are validated against the zod schema itself before
 * any call (`tools.ts`); this is only what it is TOLD.
 */

export type JsonSchema = Record<string, unknown>;

function stringSchema(s: z.ZodString): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  for (const check of s._def.checks) {
    switch (check.kind) {
      case 'min':
        out.minLength = check.value;
        break;
      case 'max':
        out.maxLength = check.value;
        break;
      case 'uuid':
        out.format = 'uuid';
        break;
      case 'datetime':
        out.format = 'date-time';
        break;
      case 'regex':
        out.pattern = check.regex.source;
        break;
      case 'trim':
        break;
      default:
        throw new TypeError(`assistant tool schema: a string check "${check.kind}" is not supported`);
    }
  }
  return out;
}

function numberSchema(n: z.ZodNumber): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  for (const check of n._def.checks) {
    switch (check.kind) {
      case 'int':
        out.type = 'integer';
        break;
      case 'min':
        out[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
        break;
      case 'max':
        out[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
        break;
      default:
        throw new TypeError(`assistant tool schema: a number check "${check.kind}" is not supported`);
    }
  }
  return out;
}

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      if (value instanceof z.ZodOptional) {
        properties[key] = toJsonSchema(value.unwrap() as z.ZodTypeAny);
      } else {
        properties[key] = toJsonSchema(value);
        required.push(key);
      }
    }
    if (schema._def.unknownKeys !== 'strict') {
      throw new TypeError('assistant tool schema: every object is strict (no unknown keys reach a path)');
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }
  if (schema instanceof z.ZodString) return stringSchema(schema);
  if (schema instanceof z.ZodNumber) return numberSchema(schema);
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...(schema.options as string[])] };
  if (schema instanceof z.ZodArray) {
    const out: JsonSchema = { type: 'array', items: toJsonSchema(schema.element as z.ZodTypeAny) };
    if (schema._def.minLength) out.minItems = schema._def.minLength.value;
    if (schema._def.maxLength) out.maxItems = schema._def.maxLength.value;
    return out;
  }
  if (schema instanceof z.ZodOptional) return toJsonSchema(schema.unwrap() as z.ZodTypeAny);
  throw new TypeError(`assistant tool schema: ${schema.constructor.name} is not supported`);
}
