import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } };
const DEFAULTS = { settleMs: 800, navigationTimeoutMs: 20_000, maxImageBytes: 1_048_576, jpegQuality: 80, captureTimeoutMs: 45_000 };
const PIXEL_THRESHOLD = 32;
const CELL = 16;
const MAX_REGIONS = 20;
const MAX_CONSOLE = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChromium(env = process.env) {
  if (env.GITFLARE_CHROMIUM && existsSync(env.GITFLARE_CHROMIUM)) return env.GITFLARE_CHROMIUM;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'headless_shell']) {
    try { return execFileSync('which', [name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
    catch { continue; }
  }
  for (const root of [path.join(homedir(), '.cache', 'ms-playwright'), env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean)) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root).filter((name) => name.startsWith('chromium')).sort().reverse()) {
      for (const candidate of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const file = path.join(root, entry, candidate);
        if (existsSync(file)) return file;
      }
    }
  }
  return null;
}

class Devtools {
  #socket;
  #next = 1;
  #pending = new Map();
  #listeners = [];

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('DevTools connection failed')), { once: true }); });
    return new Devtools(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.#pending.has(message.id)) {
        const { resolve, reject } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message ?? 'DevTools error'}`));
        else resolve(message.result ?? {});
        return;
      }
      if (message.method) for (const listener of this.#listeners) listener(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener) { this.#listeners.push(listener); return () => { this.#listeners = this.#listeners.filter((item) => item !== listener); }; }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { off(); resolve(null); }, timeoutMs);
      const off = this.on((message) => { if (predicate(message)) { clearTimeout(timer); off(); resolve(message); } });
    });
  }

  close() { try { this.#socket.close(); } catch {} }
}

export async function launchChromium(executable, profileDir) {
  const child = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio', '--force-color-profile=srgb', `--user-data-dir=${profileDir}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`Chromium did not start: ${text.slice(-500)}`)), 20_000);
    child.stderr.on('data', (chunk) => {
      text += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited with ${code}: ${text.slice(-500)}`)); });
  });
  const devtools = await Devtools.connect(url);
  const version = await devtools.send('Browser.getVersion').catch(() => ({}));
  return { child, devtools, product: version.product ?? 'Chromium' };
}

const KEYS = { Enter: ['Enter', 13], Escape: ['Escape', 27], Space: [' ', 32], Tab: ['Tab', 9], Backspace: ['Backspace', 8], Delete: ['Delete', 46], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39] };

export function keyDescriptor(name) {
  if (KEYS[name]) return { key: KEYS[name][0], code: name, windowsVirtualKeyCode: KEYS[name][1] };
  if (/^Key[A-Z]$/.test(name)) return { key: name[3].toLowerCase(), code: name, windowsVirtualKeyCode: name.charCodeAt(3) };
  if (/^Digit[0-9]$/.test(name)) return { key: name[5], code: name, windowsVirtualKeyCode: name.charCodeAt(5) };
  if (/^[A-Za-z]$/.test(name)) return { key: name.toLowerCase(), code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, windowsVirtualKeyCode: name.charCodeAt(0) };
  if (/^F([1-9]|1[0-2])$/.test(name)) return { key: name, code: name, windowsVirtualKeyCode: 111 + Number(name.slice(1)) };
  const modifier = /^(Shift|Control|Alt)(Left|Right)?$/.exec(name);
  if (modifier) return { key: modifier[1], code: `${modifier[1]}${modifier[2] ?? 'Left'}`, windowsVirtualKeyCode: { Shift: 16, Control: 17, Alt: 18 }[modifier[1]] };
  return { key: name, code: name, windowsVirtualKeyCode: 0 };
}

const OUTLINE_SCRIPT = `(() => {
  const text = (node) => (node.textContent || '').replace(/\\s+/g, ' ').trim();
  const label = (node) => node.getAttribute('aria-label') || text(node) || node.getAttribute('placeholder') || node.getAttribute('title') || node.getAttribute('name') || '';
  const count = (selector) => document.querySelectorAll(selector).length;
  const headings = [...document.querySelectorAll('h1, h2, h3')].slice(0, 20).map((node) => node.tagName.toLowerCase() + ' ' + text(node).slice(0, 80));
  const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button]')].slice(0, 15).map((node) => node.tagName.toLowerCase() + (node.type ? '[' + node.type + ']' : '') + ' ' + label(node).slice(0, 40));
  const images = [...document.images];
  const width = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  return JSON.stringify({
    title: document.title,
    landmarks: { header: count('header, [role=banner]'), nav: count('nav, [role=navigation]'), main: count('main, [role=main]'), footer: count('footer, [role=contentinfo]'), aside: count('aside, [role=complementary]'), dialog: count('dialog[open], [role=dialog]') },
    headings,
    controls: { buttons: count('button, [role=button]'), links: count('a[href]'), inputs: count('input, select, textarea'), sample: controls },
    images: { total: images.length, missingAlt: images.filter((image) => !image.hasAttribute('alt')).length },
    canvas: count('canvas'),
    video: count('video'),
    bodyText: ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
    viewportMeta: !!document.querySelector('meta[name=viewport]'),
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body || document.documentElement).backgroundColor,
    overflow: Math.max(0, width - window.innerWidth),
    scrollHeight: document.documentElement.scrollHeight,
  });
})()`;

export function outlineText(outline, viewport) {
  const lines = [`Title: ${outline.title || '(none)'}`];
  const landmarks = Object.entries(outline.landmarks ?? {}).filter(([, value]) => value).map(([name, value]) => `${name}${value > 1 ? ` ×${value}` : ''}`);
  lines.push(`Landmarks: ${landmarks.length ? landmarks.join(', ') : 'none'}`);
  if (outline.headings?.length) lines.push(`Headings: ${outline.headings.join(' | ')}`);
  if (outline.controls) lines.push(`Controls: ${outline.controls.buttons} buttons, ${outline.controls.links} links, ${outline.controls.inputs} inputs${outline.controls.sample?.length ? ` (${outline.controls.sample.join('; ')})` : ''}`);
  if (outline.images?.total) lines.push(`Images: ${outline.images.total}${outline.images.missingAlt ? `, ${outline.images.missingAlt} without alt` : ''}`);
  if (outline.canvas) lines.push(`Canvas elements: ${outline.canvas}`);
  if (outline.video) lines.push(`Video elements: ${outline.video}`);
  if (outline.background) lines.push(`Body background: ${outline.background}${outline.colorScheme && outline.colorScheme !== 'normal' ? ` (color-scheme ${outline.colorScheme})` : ''}`);
  if (typeof outline.overflow === 'number') lines.push(outline.overflow > 0 ? `Horizontal overflow: ${outline.overflow}px beyond the ${viewport.width}px viewport` : `No horizontal overflow at ${viewport.width}px`);
  if (outline.viewportMeta === false) lines.push('No <meta name="viewport">: phones lay this page out at 980px and shrink it');
  if (outline.scrollHeight) lines.push(`Page height: ${outline.scrollHeight}px`);
  if (outline.bodyText) lines.push(`Text: ${outline.bodyText}`);
  return lines.join('\n');
}

export function captureId(route, viewport, theme, frame) {
  const slug = (value) => value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root';
  return [slug(route), viewport, theme, ...(frame ? [slug(frame)] : [])].join('_');
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function decodePng(buffer) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buffer.length < 8 || signature.some((byte, index) => buffer[index] !== byte)) throw new Error('Not a PNG');
  let offset = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`Unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? current[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      current[i] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const at = x * channels;
      if (colorType === 6) pixels.set(current.subarray(at, at + 4), out);
      else if (colorType === 2) { pixels[out] = current[at]; pixels[out + 1] = current[at + 1]; pixels[out + 2] = current[at + 2]; pixels[out + 3] = 255; }
      else if (colorType === 0) { pixels[out] = pixels[out + 1] = pixels[out + 2] = current[at]; pixels[out + 3] = 255; }
      else if (colorType === 4) { pixels[out] = pixels[out + 1] = pixels[out + 2] = current[at]; pixels[out + 3] = current[at + 1]; }
      else { const index = current[at] * 3; pixels[out] = palette[index]; pixels[out + 1] = palette[index + 1]; pixels[out + 2] = palette[index + 2]; pixels[out + 3] = 255; }
    }
    previous = current;
  }
  return { width, height, pixels };
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function encodePng({ width, height, pixels }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

function regionsFromCells(cells, columns, rows, width, height) {
  const seen = new Uint8Array(cells.length);
  const regions = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    let minX = columns, minY = rows, maxX = 0, maxY = 0, area = 0;
    const queue = [start];
    seen[start] = 1;
    while (queue.length) {
      const index = queue.pop();
      const x = index % columns, y = Math.floor(index / columns);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); area++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
        const next = ny * columns + nx;
        if (cells[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
      }
    }
    regions.push({ x: minX * CELL, y: minY * CELL, width: Math.min(width, (maxX + 1) * CELL) - minX * CELL, height: Math.min(height, (maxY + 1) * CELL) - minY * CELL, area });
  }
  return regions.sort((a, b) => b.area - a.area).slice(0, MAX_REGIONS).map(({ area: _area, ...region }) => region);
}

