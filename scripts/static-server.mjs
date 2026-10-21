import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

export function startStaticServer({ root, host = '127.0.0.1', port = 0, prefix = '/pdf-tools' }) {
  const rootDir = resolve(root);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname === prefix) {
        response.writeHead(308, { Location: `${prefix}/${url.search}` });
        response.end();
        return;
      }
      let pathname = url.pathname;
      if (pathname === `${prefix}/`) pathname = '/';
      else if (pathname.startsWith(`${prefix}/`)) pathname = pathname.slice(prefix.length);
      if (pathname === '/') pathname = '/index.html';
      const relative = pathname.replace(/^\/+/, '');
      if (relative.split(/[/\\]/).includes('..')) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      const file = resolve(rootDir, relative);
      if (file !== rootDir && !file.startsWith(rootDir + sep)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error?.code === 'ENOENT' ? 404 : 500);
      response.end(error?.code === 'ENOENT' ? 'Not found' : 'Error');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        host,
        port: address.port,
        prefix,
        url: `http://${host}:${address.port}${prefix}/`,
      });
    });
  });
}
