const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const server = http.createServer((req, res) => {
  let p = path.join('.', decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    let ext = path.extname(p);
    let ct = ext === '.html' ? 'text/html' : (ext === '.js' ? 'text/javascript' : 'text/css');
    res.writeHead(200, { 'Content-Type': ct });
    res.end(fs.readFileSync(p));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(8765, () => {
  console.log('Server started on 8765');
  const edgePath = '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"';
  try {
    execSync(`${edgePath} --headless --screenshot="d:\\Browser_extension\\dsh-manager\\tools\\ui-theme\\preview_cleaned_headers.png" --window-size=1450,960 --hide-scrollbars http://localhost:8765/tools/ui-theme/popup-redesign-v2-preview.html`);
    execSync(`${edgePath} --headless --screenshot="d:\\Browser_extension\\dsh-manager\\tools\\ui-theme\\preview_full_settings_restored.png" --window-size=1450,960 --hide-scrollbars http://localhost:8765/tools/ui-theme/popup-redesign-v2-preview.html?tab=sett`);
    console.log('Screenshots completed');
  } catch (err) {
    console.error('Error during screenshot:', err);
  } finally {
    server.close();
    process.exit(0);
  }
});
