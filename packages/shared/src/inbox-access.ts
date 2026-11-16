import { z } from 'zod';
import { INBOX_CATEGORY_KEYS, InboxChannelSchema } from './inbox';

/** null keeps existing reach; [] deliberately allows none. Limits never add a grant. */
export const InboxAccessSelectionSchema = z.object({
  categories: z.array(z.enum(INBOX_CATEGORY_KEYS)).max(4).nullable(),
  channelAccountIds: z.array(z.string().uuid()).max(500).nullable(),
});
export type InboxAccessSelection = z.infer<typeof InboxAccessSelectionSchema>;
export const InboxAccessChangeSchema = InboxAccessSelectionSchema.extend({ expectedVersion: z.number().int().min(0).max(2147483646) });
export const InboxAccountAccessSchema = InboxAccessSelectionSchema.extend({
  accountId: z.string().uuid(), version: z.number().int().min(0), administrator: z.boolean(), canManage: z.boolean(),
  channels: z.array(z.object({ id: z.string().uuid(), channel: InboxChannelSchema, displayName: z.string().nullable(), branchId: z.string().uuid().nullable() })),
});
export const InboxAccessPreviewSchema = z.object({
  accountId: z.string().uuid(), version: z.number().int().min(0),
  before: InboxAccessSelectionSchema, after: InboxAccessSelectionSchema, changed: z.boolean(),
});
export type InboxAccountAccess = z.infer<typeof InboxAccountAccessSchema>;
export type InboxAccessChange = z.infer<typeof InboxAccessChangeSchema>;
export type InboxAccessPreview = z.infer<typeof InboxAccessPreviewSchema>;
