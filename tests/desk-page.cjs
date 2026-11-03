// Test only: a page's HTML with its CDN scripts removed and desk-shared.js
// inlined where the page loads it, so tests run offline against local code.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

function pageHtml(file) {
  const shared = fs.readFileSync(path.join(root, 'desk-shared.js'), 'utf8');
  return fs.readFileSync(path.join(root, file), 'utf8').replace(/<script\b[^>]*\bsrc="([^"]*)"[^>]*>\s*<\/script>/g,
    (tag, src) => (/(^|\/)desk-shared\.js(\?|$)/.test(src) ? `<script>${shared}</script>` : ''));
}

module.exports = { pageHtml };
