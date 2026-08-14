'use strict';
const fs = require('fs');
const path = require('path');
const a = JSON.parse(fs.readFileSync(path.join(__dirname, '_audit.json'), 'utf8'));

function brief(e) {
  if (!e) return 'null';
  const r = e.rect;
  return {
    color: e.color, bg: e['background-color'], border: e['border-color'],
    radius: e['border-radius'], fontSize: e['font-size'], fontWeight: e['font-weight'],
    display: e.display, visibility: e.visibility,
    rect: r ? `${r.w}x${r.h}@${r.x},${r.y}` : null,
  };
}

for (const st of ['stopped', 'running', 'external', 'error', 'settings-stopped']) {
  console.log('===== state: ' + st + ' =====');
  const s = a.states[st];
  for (const sel of ['.brand-logo', '#dot', '.title', '.icon-btn', '.url-row', '.url-text',
    '#btn-start', '#btn-stop', '#btn-restart', '#btn-adopt', '#btn-open', '#detail-line',
    '.error-panel', '.settings', '#set-port', '#btn-save', '#btn-cancel', '.hint']) {
    console.log('  ' + sel + ' : ' + JSON.stringify(brief(s[sel])));
  }
  const dot = s['#dot'];
  if (dot) {
    console.log('  #dot::before : ' + JSON.stringify(dot.pseudoBefore));
    console.log('  #dot::after  : ' + JSON.stringify(dot.pseudoAfter));
  }
}
console.log('===== web ui reference =====');
for (const [k, v] of Object.entries(a.webUiReference || {})) console.log('  ' + k + ' : ' + JSON.stringify(brief(v)));