export function diffImages(base, candidate) {
  if (base.width !== candidate.width || base.height !== candidate.height) {
    return { changedRatio: 1, regions: [{ x: 0, y: 0, width: candidate.width, height: candidate.height }], image: null, sizeChanged: { from: [base.width, base.height], to: [candidate.width, candidate.height] } };
  }
  const { width, height } = candidate;
  const columns = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
  const cells = new Uint8Array(columns * rows);
  const output = new Uint8Array(width * height * 4);
  let changed = 0;
  for (let i = 0; i < width * height; i++) {
    const at = i * 4;
    const delta = Math.max(Math.abs(base.pixels[at] - candidate.pixels[at]), Math.abs(base.pixels[at + 1] - candidate.pixels[at + 1]), Math.abs(base.pixels[at + 2] - candidate.pixels[at + 2]), Math.abs(base.pixels[at + 3] - candidate.pixels[at + 3]));
    if (delta > PIXEL_THRESHOLD) {
      changed++;
      cells[Math.floor((i / width) / CELL) * columns + Math.floor((i % width) / CELL)] = 1;
      output[at] = 255; output[at + 1] = 45; output[at + 2] = 138; output[at + 3] = 255;
    } else {
      const gray = Math.round((candidate.pixels[at] * 0.3 + candidate.pixels[at + 1] * 0.59 + candidate.pixels[at + 2] * 0.11) * 0.35 + 150);
      output[at] = output[at + 1] = output[at + 2] = gray; output[at + 3] = 255;
    }
  }
  const regions = regionsFromCells(cells, columns, rows, width, height);
  for (const region of regions) {
    for (let x = region.x; x < region.x + region.width; x++) for (const y of [region.y, Math.min(height - 1, region.y + region.height - 1)]) { const at = (y * width + x) * 4; output[at] = 255; output[at + 1] = 45; output[at + 2] = 138; }
    for (let y = region.y; y < region.y + region.height; y++) for (const x of [region.x, Math.min(width - 1, region.x + region.width - 1)]) { const at = (y * width + x) * 4; output[at] = 255; output[at + 1] = 45; output[at + 2] = 138; }
  }
  return { changedRatio: changed / (width * height), regions, image: encodePng({ width, height, pixels: output }) };
}

