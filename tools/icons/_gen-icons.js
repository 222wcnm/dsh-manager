'use strict';
// ============================================================================
// _gen-icons.js — 用 headless Chrome + CDP 把鲸鱼 logo（tools/icons/whale.svg）
// 渲染为扩展图标 icons/{16,48,128}.png（透明背景、4x 超采样后盒式降采样）。
// 角标变体（M8.1 图标角标，实例状态层）：icons/{ok,error}-{16,48,128}.png —
// 右上角 44% 白描边圆点（绿=运行 #22c55e / 红=错误 #ec1313），与徽标
// 会话状态层（字符）天然双载体共存，不互斥覆盖（design §8.9.1）。
//
// 来源：popup.html 内联 brand-logo 的鲸鱼路径（path 10，与 Web UI 侧栏 logo 同源），
// 颜色 = --dsw-alias-label-primary = #0F1115。
// 沙箱会拦截 Chrome 进程 IPC（mojo 拒绝访问），需在沙箱外或提权运行
// （与 tools/visual-audit 相同）。渲染页在运行时生成到 %TEMP%，不入库。
// ============================================================================
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 9334;
const SIZE = [16, 48, 128];
const SS = 4; // 超采样倍数
const CHROME_CANDIDATES = [
  ...(process.env.CHROME_PATH ? [process.env.CHROME_PATH] : []),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

// 渲染页模板：品牌深底（#0F1115，圆角 22%）+ 白色鲸鱼铺满方形画布，背景透明。
// 深底白鲸与 webui 深色主题侧栏鲸鱼同款；弥补透明图标「内容 88%×63%、上下留白 37%、
// 无底色」导致的工具栏视觉偏小/利用率低（2026-08-22 用户实测观察；相邻 KT/猫等
// 图标均为满铺色块）。whale.svg 源保持不变，仅注入时替换 fill 为白色。
const PAGE_TPL = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
  .bg { position: absolute; inset: 0; background: #0F1115; border-radius: 22%; }
  svg { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
  .dotring { position: absolute; right: 5%; top: 5%; width: 44%; height: 44%; border-radius: 50%;
    background: #FFFFFF; display: flex; align-items: center; justify-content: center; }
  .dotcore { width: 66%; height: 66%; border-radius: 50%; background: {{DOTCOLOR}}; }
</style>
</head>
<body>
<div class="bg"></div>
{{WHALE}}
{{DOT}}
</body>
</html>`;

// 角标变体：白描边圆点右上角叠加（16px 显示时约 7px 圆 + 4.5px 色芯，通知点惯例比例）
const ICON_VARIANTS = [
  { prefix: '', color: '' },              // 基础（无点）= 默认/停止
  { prefix: 'ok-', color: '#22c55e' },    // 运行中 = 绿点
  { prefix: 'error-', color: '#ec1313' }, // 错误 = 红点（全域红色只属于错误语义，§8.9.1）
];

function dotHtml(color) {
  return color ? `<div class="dotring"><div class="dotcore" style="background:${color}"></div></div>` : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

async function waitCdp() {
  for (let i = 0; i < 40; i++) {
    try { await fetchJson('http://127.0.0.1:' + PORT + '/json/version'); return; } catch (_) { await sleep(250); }
  }
  throw new Error('CDP 未就绪');
}

async function openPage(url) {
  const t = await fetchJson('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let idc = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const id = ++idc;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  await send('Page.enable');
  return { ws, send, targetId: t.id };
}

// 4x 盒式降采样（预乘 alpha 平均，保证透明边缘正确）
function downscale4(buf, w, h) {
  const ow = w >> 2, oh = h >> 2;
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = (((y * SS + dy) * w) + (x * SS + dx)) * 4;
          const aa = buf[i + 3];
          r += buf[i] * aa; g += buf[i + 1] * aa; b += buf[i + 2] * aa; a += aa;
        }
      }
      const o = (y * ow + x) * 4;
      if (a === 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; }
      else {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / (SS * SS));
      }
    }
  }
  return out;
}

// ---- 最小 PNG 编码器（RGBA8，无依赖） ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(rgba, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) throw new Error('未找到 Chrome/Edge');

  // 运行时生成渲染页（whale.svg 注入模板，落到 %TEMP%；品牌深底 → 白鲸，见 PAGE_TPL 注释）
  const whale = fs.readFileSync(path.join(ROOT, 'tools', 'icons', 'whale.svg'), 'utf8')
    .trim()
    .replace('fill="#0F1115"', 'fill="#FFFFFF"');

  const outDir = path.join(ROOT, 'extension', 'icons');
  fs.mkdirSync(outDir, { recursive: true });

  const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--window-size=512,512',
    '--user-data-dir=' + path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'chrome-headless-dsh-icons'),
    '--remote-debugging-port=' + PORT,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitCdp();
    const page = await openPage('about:blank');
    await sleep(600);

    for (const variant of ICON_VARIANTS) {
      const pageVariant = PAGE_TPL
        .replace('{{WHALE}}', whale)
        .replace('{{DOT}}', dotHtml(variant.color))
        .replace('{{DOTCOLOR}}', variant.color || '#22c55e');
      const srcHtml = path.join(os.tmpdir(), 'dsh-manager-icon-source.html');
      fs.writeFileSync(srcHtml, pageVariant, 'utf8');
      await page.send('Page.navigate', { url: 'file:///' + srcHtml.replace(/\\/g, '/') });
      await sleep(600);
      for (const size of SIZE) {
        // 视口 = 目标尺寸（CSS px），deviceScaleFactor=4 → 截图 4x 像素
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: size, height: size, deviceScaleFactor: SS, mobile: false,
          screenWidth: size, screenHeight: size,
        });
        // 透明背景（alpha=0），Page.captureScreenshot 输出透明 PNG
        await page.send('Emulation.setDefaultBackgroundColorOverride', {
          color: { r: 0, g: 0, b: 0, a: 0 },
        });
        await sleep(250);
        const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        if (!shot || !shot.result || !shot.result.data) throw new Error('截图失败 size=' + size);
        const big = Buffer.from(shot.result.data, 'base64'); // (size*SS)^2 RGBA
        // 截图为 PNG 编码，解码为 RGBA：直接用 4x 超采样像素
        const rgba = decodePngRgba(big, size * SS, size * SS);
        const small = downscale4(rgba, size * SS, size * SS);
        const png = encodePng(small, size, size);
        const dest = path.join(outDir, variant.prefix + size + '.png');
        fs.writeFileSync(dest, png);
        console.log('wrote ' + dest + ' (' + png.length + 'B, ' + size + 'x' + size + ')');
      }
    }
  } finally {
    try { chrome.kill(); } catch (_) { /* 忽略 */ }
  }
}

// 极简 PNG 解码（仅支持我们已知形态：8bit RGBA，filter 0/1/2/3/4 通用实现）
function decodePngRgba(buf, w, h) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('bad png sig');
  let off = 8;
  let idat = [];
  let bitDepth = 0, colorType = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error('unexpected png format');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[y * stride + i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[y * stride + i] = v & 0xFF;
    }
    prev = out.subarray(y * stride, (y + 1) * stride);
  }
  return out;
}

// --selftest：纯 Node 自检（不需 Chrome），验证 PNG 编解码与降采样往返
if (process.argv.includes('--selftest')) {
  const rgba = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = i % 251; rgba[i + 1] = (i * 3) % 251; rgba[i + 2] = (i * 7) % 251; rgba[i + 3] = 255;
  }
  const png = encodePng(rgba, 64, 64);
  const dec = decodePngRgba(png, 64, 64);
  if (!dec.equals(rgba)) throw new Error('PNG 编解码往返不一致');
  const small = downscale4(rgba, 64, 64);
  if (small.length !== 16 * 16 * 4) throw new Error('降采样尺寸错误');
  console.log('selftest ok: PNG 编码/解码/4x 降采样往返通过');
  process.exit(0);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
