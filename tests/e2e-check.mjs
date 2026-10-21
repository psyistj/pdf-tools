import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../scripts/static-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(root, 'tests', 'fixtures', 'two-pages.pdf');
const chromeBin = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const failures = [];
const consoleErrors = [];
const pageErrors = [];

function fail(message) {
  failures.push(message);
}

async function main() {
  const server = await startStaticServer({ root, port: 0, prefix: '/pdf-tools' });
  const userData = await mkdtemp(join(tmpdir(), 'pdf-tools-e2e-'));
  const target = `${server.url}?e2e=1`;
  const chrome = spawn(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--allow-insecure-localhost',
    `--user-data-dir=${userData}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let chromeLog = '';
  const debugPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome 未开放调试端口\n${chromeLog}`)), 12000);
    const onData = (chunk) => {
      chromeLog += chunk.toString();
      const match = chromeLog.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    chrome.stdout.on('data', onData);
    chrome.stderr.on('data', onData);
    chrome.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome 退出 ${code}\n${chromeLog}`));
    });
  });

  let socket;
  try {
    const listed = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' });
    const page = listed.ok ? await listed.json() : null;
    const pageUrl = page?.webSocketDebuggerUrl || await findPage(debugPort, target);
    socket = new WebSocket(pageUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('无法连接 Chrome 调试端口')), { once: true });
    });
    const client = new Cdp(socket);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('DOM.enable');
    await client.send('Network.enable');
    await client.send('Log.enable');
    client.on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || 'exception');
    });
    client.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        const text = (params.args || []).map((arg) => arg.value || arg.description || '').join(' ');
        consoleErrors.push(text || 'console.error');
      }
    });
    client.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error') consoleErrors.push(params.entry.text || 'log error');
    });
    const badResponses = [];
    client.on('Network.responseReceived', (params) => {
      const url = params.response?.url || '';
      if (params.response?.status >= 400 && !url.startsWith('data:')) badResponses.push(`${params.response.status} ${url}`);
    });
    client.on('Network.loadingFailed', (params) => {
      if (params.canceled || params.type === 'Other') return;
      badResponses.push(params.errorText || 'loading failed');
    });

    await client.send('Page.navigate', { url: target });
    await waitFor('应用启动', async () => {
      const status = await client.evaluate(`({
        booted: Boolean(window.__pdfTools && window.__pdfTools.booted),
        error: document.querySelector('#bootError')?.textContent || '',
        ready: document.readyState
      })`);
      if (status?.error) throw new Error(status.error);
      return status?.booted ? status : null;
    }, 15000);

    const { root: documentRoot } = await client.send('DOM.getDocument', { depth: 1 });
    const found = await client.send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: '#fileInput' });
    if (!found.nodeId) throw new Error('找不到文件选择框');
    await client.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [fixture] });

    const loaded = await waitFor('载入两页 PDF', async () => {
      const snap = await client.evaluate('window.__pdfTools.getSnapshot()');
      return snap?.pageCount === 2 && snap.rendered && !snap.busy && snap.fileName.includes('two-pages') ? snap : null;
    }, 25000);
    console.log(`loaded ${loaded.fileName} pages=${loaded.pageCount} size=${loaded.fileSize}`);

    await client.evaluate(`document.querySelector('#btnNext').click()`);
    const pageTwo = await waitFor('切换到第 2 页', async () => {
      const snap = await client.evaluate('window.__pdfTools.getSnapshot()');
      return snap?.pageNumber === 2 && snap.rendered && !snap.busy ? snap : null;
    }, 15000);
    console.log(`page ${pageTwo.pageNumber}/${pageTwo.pageCount}`);

    const before = pageTwo.crop;
    const center = pageTwo.cropClient;
    if (!center) throw new Error('裁剪框尚未显示');
    await mouse(client, 'mousePressed', center.x, center.y, 1);
    await mouse(client, 'mouseMoved', center.x + 36, center.y + 22, 1);
    await mouse(client, 'mouseMoved', center.x + 64, center.y + 36, 1);
    await mouse(client, 'mouseReleased', center.x + 64, center.y + 36, 0);
    const dragged = await waitFor('拖动裁剪框', async () => {
      const snap = await client.evaluate('window.__pdfTools.getSnapshot()');
      if (!snap?.crop) return null;
      const moved = Math.abs(snap.crop.x - before.x) > 1 || Math.abs(snap.crop.y - before.y) > 1;
      return moved ? snap : null;
    }, 5000);
    console.log(`crop moved to x=${dragged.crop.x.toFixed(2)} y=${dragged.crop.y.toFixed(2)}`);

    await client.evaluate(`document.querySelector('#formatPdf').click()`);
    await client.evaluate(`document.querySelector('#btnExport').click()`);
    const pdf = await waitFor('矢量 PDF 导出', async () => {
      const value = await client.evaluate('window.__pdfTools.lastExport');
      return value?.kind === 'pdf' && value.byteLength > 500 ? value : null;
    }, 20000);
    assertSignature(pdf, [0x25, 0x50, 0x44, 0x46], '%PDF');
    console.log(`export pdf ${pdf.name} bytes=${pdf.byteLength}`);

    await client.evaluate(`document.querySelector('#formatPng').click()`);
    await client.evaluate(`document.querySelector('#btnExport').click()`);
    const png = await waitFor('PNG 导出', async () => {
      const value = await client.evaluate('window.__pdfTools.lastExport');
      return value?.kind === 'png' && value.byteLength > 100 ? value : null;
    }, 20000);
    assertSignature(png, [0x89, 0x50, 0x4e, 0x47], 'PNG');
    console.log(`export png ${png.name} bytes=${png.byteLength}`);

    const hosts = await client.evaluate(`
      [...new Set(performance.getEntriesByType('resource').map((entry) => {
        try { return new URL(entry.name).host; } catch { return entry.name; }
      }))].filter(Boolean)
    `);
    const external = (hosts || []).filter((host) => !host.startsWith('127.0.0.1'));
    if (external.length) fail(`出现外部资源 ${external.join(', ')}`);
    if (badResponses.length) fail(`请求失败 ${badResponses.join(' | ')}`);
    if (consoleErrors.length) fail(`控制台错误 ${consoleErrors.join(' | ')}`);
    if (pageErrors.length) fail(`页面异常 ${pageErrors.join(' | ')}`);
    const errorText = await client.evaluate('document.querySelector("#errorText")?.textContent || ""');
    if (errorText) fail(`界面错误 ${errorText}`);

    if (failures.length) {
      console.error('e2e: FAIL');
      for (const item of failures) console.error(`- ${item}`);
      process.exitCode = 1;
    } else {
      console.log('e2e: PASS');
      console.log(`- subpath ${target}`);
      console.log('- console errors: 0');
      console.log(`- resource hosts: ${(hosts || []).join(', ') || '(none)'}`);
    }
  } finally {
    try { socket?.close(); } catch { /* ignore */ }
    try { chrome.kill('SIGTERM'); } catch { /* already exited */ }
    server.server.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

function assertSignature(result, expected, label) {
  const actual = result.signature || [];
  const matches = expected.every((byte, index) => actual[index] === byte);
  if (!matches) fail(`${label} 签名不符 ${actual}`);
  if (!result.name.includes('-p2-')) fail(`${label} 文件名缺少页码 ${result.name}`);
}

async function mouse(client, type, x, y, buttons) {
  await client.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons,
    clickCount: 1,
  });
}

async function findPage(port, target) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    const page = list.find((item) => item.type === 'page' && item.url?.includes('/pdf-tools/'));
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`找不到页面 ${target}`);
}

async function waitFor(label, fn, timeout) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`超时：${label}（${JSON.stringify(last)}） ${consoleErrors.join(' | ')} ${pageErrors.join(' | ')}`);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, listener) {
    const list = this.listeners.get(method) || [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  waitFor(method, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`超时：${method}`)), timeout);
      this.on(method, (params) => {
        clearTimeout(timer);
        resolve(params);
      });
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return result.result?.value;
  }
}

main().catch((error) => {
  console.error('e2e: FAIL');
  console.error(error?.stack || error?.message || error);
  if (consoleErrors.length) console.error('console:', consoleErrors.join(' | '));
  if (pageErrors.length) console.error('page:', pageErrors.join(' | '));
  process.exitCode = 1;
});
