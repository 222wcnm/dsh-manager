const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  let p = path.join('d:/Browser_extension/dsh-manager', decodeURIComponent(reqPath));
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    let ext = path.extname(p);
    let ct = ext === '.html' ? 'text/html; charset=utf-8' : (ext === '.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
    res.writeHead(200, { 'Content-Type': ct });
    res.end(fs.readFileSync(p));
  } else {
    res.writeHead(404);
    res.end('Not found: ' + p);
  }
}).listen(0, () => {
  const port = server.address().port;
  console.log('HTTP ready on port ' + port);
  setTimeout(() => {
    try {
      execSync(`powershell -Command "Start-Process msedge.exe -ArgumentList '--headless', '--screenshot=d:\\Browser_extension\\dsh-manager\\tools\\ui-theme\\preview_cleaned_headers.png', '--window-size=1450,960', '--hide-scrollbars', 'http://localhost:${port}/tools/ui-theme/popup-redesign-v2-preview.html' -Wait"`);
      execSync(`powershell -Command "Start-Process msedge.exe -ArgumentList '--headless', '--screenshot=d:\\Browser_extension\\dsh-manager\\tools\\ui-theme\\preview_full_settings_restored.png', '--window-size=1450,960', '--hide-scrollbars', 'http://localhost:${port}/tools/ui-theme/popup-redesign-v2-preview.html?tab=sett' -Wait"`);
      console.log('Capture done');
    } catch (e) {
      console.error('Capture error:', e);
    } finally {
      server.close();
      process.exit(0);
    }
  }, 1000);
});
