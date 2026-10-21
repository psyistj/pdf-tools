import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || 4173);
const server = await startStaticServer({ root, port, prefix: '/pdf-tools' });
console.log(`PDF Tools  ${server.url}`);
console.log(`也可用根路径  http://${server.host}:${server.port}/`);
