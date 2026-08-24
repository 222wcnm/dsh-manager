const fs = require('fs');
const path = require('path');

const bundlePath = path.join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-ClqxG24t.js');
const code = fs.readFileSync(bundlePath, 'utf8');

let idxLf = code.indexOf('function lf(');
let sample = code.slice(idxLf, idxLf + 600);
console.log('Sample includes d:');
console.log(sample);

// 提取所有 d: 后的字符串
let paths = [];
let regex = /d:"([^"]+)"/g;
let m;
while ((m = regex.exec(sample)) !== null) {
  paths.push(m[1]);
}
console.log('Found paths with d:"...":', paths.length);
