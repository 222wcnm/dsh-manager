'use strict';
const fs = require('fs');
const path = require('path');
const a = JSON.parse(fs.readFileSync(path.join(__dirname, '_audit.json'), 'utf8'));

const s = a.states;
function g(st, sel, prop) {
  const e = s[st] && s[st][sel];
  return e ? e[prop] : 'null';
}
console.log('radius btn-start :', g('stopped', '#btn-start', 'border-radius'), '(期望 12px)');
console.log('radius btn-stop  :', g('stopped', '#btn-stop', 'border-radius'), '(期望 12px)');
console.log('radius btn-open  :', g('stopped', '#btn-open', 'border-radius'), '(期望 12px)');
console.log('weight btn-start :', g('stopped', '#btn-start', 'font-weight'), '(期望 500)');
console.log('radius settings  :', g('settings-stopped', '.settings', 'border-radius'), '(期望 12px)');
console.log('error dot color  :', g('error', '#dot', 'color'), '(期望 rgb(236, 19, 19))');
const ep = s.error && s.error['#error-panel'];
console.log('error panel      :', ep ? `display=${ep.display} bg=${ep['background-color']} radius=${ep['border-radius']} rect=${ep.rect.w}x${ep.rect.h}` : 'null', '(期望可见, bg rgb(254,242,242))');
const eb = s.error && s.error['#btn-copy-log'];
console.log('copy-log btn     :', eb ? `display=${eb.display}` : 'null', '(期望 flex)');
console.log('adopt external   :', g('external', '#btn-adopt', 'display'), '/', g('external', '#btn-open', 'display'), '(期望 flex/flex)');
console.log('adopt running    :', g('running', '#btn-adopt', 'display'), '(期望 none)');
console.log('dot running      :', g('running', '#dot', 'color'), '(期望 rgb(34, 197, 94))');
console.log('logo rect        :', g('running', '.brand-logo', 'rect'));
console.log('icon-btn         :', g('running', '.icon-btn', 'rect'), g('running', '.icon-btn', 'border-radius'));
