/**
 * compute-id.js — 计算浏览器扩展的固定 ID（native-host 用）
 *
 * 依据 docs/design.md §10.2 的算法：
 *   1. 读取 ..\extension\manifest.json 的 key 字段（base64 编码的 SPKI DER 公钥）；
 *   2. 用 crypto 解码为 DER 字节，取 sha256 摘要的前 16 字节；
 *   3. 每字节拆成高低两个半字节（nibble），映射 'a' + nibble（0→a … 15→p）；
 *   4. 得到 32 字符扩展 ID，用 fs 写入 native-host\.extension-id.json：
 *      { "extensionId": "<32 字符 ID>" }
 *
 * 结果通过文件传递（.extension-id.json），不使用 stdout 传数据
 * （本环境管道受限，install.ps1 从该文件读取扩展 ID）。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'extension', 'manifest.json');
const OUT_PATH = path.join(__dirname, '.extension-id.json');

function fail(message) {
  console.error('[compute-id] 错误：' + message);
  process.exit(1);
}

// 1. 读取扩展清单
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
} catch (err) {
  fail('无法读取扩展清单 ' + MANIFEST_PATH + '：' + err.message +
    '。请确认 extension/manifest.json 已存在（扩展工程产物）。');
}

// 2. 取 key 字段并解码为 DER
const key = manifest.key;
if (typeof key !== 'string' || key.trim() === '') {
  fail('extension/manifest.json 缺少 "key" 字段（base64 编码的 SPKI DER 公钥，见 docs/design.md §10.2）。');
}

const keyTrimmed = key.trim();
let der;
try {
  der = Buffer.from(keyTrimmed, 'base64');
} catch (err) {
  fail('"key" 不是合法的 base64 字符串：' + err.message);
}
if (der.length === 0) {
  fail('"key" 解码后为空，无法计算扩展 ID。');
}
// 注意：Buffer.from(str, 'base64') 对非法字符是「宽容解码」（忽略非法字符），
// 不会抛错。用往返校验兜底——只有能完整无损解码的 key 才接受，
// 防止坏 key 悄悄算出错误的扩展 ID。
if (der.toString('base64') !== keyTrimmed) {
  fail('"key" 不是合法的 base64（无法完整解码），请检查 extension/manifest.json 的 key 字段。');
}

// 3. sha256 取前 16 字节，逐字节映射为两个半字节字符
const digest = crypto.createHash('sha256').update(der).digest();
const first16 = digest.subarray(0, 16);

let extensionId = '';
for (let i = 0; i < first16.length; i++) {
  const byte = first16[i];
  extensionId += String.fromCharCode(97 + (byte >> 4));   // 高半字节 → a-p
  extensionId += String.fromCharCode(97 + (byte & 0x0f)); // 低半字节 → a-p
}

// 4. 写入 .extension-id.json（数据经文件传递）
const payload = { extensionId: extensionId };
fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log('[compute-id] 扩展 ID：' + extensionId);
console.log('[compute-id] 已写入 ' + OUT_PATH);
