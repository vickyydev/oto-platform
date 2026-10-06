import { z } from 'zod';

/** S2-15a round 3: settlement is evidence about money already taken. */
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const UUID = z.string().uuid();

export const SettlementQuerySchema = z.object({ date: DATE });
export const TerminalSettlementRunBodySchema = z.object({ date: DATE, deviceId: UUID });
export const SettlementExportQuerySchema = SettlementQuerySchema.extend({ tid: z.string().trim().min(1).max(64).optional() });

export const TerminalSettlementLineSchema = z.object({
  method: z.enum(['card', 'qr']),
  amountSatang: z.number().int().positive(),
  terminalRef: z.string().trim().min(1).max(64).nullish(),
  tranRef: z.string().trim().min(1).max(128).nullish(),
  approvalCode: z.string().trim().min(1).max(32).nullish(),
});

/** The box reports only allowlisted transaction evidence, never card data or a raw frame. */
export const TerminalSettlementResultBodySchema = z.object({
  outcome: z.enum(['settled', 'unsupported', 'failed']),
  deviceId: UUID,
  tid: z.string().trim().min(1).max(64).nullish(),
  mid: z.string().trim().min(1).max(64).nullish(),
  batchRef: z.string().trim().min(1).max(128).nullish(),
  lines: z.array(TerminalSettlementLineSchema).max(10_000),
  errorCode: z.string().trim().min(1).max(64).nullish(),
}).superRefine((value, ctx) => {
  if (value.outcome !== 'settled' && value.lines.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'Only a settled batch can carry lines' });
  }
});

export const GatewaySettlementImportBodySchema = z.object({
  date: DATE,
  fileName: z.string().trim().min(1).max(200),
  csv: z.string().min(1).max(2_000_000),
});

export const SettlementMatchSchema = z.enum([
  'matched', 'unmatched', 'amount_mismatch', 'ambiguous', 'reference_mismatch',
]);
export const SettlementBatchStateSchema = z.enum(['pending', 'matched', 'attention', 'failed', 'unsupported']);

export const SettlementBatchViewSchema = z.object({
  id: UUID,
  source: z.enum(['terminal', '2c2p']),
  state: SettlementBatchStateSchema,
  deviceId: UUID.nullable(),
  tid: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  matched: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  mismatched: z.number().int().nonnegative(),
});

export const SettlementLineViewSchema = z.object({
  id: UUID,
  batchId: UUID,
  attemptId: UUID.nullable(),
  method: z.enum(['card', 'qr']),
  amountSatang: z.number().int().positive(),
  tid: z.string().nullable(),
  approvalCode: z.string().nullable(),
  terminalRef: z.string().nullable(),
  invoiceNo: z.string().nullable(),
  tranRef: z.string().nullable(),
  transactionType: z.string().nullable(),
  match: SettlementMatchSchema,
});

export const SettlementSummarySchema = z.object({
  branchId: UUID,
  date: DATE,
  devices: z.array(z.object({ id: UUID, label: z.string(), tid: z.string().nullable(), provider: z.enum(['digio', 'ghl', 'simulator']) })),
  batches: z.array(SettlementBatchViewSchema),
  lines: z.array(SettlementLineViewSchema),
  unmatchedAttempts: z.array(z.object({
    id: UUID,
    method: z.enum(['card', 'qr']),
    amountSatang: z.number().int().positive(),
    tid: z.string().nullable(),
    invoiceNo: z.string().nullable(),
    status: z.enum(['approved', 'awaiting_settlement']),
  })),
});

export const TerminalSettlementRunAnswerSchema = z.object({
  batchId: UUID,
  commandId: UUID,
  state: z.literal('pending'),
});

export const SettlementResultAnswerSchema = z.object({
  batchId: UUID,
  replayed: z.boolean(),
  state: SettlementBatchStateSchema,
  matched: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  mismatched: z.number().int().nonnegative(),
});

export type TerminalSettlementResultBody = z.infer<typeof TerminalSettlementResultBodySchema>;
export type SettlementSummary = z.infer<typeof SettlementSummarySchema>;
export type SettlementBatchState = z.infer<typeof SettlementBatchStateSchema>;
export type SettlementMatch = z.infer<typeof SettlementMatchSchema>;
