import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { lookup as mimeLookup } from 'mime-types';

export interface StaticServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Minimal static file server for the verifier's own use — the README documents the real, user-facing options. */
export async function startStaticServer(rootDir: string): Promise<StaticServerHandle> {
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response, rootDir);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  rootDir: string,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://internal.invalid');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('..')) {
      response.writeHead(400).end('Bad request');
      return;
    }

    let filePath = join(rootDir, pathname);
    let fileStat = await stat(filePath).catch(() => null);
    if (fileStat?.isDirectory()) {
      filePath = join(filePath, 'index.html');
      fileStat = await stat(filePath).catch(() => null);
    }
    if (!fileStat) {
      response.writeHead(404).end('Not found');
      return;
    }

    const contentType = mimeLookup(extname(filePath)) || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(await readFile(filePath));
  } catch {
    response.writeHead(500).end('Internal error');
  }
}
