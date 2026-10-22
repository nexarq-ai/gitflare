import { createServer } from 'node:http';
import { batchSize } from './batch.mjs';
import { concurrency } from './concurrency.mjs';

const inFlight = batchSize * concurrency;
const healthy = inFlight <= 8;
createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Capacity preview</title><style>body{font:16px system-ui;margin:64px auto;max-width:760px;padding:24px;color:#18212d;background:#f6f7f9}main{background:white;padding:40px;border:1px solid #dfe2e7;border-radius:12px}small{color:#64748b}h1{font-size:28px}dl{display:grid;grid-template-columns:1fr 1fr;gap:24px}dt{color:#64748b}dd{margin:0;font-size:36px;font-weight:600}.status{padding:16px;background:${healthy ? '#e6f6ec' : '#ffeaea'};color:${healthy ? '#17663b' : '#9d2020'};border-radius:8px}</style><main><small>GITFLARE · ISOLATED CANDIDATE PREVIEW</small><h1>Processing capacity</h1><dl><div><dt>Batch size</dt><dd>${batchSize}</dd></div><div><dt>Concurrency</dt><dd>${concurrency}</dd></div><div><dt>In-flight operations</dt><dd>${inFlight}</dd></div><div><dt>Service capacity</dt><dd>8</dd></div></dl><p class="status">${healthy ? 'Within service capacity' : 'Combined changes exceed service capacity'}</p></main></html>`);
}).listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '0.0.0.0');
