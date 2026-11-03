// desk-shared.js: both desks load it, and admin.html's pinned copy is current.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'desk-shared.js'));
const script = (html) => html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>', html.indexOf('<script>\n')));

test('tutor.html loads desk-shared.js from its own site', () => {
  assert.match(fs.readFileSync(path.join(root, 'tutor.html'), 'utf8'), /<script src="desk-shared\.js"><\/script>/);
});

test('admin.html pins the current desk-shared.js by version and hash', { skip: !fs.existsSync(path.join(root, 'admin.html')) }, () => {
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const tag = html.match(/<script src="https:\/\/digitaldickinson\.github\.io\/Moira-Desk\/desk-shared\.js\?v=([0-9a-f]+)"\s+integrity="([^"]+)"\s+crossorigin="anonymous"><\/script>/);
  assert.ok(tag, 'admin.html loads desk-shared.js from GitHub Pages with an integrity hash');
  const sha384 = crypto.createHash('sha384').update(shared);
  const digest = sha384.digest();
  assert.equal(tag[2], `sha384-${digest.toString('base64')}`, 'integrity hash matches desk-shared.js: run the README command and update admin.html');
  assert.equal(tag[1], digest.toString('hex').slice(0, 12), '?v= matches the hash, so a cached old copy is never used');
});

test('neither page declares a name that desk-shared.js already declares', () => {
  for (const file of ['tutor.html', 'admin.html']) {
    if (!fs.existsSync(path.join(root, file))) continue;
    assert.doesNotThrow(() => new vm.Script(`${shared}\n${script(fs.readFileSync(path.join(root, file), 'utf8'))}`), `${file} redeclares a shared name`);
  }
});

test('desk-shared.js can be inlined for tests', () => {
  assert.ok(!/<\/script/i.test(shared.toString()));
});
