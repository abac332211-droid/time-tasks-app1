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
    await page.addInitScript(() => {
      window.__p0ProjectExecuted = 0;
      localStorage.setItem('timeTasksApp_projects_v1', JSON.stringify([
        { id: 101, name: 'إضافة مهمة', description: '', status: 'active' },
        { id: 102, name: 'تغيير الحالة', description: '', status: 'active' },
        { id: 103, name: 'تعديل مشروع', description: '', status: 'active' },
        { id: 104, name: 'حذف مشروع', description: '', status: 'active' },
        { id: '105);window.__p0ProjectExecuted=1;//', name: 'معرّف مصطنع', description: '', status: 'active' }
      ]));
    });
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

    const projectMarkup = await page.evaluate(() => {
      window.renderProjects();
      const list = document.getElementById('projectsList');
      const buttons = Array.from(list.querySelectorAll('button[data-project-action]'));
      const hostileProject = Array.from(list.querySelectorAll('.project-card'))
        .find((card) => card.querySelector('.project-title')?.textContent.includes('معرّف مصطنع'));
      return {
        inlineHandlers: list.querySelectorAll('button[onclick]').length,
        actionCount: buttons.length,
        allIdsAreCanonical: buttons.every((button) => /^[1-9]\d*$/.test(button.getAttribute('data-project-id') || '')),
        hostileProjectId: hostileProject?.querySelector('[data-project-id]')?.getAttribute('data-project-id') || null
      };
    });
    assert.equal(projectMarkup.inlineHandlers, 0, 'project action buttons have no inline event handlers');
    assert.equal(projectMarkup.actionCount, 20, 'all four actions are rendered for each of five projects');
    assert.equal(projectMarkup.allIdsAreCanonical, true, 'stored IDs are repaired before becoming DOM data');
    assert.equal(projectMarkup.hostileProjectId, '105', 'the hostile stored ID is replaced with a safe numeric ID');

    const rejectedProjectAction = await page.evaluate(() => {
      const button = document.querySelector('#projectsList [data-project-action="add-task"][data-project-id="101"]');
      button.setAttribute('data-project-id', '101);window.__p0ProjectExecuted=1;//');
      button.click();
      const executed = window.__p0ProjectExecuted;
      button.setAttribute('data-project-id', '101');
      return executed;
    });
    assert.equal(rejectedProjectAction, 0, 'a fabricated DOM ID is rejected without executing code');

    const projectActions = await page.evaluate(() => {
      window.showPromptModal = function (_title, _body, _value, _placeholder, accept) {
        accept('مهمة اختبار أمني');
      };
      document.querySelector('#projectsList [data-project-action="add-task"][data-project-id="101"]').click();
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const taskAdded = main.tasks.some((task) => task.name === 'مهمة اختبار أمني' && task.projectId === 101);

      document.querySelector('#projectsList [data-project-action="toggle-status"][data-project-id="102"]').click();
      let projects = JSON.parse(localStorage.getItem('timeTasksApp_projects_v1'));
      const statusChanged = projects.find((project) => project.id === 102)?.status === 'completed';

      document.querySelector('#projectsList [data-project-action="edit"][data-project-id="103"]').click();
      const editOpened = document.getElementById('projectName').value === 'تعديل مشروع';
      document.getElementById('projectName').value = 'مشروع معدل بأمان';
      window.saveProject();
      projects = JSON.parse(localStorage.getItem('timeTasksApp_projects_v1'));
      const projectEdited = projects.find((project) => project.id === 103)?.name === 'مشروع معدل بأمان';

      window.showConfirmModal = function (_title, _body, accept) { accept(); };
      document.querySelector('#projectsList [data-project-action="delete"][data-project-id="104"]').click();
      projects = JSON.parse(localStorage.getItem('timeTasksApp_projects_v1'));
      const projectDeleted = !projects.some((project) => project.id === 104);

      return { taskAdded, statusChanged, editOpened, projectEdited, projectDeleted };
    });
    assert.deepEqual(projectActions, {
      taskAdded: true, statusChanged: true, editOpened: true, projectEdited: true, projectDeleted: true
    }, 'project action listeners preserve add, status, edit, and delete behavior');

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
