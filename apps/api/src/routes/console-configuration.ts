import { z } from 'zod';
import type { App } from '../app';
import { consoleConfigurationOf } from '../services/console-configuration';

export const ConsoleConfigurationSchema = z.object({
  generatedAt: z.string().datetime(),
  operatorId: z.string().uuid(),
  branches: z.array(z.object({ id: z.string().uuid(), name: z.string() }).strict()),
  selectedBranchId: z.string().uuid().nullable(),
  entries: z.array(z.object({
    id: z.string().uuid(),
    key: z.string(),
    label: z.string(),
    appOwner: z.string(),
    editableHere: z.boolean(),
    requiredPermission: z.string(),
    url: z.string().nullable(),
    openInApp: z.object({ app: z.enum(['oto_app', 'radar', 'inbox']), path: z.string() }).strict().nullable(),
    supported: z.boolean(),
    scope: z.enum(['operator', 'branch']),
    branchIds: z.array(z.string().uuid()),
    lastChangedAt: z.string().datetime().nullable(),
    lastChangedAvailability: z.enum(['available', 'not-recorded', 'unsupported']),
  }).strict()),
}).strict();

export async function consoleConfigurationRoutes(app: App): Promise<void> {
  app.get('/console/configuration', {
    config: { dynamicPermission: true },
    schema: {
      description: 'Read the settings index: which settings exist, the app that owns each and the page that edits it, for the caller\'s operator. Requires console:config:read; each entry is listed only where the caller holds the owning page\'s own permission, with branch entries narrowed to the named park (branchId) or to the live parks the index reaches. A foreign, unknown or archived park is 404; an own park outside the index reach is 403. Navigation targets are fixed in code, never read from storage; unsupported entries carry no navigation or edit offer. Metadata only: no setting value is returned, and the read never seeds or writes the catalogue.',
      querystring: z.object({ branchId: z.string().uuid().optional() }).strict(),
      response: { 200: ConsoleConfigurationSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    const effective = await req.effectivePermissions();
    reply.header('cache-control', 'private, no-store');
    return consoleConfigurationOf(app.db, { operatorId: auth.operatorId, effective, branchId: req.query.branchId });
  });
}
