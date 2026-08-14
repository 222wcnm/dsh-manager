'use strict';

// DSH Manager — 扩展 ID / manifest key 生成器
//
// 一次性执行（项目初始化时运行一次）：
//   node scripts/keygen.js
//
// 算法（与 docs/design.md §10.2 一致，标准 Chromium 算法）：
//   1. 生成 RSA 2048 密钥对；
//   2. 公钥导出 SPKI DER 编码；
//   3. DER 做 base64 即 manifest 的 "key" 字段（固定公钥，仅用于稳定扩展 ID）；
//   4. 对 DER 做 sha256，取前 16 字节；每字节的高/低半字节分别映射为 'a'+nibble(0-15)，
//      拼成 32 字符小写字母扩展 ID（Chromium 扩展 ID 字符集：a-p）。
//
// 结果写入 extension/extension-key.json（{key, id}），不通过 stdout 传递数据。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'extension-key.json');

function main() {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });

  const key = der.toString('base64');

  const hash = crypto.createHash('sha256').update(der).digest().subarray(0, 16);
  const id = Array.from(hash, (b) =>
    String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))
  ).join('');

  if (!/^[a-p]{32}$/.test(id)) {
    throw new Error('生成的扩展 ID 不符合预期格式: ' + id);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ key, id }, null, 2) + '\n');
  console.log('wrote ' + OUT_FILE);
  console.log('extension id = ' + id);
}

main();
