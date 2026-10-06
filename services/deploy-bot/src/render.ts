import { z } from 'zod';

const API = 'https://api.render.com/v1';

const service = z.object({ id: z.string(), name: z.string() });
const serviceList = z.array(z.object({ service, cursor: z.string().optional() }));

const deploy = z.object({
  id: z.string(),
  commit: z
    .object({
      id: z.string(),
      message: z.string().nullish(),
      createdAt: z.string().nullish(),
    })
    .nullish(),
  status: z.string(),
  trigger: z.string().nullish(),
  finishedAt: z.string().nullish(),
});
const deployList = z.array(z.object({ deploy, cursor: z.string().optional() }));

export type RenderService = z.infer<typeof service>;
export type RenderDeploy = z.infer<typeof deploy>;

/**
 * A deploy that went live. `deactivated` is one that was live and has since
 * been replaced by a newer one — it still shipped.
 */
export const wentLive = (d: RenderDeploy) => d.status === 'live' || d.status === 'deactivated';

export interface RenderApi {
  listServices(): Promise<RenderService[]>;
  /** Every deploy of one service created after `createdAfter`, whatever became of it. */
  listDeploys(serviceId: string, createdAfter: Date): Promise<RenderDeploy[]>;
}

export function createRenderApi(apiKey: string): RenderApi {
  const get = async (path: string, params: Record<string, string>): Promise<unknown> => {
    const res = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Render API ${path} answered ${res.status}`);
    return res.json();
  };

  return {
    async listServices() {
      const all: RenderService[] = [];
      let cursor: string | undefined;
      // 100 per page; ten pages is far more services than this workspace has
      // and keeps a bad cursor from looping forever.
      for (let page = 0; page < 10; page += 1) {
        const items = serviceList.parse(
          await get('/services', {
            limit: '100',
            includePreviews: 'false',
            ...(cursor ? { cursor } : {}),
          }),
        );
        all.push(...items.map((i) => i.service));
        cursor = items.at(-1)?.cursor;
        if (items.length < 100 || !cursor) break;
      }
      return all;
    },

    async listDeploys(serviceId, createdAfter) {
      const items = deployList.parse(
        await get(`/services/${encodeURIComponent(serviceId)}/deploys`, {
          createdAfter: createdAfter.toISOString(),
          limit: '100',
        }),
      );
      return items.map((i) => i.deploy);
    },
  };
}
