const fs = require('fs');
const path = require('path');

const bundlePath = path.join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-ClqxG24t.js');
const code = fs.readFileSync(bundlePath, 'utf8');

function extractPathsFromSlice(str) {
  const paths = [];
  const parts = str.split('d:');
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const match = part.match(/^[\\\"']*([M][^\\\"'}]+)/);
    if (match) {
      paths.push(match[1]);
    }
  }
  return paths;
}

// 1. FishLogo (lf)
let idxLf = code.indexOf('function lf(');
let fishSlice = code.slice(idxLf, idxLf + 3500);
let fishPaths = extractPathsFromSlice(fishSlice);

// 2. Settings (F9)
let idxF9 = code.indexOf('F9=');
let f9Slice = code.slice(idxF9, idxF9 + 3500);
let f9Paths = extractPathsFromSlice(f9Slice);

// 3. Refresh (Y9)
let idxY9 = code.indexOf('Y9=');
let y9Slice = code.slice(idxY9, idxY9 + 1500);
let y9Paths = extractPathsFromSlice(y9Slice);

// 4. FollowSystem (I7)
let idxI7 = code.indexOf('I7=');
let i7Slice = code.slice(idxI7, idxI7 + 2000);
let i7Paths = extractPathsFromSlice(i7Slice);

// 5. Light (b7)
let idxB7 = code.indexOf('b7=');
let b7Slice = code.slice(idxB7, idxB7 + 2500);
let b7Paths = extractPathsFromSlice(b7Slice);

// 6. Dark (H7)
let idxH7 = code.indexOf('H7=');
let h7Slice = code.slice(idxH7, idxH7 + 2500);
let h7Paths = extractPathsFromSlice(h7Slice);

// 7. PanelLeft (B9)
let idxB9 = code.indexOf('B9=');
let b9Slice = code.slice(idxB9, idxB9 + 1500);
let b9Paths = extractPathsFromSlice(b9Slice);

// 8. NewChat (V9)
let idxV9 = code.indexOf('const V9=');
let v9Slice = code.slice(idxV9, idxV9 + 1500);
let v9Paths = extractPathsFromSlice(v9Slice);

// 9. ChevronDown (hs)
let idxHs = code.indexOf('hs=');
let hsSlice = code.slice(idxHs, idxHs + 1200);
let hsPaths = extractPathsFromSlice(hsSlice);

// 10. Code (S7)
let idxS7 = code.indexOf('S7=');
let s7Slice = code.slice(idxS7, idxS7 + 1500);
let s7Paths = extractPathsFromSlice(s7Slice);

// 11. StopFill (v7)
let idxV7 = code.indexOf('v7=');
let v7Slice = code.slice(idxV7, idxV7 + 1500);
let v7Paths = extractPathsFromSlice(v7Slice);

// 12. PlayOutline (_7)
let idxPlay = code.indexOf('_7=');
let playSlice = code.slice(idxPlay, idxPlay + 1500);
let playPaths = extractPathsFromSlice(playSlice);

// 13. Goal (B7)
let idxGoal = code.indexOf('B7=');
let goalSlice = code.slice(idxGoal, idxGoal + 1500);
let goalPaths = extractPathsFromSlice(goalSlice);

// 14. Skill (U7)
let idxSkill = code.indexOf('U7=');
let skillSlice = code.slice(idxSkill, idxSkill + 1500);
let skillPaths = extractPathsFromSlice(skillSlice);

console.log('FishLogo paths count:', fishPaths.length);
console.log('Settings paths count:', f9Paths.length);
console.log('Refresh paths count:', y9Paths.length);
console.log('FollowSystem paths count:', i7Paths.length);
console.log('Light paths count:', b7Paths.length);
console.log('Dark paths count:', h7Paths.length);
console.log('PanelLeft paths count:', b9Paths.length);
console.log('NewChat paths count:', v9Paths.length);
console.log('ChevronDown paths count:', hsPaths.length);

const assets = {
  FishLogo: {
    viewBox: '0 0 23.16 17.04',
    aspectRatio: 23.16 / 17.04,
    paths: fishPaths
  },
  IconSettingsOutline16: {
    viewBox: '0 0 16 16',
    paths: f9Paths
  },
  IconRefreshOutline16: {
    viewBox: '0 0 16 16',
    paths: y9Paths
  },
  IconFollowsystemOutline16: {
    viewBox: '0 0 16 16',
    paths: i7Paths
  },
  IconLightOutline16: {
    viewBox: '0 0 16 16',
    paths: b7Paths
  },
  IconDarkOutline16: {
    viewBox: '0 0 16 16',
    paths: h7Paths
  },
  IconPanelLeftOutline16: {
    viewBox: '0 0 16 16',
    paths: b9Paths
  },
  IconNewChatOutline16: {
    viewBox: '0 0 16 16',
    paths: v9Paths
  },
  IconChevronDownOutline14: {
    viewBox: '0 0 14 14',
    paths: hsPaths
  },
  IconCodeOutline16: {
    viewBox: '0 0 16 16',
    paths: s7Paths
  },
  IconPlayOutline16: {
    viewBox: '0 0 16 16',
    paths: playPaths
  },
  IconStopFill16: {
    viewBox: '0 0 16 16',
    paths: v7Paths
  },
  IconGoalOutline16: {
    viewBox: '0 0 16 16',
    paths: goalPaths
  },
  IconSkillOutline16: {
    viewBox: '0 0 16 16',
    paths: skillPaths
  }
};

const outputJS = `/**
 * DSH Web UI 原生官方资产库
 * 100% 提取自 @deepseek-ai/dsh-web-frontend 官方 bundle
 */

const DSH_ASSETS = ${JSON.stringify(assets, null, 2)};

function renderDSHIcon(iconName, size, className) {
  const asset = DSH_ASSETS[iconName];
  if (!asset) return '';
  const w = size || (asset.viewBox.startsWith('0 0 16') ? 16 : (asset.viewBox.startsWith('0 0 14') ? 14 : 20));
  const h = asset.aspectRatio ? Math.round((w / asset.aspectRatio) * 100) / 100 : w;
  const paths = asset.paths.map(p => '<path d="' + p + '" fill="currentColor"/>').join('');
  return '<svg width="' + w + '" height="' + h + '" viewBox="' + asset.viewBox + '" fill="none"' + (className ? ' class="' + className + '"' : '') + ' aria-hidden="true">' + paths + '</svg>';
}

function injectDSHAssets() {
  document.querySelectorAll('[data-dsh-icon]').forEach(el => {
    const name = el.getAttribute('data-dsh-icon');
    const size = parseInt(el.getAttribute('data-size') || '', 10) || null;
    const cls = el.getAttribute('class') || '';
    const svgHTML = renderDSHIcon(name, size, cls);
    if (svgHTML) {
      el.outerHTML = svgHTML;
    }
  });
}

if (typeof window !== 'undefined') {
  window.DSH_ASSETS = DSH_ASSETS;
  window.renderDSHIcon = renderDSHIcon;
  window.injectDSHAssets = injectDSHAssets;
}
`;

fs.writeFileSync(path.join(__dirname, 'dsh-assets-library.js'), outputJS, 'utf8');
console.log('Successfully generated full dsh-assets-library.js!');
