import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { SOCIAL_CARD_WIDTH } from '../shared/social-card-svg';

let ready: Promise<void> | undefined;

async function load(): Promise<void> {
  const { default: wasm } = await import('@resvg/resvg-wasm/index_bg.wasm');
  await initWasm(wasm);
}

export async function rasterize(svg: string, fonts: Uint8Array[]): Promise<Uint8Array> {
  ready ??= load().catch(error => { ready = undefined; throw error; });
  await ready;
  const renderer = new Resvg(svg, { font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Instrument Sans' }, fitTo: { mode: 'width', value: SOCIAL_CARD_WIDTH } });
  try {
    const image = renderer.render();
    try { return image.asPng(); } finally { image.free(); }
  } finally { renderer.free(); }
}
