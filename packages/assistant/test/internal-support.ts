/**
 * Fixtures for the internal assistant's I1 checks. FICTIONAL TEST DATA (ZZ):
 * the tools, people and figures below exist only for these tests.
 */

import type { InternalAnswer } from '../src/internal-answer';
import type { InternalAsker, InternalLinkEntry } from '../src/internal-prompt';
import type { ToolCallRequest, ToolCallResult, ToolDefinition } from '../src/tool-loop';

export { SENTINEL } from './support';

export const NOW_I = new Date('2026-10-20T07:05:00Z');

export const LINKS: InternalLinkEntry[] = [
  {
    key: 'oto.timekeeping.employee',
    shows: "one person's clock review",
    params: ['employeeId', 'date'],
  },
  { key: 'console.activity', shows: 'the audit trail', params: [] },
  { key: 'oto.payroll.month', shows: 'one month-end', params: ['tab', 'month'] },
];

export const ASKER_A: InternalAsker = {
  name: 'ZZ Manager Nok',
  seatBranch: 'Central',
  tiles: ['pos', 'oto_app', 'console'],
};
export const ASKER_B: InternalAsker = {
  name: 'ZZ Reception Bee',
  seatBranch: 'Chalong',
  tiles: ['pos'],
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'occupancy.now',
    description: 'Children and adults inside a branch right now.',
    inputSchema: {
      type: 'object',
      properties: { branchId: { type: 'string' } },
      required: ['branchId'],
      additionalProperties: false,
    },
  },
  {
    name: 'branches.list',
    description: 'The branches the asker can see: id, name, code.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export function answer(overrides: Partial<InternalAnswer> = {}): InternalAnswer {
  return {
    answer: '23 children and 17 adults are inside Central now.',
    links: [],
    language: 'en',
    ...overrides,
  };
}

/** A scripted executor: answers by tool name, records every call. */
export function executor(table: Record<string, ToolCallResult>) {
  const seen: ToolCallRequest[] = [];
  const execute = async (call: ToolCallRequest): Promise<ToolCallResult> => {
    seen.push(call);
    const r = table[call.name];
    if (!r) throw new Error(`no fixture for ${call.name}`);
    return r;
  };
  return { execute, seen };
}

export const BRANCHES_OK: ToolCallResult = {
  ok: true,
  data: { branches: [{ id: 'br-central', name: 'Central', code: 'CEN' }] },
};
export const OCCUPANCY_OK: ToolCallResult = {
  ok: true,
  data: { branch: 'Central', inside: { children: 23, adults: 17 } },
};
export const OCCUPANCY_REFUSED: ToolCallResult = {
  ok: false,
  data: {
    status: 403,
    error: { code: 'FORBIDDEN', message: 'You hold pos:checkin:read, but not at Chalong' },
  },
};
