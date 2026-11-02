import { fileURLToPath } from 'node:url';
import { createPosServer } from './server.js';

const upstream = process.env.API_UPSTREAM;
if (!upstream) throw new Error('API_UPSTREAM is required');
const port = Number(process.env.PORT ?? 10000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port');
const server = createPosServer({ root: fileURLToPath(new URL('../../dist/public/', import.meta.url)), apiUpstream: upstream });
server.listen(port, '0.0.0.0', () => console.info(JSON.stringify({ event: 'pos.web.ready', port })));
process.once('SIGTERM', () => {
  server.close();
  // Let ordinary in-flight writes finish. End old streams within Render's
  // shutdown window; their existing client reconnect logic takes over.
  setTimeout(() => server.closeAllConnections(), 25_000).unref();
});
