import { z } from 'zod';
import {
  GatewaySettlementImportBodySchema, SettlementExportQuerySchema, SettlementQuerySchema,
  SettlementResultAnswerSchema, SettlementSummarySchema, TerminalSettlementResultBodySchema,
  TerminalSettlementRunAnswerSchema, TerminalSettlementRunBodySchema,
  newId,
} from '@oto/shared';
import type { App } from '../app';
import { boxAuthOf } from '../plugins/credential';
import {
  import2c2pFixture, recordTerminalSettlement, settlementExport, settlementSummary, startTerminalSettlement,
} from '../services/settlement';
import { opCtx, withTx } from '../services/tx';

const Branch = z.object({ branchId: z.string().uuid() });
const Batch = z.object({ batchId: z.string().uuid() });

/** S2-15a round 3. Branch permission on reads and manager permission on writes. */
export async function settlementRoutes(app: App): Promise<void> {
  app.get('/branches/:branchId/settlements', {
    config: { permission: 'pos:cash:read', target: { branchId: 'params.branchId' } },
    schema: { params: Branch, querystring: SettlementQuerySchema,
      response: { 200: SettlementSummarySchema } },
  }, async (req) => {
    const auth = req.requireAuth();
    return settlementSummary(app.db, auth.operatorId, req.params.branchId, req.query.date);
  });

  app.post('/branches/:branchId/settlements/terminal-runs', {
    config: { permission: 'pos:payment:settle', target: { branchId: 'params.branchId' } },
    schema: { params: Branch, body: TerminalSettlementRunBodySchema,
      response: { 200: TerminalSettlementRunAnswerSchema } },
  }, async (req) => {
    const auth = req.requireAuth();
    return withTx(app.db, opCtx(req), 'settlement.run', (tx) => startTerminalSettlement(tx, {
      operatorId: auth.operatorId, branchId: req.params.branchId, date: req.body.date,
      deviceId: req.body.deviceId, accountId: auth.accountId,
      sourceKey: req.idempotency?.key ?? newId(), requestId: req.id,
    }));
  });

  app.post('/settlements/batches/:batchId/terminal-result', {
    config: { credential: 'box' },
    bodyLimit: 16_000_000,
    schema: { params: Batch, body: TerminalSettlementResultBodySchema,
      response: { 200: SettlementResultAnswerSchema } },
  }, async (req) => {
    const auth = boxAuthOf(req);
    return withTx(app.db, { ...opCtx(req), actorAccountId: null, operatorId: auth.operatorId,
      branchId: auth.branchId }, 'settlement.result', (tx) =>
      recordTerminalSettlement(tx, auth, req.params.batchId, req.body, req.id));
  });

  app.get('/branches/:branchId/settlements/export', {
    config: { permission: 'pos:cash:read', target: { branchId: 'params.branchId' } },
    schema: { params: Branch, querystring: SettlementExportQuerySchema },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    const result = await settlementExport(app.db, auth.operatorId, req.params.branchId,
      req.query.date, req.query.tid);
    return reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${result.filename}"`).send(result.csv);
  });

  app.post('/branches/:branchId/settlements/2c2p-import', {
    config: { permission: 'pos:payment:settle', target: { branchId: 'params.branchId' } },
    bodyLimit: 4_000_000,
    schema: { params: Branch, body: GatewaySettlementImportBodySchema,
      response: { 200: SettlementResultAnswerSchema } },
  }, async (req) => {
    const auth = req.requireAuth();
    return withTx(app.db, opCtx(req), 'settlement.run', (tx) => import2c2pFixture(tx, {
      operatorId: auth.operatorId, branchId: req.params.branchId, date: req.body.date,
      fileName: req.body.fileName, csv: req.body.csv, accountId: auth.accountId,
      requestId: req.id,
    }));
  });
}