function fetchText(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = httpRequest(url, { method: 'GET', headers: { accept: 'text/html,*/*' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { if (body.length < 512_000) body += part; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

export function htmlOutline(html) {
  const strip = (value) => value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const count = (pattern) => (html.match(pattern) ?? []).length;
  const headings = [...html.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)].slice(0, 20).map((match) => `${match[1].toLowerCase()} ${strip(match[2]).slice(0, 80)}`);
  const body = strip(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<head\b[\s\S]*?<\/head>/gi, ' '));
  return {
    title: strip(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''),
    landmarks: { header: count(/<header\b/gi), nav: count(/<nav\b/gi), main: count(/<main\b/gi), footer: count(/<footer\b/gi), aside: count(/<aside\b/gi), dialog: 0 },
    headings,
    controls: { buttons: count(/<button\b/gi), links: count(/<a\b[^>]*href/gi), inputs: count(/<(input|select|textarea)\b/gi), sample: [] },
    images: { total: count(/<img\b/gi), missingAlt: count(/<img\b(?![^>]*\balt=)[^>]*>/gi) },
    canvas: count(/<canvas\b/gi),
    video: count(/<video\b/gi),
    bodyText: body.slice(0, 240),
    scripts: count(/<script\b/gi),
  };
}

function frames(route) {
  const list = [{ steps: [], frame: undefined }];
  const pending = [];
  for (const step of route.steps ?? []) {
    if (step.capture) { list.push({ steps: [...pending], frame: step.capture }); pending.length = 0; }
    else pending.push(step);
  }
  if (pending.length && list.length === 1) list.push({ steps: [...pending], frame: 'after' });
  return list;
}

async function runSteps(devtools, sessionId, steps, warnings, where) {
  const center = async (selectorValue) => {
    const { result } = await devtools.send('Runtime.evaluate', { expression: `(() => { const node = document.querySelector(${JSON.stringify(selectorValue)}); if (!node) return null; node.scrollIntoView({ block: 'center', inline: 'center' }); const r = node.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }); })()`, returnByValue: true }, sessionId);
    return result.value ? JSON.parse(result.value) : null;
  };
  for (const step of steps) {
    if (step.wait !== undefined) { await sleep(step.wait); continue; }
    if (step.click) {
      const point = await center(step.click);
      if (!point) { warnings.push(`${where}: nothing matches "${step.click}" to click`); continue; }
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await devtools.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1, ...(type === 'mouseMoved' ? { button: 'none' } : {}) }, sessionId);
      await sleep(100);
      continue;
    }
    if (step.press) {
      const descriptor = keyDescriptor(step.press);
      await devtools.send('Input.dispatchKeyEvent', { type: 'keyDown', ...descriptor, ...(descriptor.key.length === 1 ? { text: descriptor.key } : {}) }, sessionId);
      await sleep(step.hold ?? 60);
      await devtools.send('Input.dispatchKeyEvent', { type: 'keyUp', ...descriptor }, sessionId);
      await sleep(60);
      continue;
    }
    if (step.type) { await devtools.send('Input.insertText', { text: step.type }, sessionId); continue; }
    if (step.scroll !== undefined) { await devtools.send('Runtime.evaluate', { expression: `window.scrollBy(0, ${step.scroll})` }, sessionId); await sleep(150); }
  }
}

async function capturePage(devtools, config, route, viewportName, theme, outDir, compareDir, warnings, axeSource) {
  const viewport = VIEWPORTS[viewportName];
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  const consoleErrors = [];
  const off = devtools.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(`Uncaught ${message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'error'}`.split('\n')[0].slice(0, 300));
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(`console.error ${message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')}`.slice(0, 300));
    else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !/favicon\.ico/.test(message.params.entry.url ?? '')) consoleErrors.push(`${message.params.entry.source} ${message.params.entry.text}${message.params.entry.url ? ` (${message.params.entry.url})` : ''}`.slice(0, 300));
  });
  const results = [];
  try {
    await devtools.send('Page.enable', {}, sessionId);
    await devtools.send('Runtime.enable', {}, sessionId);
    await devtools.send('Log.enable', {}, sessionId);
    await devtools.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewportName === 'mobile' }, sessionId);
    if (viewportName === 'mobile') await devtools.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId).catch(() => {});
    await devtools.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, sessionId);
    const loaded = devtools.waitFor((message) => message.sessionId === sessionId && message.method === 'Page.loadEventFired', config.navigationTimeoutMs);
    const navigation = await devtools.send('Page.navigate', { url: `${config.baseUrl}${route.path}` }, sessionId);
    if (navigation.errorText) warnings.push(`${route.path}: navigation failed (${navigation.errorText})`);
    if (!await loaded) warnings.push(`${route.path}: load event did not fire within ${Math.round(config.navigationTimeoutMs / 1000)} s; captured the page as it was`);
    await sleep(config.settleMs);
    let axe;
    if (axeSource) {
      try {
        await devtools.send('Runtime.evaluate', { expression: axeSource }, sessionId);
        const { result } = await devtools.send('Runtime.evaluate', { expression: 'axe.run(document, { resultTypes: ["violations"] }).then((r) => JSON.stringify(r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }))))', awaitPromise: true, returnByValue: true, timeout: 20_000 }, sessionId);
        axe = result.value ? JSON.parse(result.value) : [];
      } catch (error) { warnings.push(`${route.path}: axe did not run (${error instanceof Error ? error.message : 'error'})`); }
    }
    for (const { steps, frame } of frames(route)) {
      if (steps.length) await runSteps(devtools, sessionId, steps, warnings, `${route.path}${frame ? ` (${frame})` : ''}`);
      if (steps.length) await sleep(config.settleMs / 2);
      const { result } = await devtools.send('Runtime.evaluate', { expression: OUTLINE_SCRIPT, returnByValue: true }, sessionId);
      const outline = result.value ? JSON.parse(result.value) : {};
      const shot = await devtools.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      let image = Buffer.from(shot.data, 'base64');
      const id = captureId(route.path, viewportName, theme, frame);
      const file = path.join(outDir, `${id}.png`);
      writeFileSync(file, image);
      let format = 'png';
      if (image.length > config.maxImageBytes) {
        const jpeg = await devtools.send('Page.captureScreenshot', { format: 'jpeg', quality: config.jpegQuality, captureBeyondViewport: false }, sessionId);
        image = Buffer.from(jpeg.data, 'base64');
        format = 'jpeg';
      }
      const capture = { id, route: route.path, label: route.label ?? route.path, ...(frame ? { frame } : {}), viewport: viewportName, theme, width: viewport.width, height: viewport.height, format, bytes: image.length, image: config.emitImages === false ? null : image.toString('base64'), outline: outlineText(outline, viewport), consoleErrors: [...new Set(consoleErrors)].slice(0, MAX_CONSOLE), overflow: outline.overflow ?? 0, ...(axe ? { axe } : {}) };
      const baseline = compareDir ? path.join(compareDir, `${id}.png`) : null;
      if (baseline && existsSync(baseline)) {
        try {
          const diff = diffImages(decodePng(readFileSync(baseline)), decodePng(readFileSync(file)));
          capture.diff = { against: id, changedRatio: Math.round(diff.changedRatio * 10_000) / 10_000, regions: diff.regions, ...(diff.sizeChanged ? { sizeChanged: diff.sizeChanged } : {}), image: diff.image && config.emitImages !== false ? diff.image.toString('base64') : null };
        } catch (error) { warnings.push(`${id}: could not compare with the base (${error instanceof Error ? error.message : 'error'})`); }
      } else if (compareDir) capture.diff = { against: null, changedRatio: 1, regions: [], image: null, missingBase: true };
      results.push(capture);
    }
  } finally {
    off();
    await devtools.send('Target.closeTarget', { targetId }).catch(() => {});
  }
  return results;
}

