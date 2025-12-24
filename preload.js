// Electron preload 默认以 CommonJS 脚本执行（即使项目是 type=module）。
// 使用 ESM import 会导致：Cannot use import statement outside a module
const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  try {
    const argvRole = process.argv.includes('--ims-window=ui')
      ? 'ui'
      : process.argv.includes('--ims-window=automation')
        ? 'automation'
        : 'unknown';

    // 某些环境下 additionalArguments 可能无法可靠出现在 renderer 的 argv；再用 URL 兜底。
    const href = String(window.location?.href ?? '').toLowerCase();
    const urlRole = href.includes('index.html')
      ? 'ui'
      : href.includes('automation.html')
        ? 'automation'
        : 'unknown';

    const role = argvRole !== 'unknown' ? argvRole : urlRole;

    // 关键：用 window.name 作为“这个页面属于哪个窗口角色”的稳定标识（跨导航保留）。
    // Playwright 会用它来避免误操作 UI 窗口。
    if (role === 'automation') {
      window.name = 'IMS_AUTOMATION';
    } else if (role === 'ui') {
      window.name = 'IMS_UI';
    }

    const byId = (id) => document.getElementById(id);
    const setText = (id, text) => {
      const el = byId(id);
      if (el) el.textContent = String(text);
    };
    const setHtml = (id, html) => {
      const el = byId(id);
      if (el) el.innerHTML = html;
    };
    const pad2 = (n) => String(n).padStart(2, '0');
    const formatTime = (ts) => {
      const d = new Date(ts);
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    };

    // versions
    for (const type of ['chrome', 'node', 'electron']) {
      setText(`${type}-version`, process.versions[type]);
    }

    // automation 窗口不需要 UI 注入（也避免对学习平台页面增加额外干扰）
    if (role !== 'ui') return;

    // 告诉主进程：UI 已经加载并开始监听 IPC（避免错过 init/progress 导致“不更新”）
    try {
      ipcRenderer.send('ims:log', `UI Preload Ready. Role=${role}, Href=${href}`);
      ipcRenderer.send('ims:ui:ready');
    } catch (e) {
      console.error('Failed to send ims:ui:ready', e);
    }

    // UI refs
    const ui = {
      dot: byId('ui-dot'),
      concurrency: byId('ui-concurrency'),
      group: byId('ui-group'),
      progress: byId('ui-progress'),
      bar: byId('ui-bar'),
      done: byId('ui-done'),
      skip: byId('ui-skip'),
      err: byId('ui-err'),
      last: byId('ui-last'),
      workers: byId('ui-workers'),
      log: byId('ui-log'),
    };

    const state = {
      groupTitle: '-',
      total: 0,
      done: 0,
      skip: 0,
      err: 0,
      concurrency: 1,
      workers: new Map(),
      logs: [],
    };

    const pushLog = (line) => {
      state.logs.push(line);
      if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
      if (ui.log) {
        ui.log.textContent = state.logs.join('\n');
        ui.log.scrollTop = ui.log.scrollHeight;
      }
    };

    const render = () => {
      setText('ui-group', state.groupTitle);
      setText('ui-done', state.done);
      setText('ui-skip', state.skip);
      setText('ui-err', state.err);
      setText('ui-concurrency', state.concurrency);

      const completed = state.done + state.skip + state.err;
      setText('ui-progress', `${completed} / ${state.total}`);

      const pct = state.total > 0 ? Math.min(100, Math.round((completed / state.total) * 100)) : 0;
      if (ui.bar) ui.bar.style.width = `${pct}%`;

      if (ui.dot) {
        ui.dot.className = 'dot';
        if (state.err > 0) ui.dot.classList.add('bad');
        else if (completed > 0) ui.dot.classList.add('good');
      }

      if (ui.workers) {
        const rows = [];
        const keys = [...state.workers.keys()].sort();
        for (const k of keys) {
          const w = state.workers.get(k);
          const idx = w?.index != null && w?.total != null ? `${w.index}/${w.total}` : '-';
          const name = w?.task ?? '-';
          rows.push(
            `<tr><td>${k}</td><td>${idx}</td><td>${escapeHtml(name)}</td></tr>`,
          );
        }
        setHtml('ui-workers', rows.join(''));
      }
    };

    const escapeHtml = (s) =>
      String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

    ipcRenderer.on('ims:ui:init', (_evt, payload) => {
      ipcRenderer.send('ims:log', 'Received ims:ui:init');
      if (payload?.concurrency) state.concurrency = payload.concurrency;
      setText('ui-last', formatTime(payload?.ts ?? Date.now()));
      render();
    });

    ipcRenderer.on('ims:progress', (_evt, e) => {
      // ipcRenderer.send('ims:log', `Received ims:progress: ${e?.kind}`); // Too noisy
      const ts = e?.ts ?? Date.now();
      setText('ui-last', formatTime(ts));

      switch (e?.kind) {
        case 'groupStart': {
          state.groupTitle = e.groupTitle;
          state.total = e.totalCourses;
          state.done = 0;
          state.skip = 0;
          state.err = 0;
          state.concurrency = e.concurrency || state.concurrency;
          state.workers.clear();
          for (let i = 1; i <= state.concurrency; i++) {
            state.workers.set(`W${i}`, { task: '-', index: null, total: null });
          }
          pushLog(`[${formatTime(ts)}] 课程组开始：${e.groupTitle}（共 ${e.totalCourses}）`);
          break;
        }
        case 'groupEnd': {
          pushLog(`[${formatTime(ts)}] 课程组结束：${e.groupTitle}`);
          break;
        }
        case 'groupError': {
          pushLog(`[${formatTime(ts)}] ❌ 课程组异常：${e.groupTitle} - ${e.message}`);
          break;
        }
        case 'courseStart': {
          const tag = e.workerTag || 'W1';
          const title = `${e.course.moduleName} / ${e.course.syllabusName || '-'} / ${e.course.activityName}`;
          state.workers.set(tag, { task: title, index: e.index, total: e.total });
          pushLog(`[${formatTime(ts)}] ${tag} ▶ ${e.index}/${e.total} ${e.course.activityName}`);
          break;
        }
        case 'courseDone': {
          state.done++;
          const tag = e.workerTag || 'W1';
          pushLog(`[${formatTime(ts)}] ${tag} ✅ 完成 ${e.index}/${e.total} ${e.course.activityName}`);
          break;
        }
        case 'courseSkip': {
          state.skip++;
          const tag = e.workerTag || 'W1';
          pushLog(
            `[${formatTime(ts)}] ${tag} ⚠️ 跳过 ${e.index}/${e.total} ${e.course.activityName}（${e.reason}）`,
          );
          break;
        }
        case 'courseError': {
          state.err++;
          const tag = e.workerTag || 'W1';
          pushLog(`[${formatTime(ts)}] ${tag} ❌ 失败 ${e.index}/${e.total} ${e.course.activityName} - ${e.message}`);
          break;
        }
        default:
          break;
      }

      render();
    });

    // initial render
    render();
  } catch (err) {
    try {
      ipcRenderer.send('ims:log', `Preload Error: ${err.message}\n${err.stack}`);
    } catch { }
  }
});
