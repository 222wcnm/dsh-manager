'use strict';
// 解析 SVG path 数据并计算每条 path 的包围盒（含贝塞尔控制点近似）
const fs = require('fs');

const svg = fs.readFileSync(process.argv[2] || 'tools/visual-audit/brand-logo.svg', 'utf8');
const re = /<path d="([^"]+)"/g;
let m;
let idx = 0;
while ((m = re.exec(svg)) !== null) {
  idx++;
  const d = m[1];
  const bbox = pathBbox(d);
  console.log(`path ${idx}: x[${bbox.minX.toFixed(2)}, ${bbox.maxX.toFixed(2)}] y[${bbox.minY.toFixed(2)}, ${bbox.maxY.toFixed(2)}] w=${(bbox.maxX - bbox.minX).toFixed(2)} h=${(bbox.maxY - bbox.minY).toFixed(2)}`);
}

function pathBbox(d) {
  // tokenize
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  let x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let cmd = '';
  let i = 0;
  const eat = () => parseFloat(tokens[i++]);
  const add = (px, py) => {
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[a-zA-Z]/.test(t)) { cmd = t; i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': {
        x = rel ? x + eat() : eat();
        y = rel ? y + eat() : eat();
        sx = x; sy = y; add(x, y);
        cmd = cmd === 'm' ? 'l' : 'L';
        break;
      }
      case 'L': {
        x = rel ? x + eat() : eat();
        y = rel ? y + eat() : eat();
        add(x, y);
        break;
      }
      case 'H': x = rel ? x + eat() : eat(); add(x, y); break;
      case 'V': y = rel ? y + eat() : eat(); add(x, y); break;
      case 'C': {
        const x1 = rel ? x + eat() : eat(); const y1 = rel ? y + eat() : eat();
        const x2 = rel ? x + eat() : eat(); const y2 = rel ? y + eat() : eat();
        const x3 = rel ? x + eat() : eat(); const y3 = rel ? y + eat() : eat();
        add(x1, y1); add(x2, y2); add(x3, y3);
        cx = x2; cy = y2; x = x3; y = y3;
        break;
      }
      case 'S': {
        const x2 = rel ? x + eat() : eat(); const y2 = rel ? y + eat() : eat();
        const x3 = rel ? x + eat() : eat(); const y3 = rel ? y + eat() : eat();
        add(x2, y2); add(x3, y3);
        x = x3; y = y3;
        break;
      }
      case 'Q': {
        const x1 = rel ? x + eat() : eat(); const y1 = rel ? y + eat() : eat();
        const x2 = rel ? x + eat() : eat(); const y2 = rel ? y + eat() : eat();
        add(x1, y1); add(x2, y2);
        x = x2; y = y2;
        break;
      }
      case 'Z': case 'z': x = sx; y = sy; add(x, y); break;
      default: i++; // skip unknown
    }
  }
  return { minX, minY, maxX, maxY };
}