export async function outlineOnly(config, reason) {
  const captures = [];
  const warnings = [reason];
  for (const route of config.routes) {
    const response = await fetchText(`${config.baseUrl}${route.path}`, config.navigationTimeoutMs);
    if (!response.status) { warnings.push(`${route.path}: the preview did not answer`); continue; }
    const outline = htmlOutline(response.body);
    for (const viewportName of config.viewports) for (const theme of config.themes) {
      const viewport = VIEWPORTS[viewportName];
      captures.push({ id: captureId(route.path, viewportName, theme), route: route.path, label: route.label ?? route.path, viewport: viewportName, theme, width: viewport.width, height: viewport.height, format: 'png', bytes: 0, image: null, outline: `HTTP ${response.status}. Outline of the served HTML (no browser available, so scripts did not run):\n${outlineText(outline, viewport)}`, consoleErrors: [], overflow: -1 });
    }
  }
  return { mode: 'outline', browser: null, captures, warnings };
}

export async function capture(input) {
  const config = { ...DEFAULTS, ...input, viewports: input.viewports?.length ? input.viewports : ['desktop', 'mobile'], themes: input.themes?.length ? input.themes : ['light', 'dark'] };
  const executable = config.chromium ?? findChromium();
  if (!executable) return outlineOnly(config, 'No Chromium in the runner image: screenshots are unavailable until the image is rebuilt with chromium');
  mkdirSync(config.outDir, { recursive: true });
  let browser;
  try { browser = await launchChromium(executable, path.join(config.outDir, '.profile')); }
  catch (error) { return outlineOnly(config, `Chromium could not start: ${error instanceof Error ? error.message : 'error'}`); }
  const warnings = [];
  const captures = [];
  const axeSource = config.axe && existsSync(config.axe) ? readFileSync(config.axe, 'utf8') : null;
  if (config.axe && !axeSource) warnings.push(`axe-core was not found at ${config.axe}`);
  try {
    for (const route of config.routes) for (const viewportName of config.viewports) for (const theme of config.themes) {
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`capture of ${route.path} (${viewportName}, ${theme}) exceeded ${Math.round(config.captureTimeoutMs / 1000)} s`)), config.captureTimeoutMs); });
      try { captures.push(...await Promise.race([capturePage(browser.devtools, config, route, viewportName, theme, config.outDir, config.compareDir, warnings, axeSource), deadline])); }
      catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
      finally { clearTimeout(timer); }
    }
  } finally {
    browser.devtools.close();
    browser.child.kill('SIGKILL');
  }
  return { mode: 'browser', browser: browser.product, captures, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv[2] && process.argv[2] !== '-' ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
  capture(JSON.parse(source)).then((result) => { process.stdout.write(JSON.stringify(result)); process.exit(0); }, (error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exit(1); });
}
