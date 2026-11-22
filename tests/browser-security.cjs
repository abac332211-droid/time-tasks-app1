'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(4173, '127.0.0.1', resolve));

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:4173', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.sanitizeModalHtml === 'function');

    const sanitizer = await page.evaluate(() => {
      window.__p0Executed = 0;
      const payload = '<span style="background-image:u\\72l(javascript:window.__p0Executed++)" onclick="window.__p0Executed++">آمن ظاهريًا</span>'
        + '<img src="x" onerror="window.__p0Executed++">'
        + '<svg onload="window.__p0Executed++"><script>window.__p0Executed++</script></svg>'
        + '<a href="javascript:window.__p0Executed++">رابط</a>';
      const host = document.createElement('div');
      host.innerHTML = window.sanitizeModalHtml(payload);
      document.body.appendChild(host);
      return {
        html: host.innerHTML,
        executed: window.__p0Executed,
        activeElements: host.querySelectorAll('img,svg,script,iframe,object,embed,a').length,
        attributes: Array.from(host.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).map((a) => a.name))
      };
    });
    assert.equal(sanitizer.executed, 0, 'untrusted markup must not execute');
    assert.equal(sanitizer.activeElements, 0, 'active or unsupported elements must not survive');
    assert.equal(sanitizer.attributes.length, 0, 'allowed formatting elements must have no attributes');

    const migration = await page.evaluate(() => {
      const payload = '<img src=x onerror="window.__p0Executed++">\\72l(javascript:window.__p0Executed++)';
      window.showAlertModal('اختبار أمني', payload, true);
      return {
        text: document.getElementById('modalBody').textContent,
        images: document.getElementById('modalBody').querySelectorAll('img').length,
        executed: window.__p0Executed
      };
    });
    assert.match(migration.text, /<img src=x onerror=/);
    assert.equal(migration.images, 0, 'migration error content is rendered as text');
    assert.equal(migration.executed, 0, 'migration error content must not execute');

    const fallback = await page.evaluate(() => {
      const NativeParser = window.DOMParser;
      window.DOMParser = function () { throw new Error('forced parser failure'); };
      const value = '<img src=x onerror=alert(1)>';
      const escaped = window.sanitizeModalHtml(value);
      window.DOMParser = NativeParser;
      return escaped;
    });
    assert.equal(fallback, '&lt;img src=x onerror=alert(1)&gt;');
    process.stdout.write('Browser P0 security checks passed.\\n');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  process.stderr.write(String(error.stack || error) + '\\n');
  process.exitCode = 1;
});
