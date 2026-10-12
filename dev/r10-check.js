// ============================================================
//  v1.7「存档系统」真机验收脚本（r10-check.js）
//  · 零第三方依赖：Node 标准库 + CDP（WebSocket）驱动真实 Chrome
//  · 调试端口 9347（r9 用 9346，避免冲突），独立临时 profile：dev/.chrome-r10
//  · 被测入口 window.__neon（SAVE / saveGame / loadGame / migrateSave /
//    MIGRATIONS / exportSave / importSave / resetSave / saveSummary / showSaveScreen）
//  · 只读 index.html，不修改任何被测文件；退出码 0=全通过，1=有 FAIL
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const DEV_DIR = __dirname;

// 游戏文件解析：优先仓库根目录的 index.html，其次同目录的 neon-arena.html。
// 这样无论从仓库根目录还是 dev/ 运行都能找到同一个文件，仓库里也不需要存两份。
const GAME_FILE = (function () {
  const cands = [
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'neon-arena.html')
  ];
  for (const p of cands) if (fs.existsSync(p)) return p;
  console.error('FAIL: 找不到游戏文件，尝试过：\n  ' + cands.join('\n  '));
  process.exit(1);
})();
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9347;
const PROFILE = path.join(DEV_DIR, '.chrome-r10');
const URL_FILE = 'file:///' + GAME_FILE.replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------
//  断言与结果收集
// ------------------------------------------------------------
const PASSED = [];
const FAILED = [];
function pass(name, detail) {
  PASSED.push(name);
  console.log('   ✅ ' + name + (detail ? ' — ' + detail : ''));
}
function fail(name, detail) {
  FAILED.push(name + (detail ? ' — ' + detail : ''));
  console.log('   ❌ ' + name + (detail ? ' — ' + detail : ''));
}
// conds: [[标签, 布尔, 实际值], ...]；全部为真才算这一项通过
function expect(name, conds) {
  const bad = conds.filter(c => !c[1]);
  if (bad.length === 0) pass(name, conds.length + ' 项断言全部通过');
  else fail(name, bad.map(c => c[0] + '（实际 ' + String(c[2]) + '）').join('；'));
}
async function step(name, fn) {
  console.log('\n' + name);
  try { await fn(); } catch (e) { fail(name, '检查组未跑完: ' + ((e && e.message) || e)); }
}
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {}
}

// ------------------------------------------------------------
//  CDP 客户端（风格与 r9-check.js 一致）
// ------------------------------------------------------------
class CDP {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.pending = new Map(); this.onEvent = null; }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('ws error'));
      this.ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const { res: r, rej: j } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
        } else if (m.method && this.onEvent) {
          this.onEvent(m);
        }
      };
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面抛错: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}
async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const pg = list.find(t => t.type === 'page');
      if (pg && pg.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('无法连接调试端口 ' + PORT);
}

// ------------------------------------------------------------
//  页面内测试助手：把 META / stats 的候选持有者都算进来，
//  避免「同一逻辑状态存在两份对象引用」导致误判（存档实现允许二者之一持有真值）
// ------------------------------------------------------------
const HELPERS = `window.__t = (function () {
  function N() { return window.__neon || {}; }
  function push(a, o) { if (o && typeof o === 'object' && a.indexOf(o) === -1) a.push(o); return a; }
  function metaCands() { var n = N(), a = []; push(a, n.SAVE && n.SAVE.meta); push(a, n.META); return a; }
  function statsCands() { var n = N(), a = []; push(a, n.SAVE && n.SAVE.stats); push(a, n.G && n.G.stats); return a; }
  function get(cands, k) { for (var i = 0; i < cands.length; i++) { if (cands[i][k] !== undefined) return cands[i][k]; } return undefined; }
  return {
    N: N,
    meta: function (k) { return get(metaCands(), k); },
    setMeta: function (k, v) { var a = metaCands(); for (var i = 0; i < a.length; i++) a[i][k] = v; return a.length; },
    stats: function (k) { return get(statsCands(), k); },
    setStats: function (k, v) { var a = statsCands(); for (var i = 0; i < a.length; i++) a[i][k] = v; return a.length; },
    raw: function () { try { return localStorage.getItem('entropyTideSave'); } catch (e) { return null; } },
    parsed: function () { try { var s = localStorage.getItem('entropyTideSave'); return s ? JSON.parse(s) : null; } catch (e) { return null; } },
    errs: [],
    watchErrors: function () {
      var self = this;
      if (self.__watched) return;
      self.__watched = 1;
      window.addEventListener('error', function (e) { self.errs.push(String((e && e.message) || e)); });
      window.addEventListener('unhandledrejection', function (e) { self.errs.push('rejection:' + String(e && e.reason)); });
    },
    mark: function () { this.__n = this.errs.length; return this.__n; },
    newErrs: function () { return this.errs.slice(this.__n || 0); }
  };
})();
window.__t.watchErrors();
"ok"`;

// ------------------------------------------------------------
//  主流程
// ------------------------------------------------------------
(async () => {
  let cdp = null;
  let chrome = null;
  const ev = expr => cdp.eval(expr);
  const pageErrors = [];
  const fileChoosers = [];
  let pendingLoad = null;

  function nextLoad() {
    return new Promise(res => {
      const timer = setTimeout(() => { if (pendingLoad && pendingLoad.res === res) pendingLoad = null; res(); }, 15000);
      pendingLoad = { res: res, timer: timer };
    });
  }
  async function waitFor(expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 15000)) {
      try { if (await ev(expr)) return true; } catch (e) {}
      await sleep(200);
    }
    return false;
  }
  async function reload() {
    const wait = nextLoad();
    await cdp.send('Page.reload', { ignoreCache: false });
    await wait;
    await sleep(200);
    await waitFor('typeof window.__neon === "object" && !!window.__neon.G');
    await sleep(250);
    await ev(HELPERS);
  }

  // ===== 16) 单文件零外部资源（Node 侧文本校验，Chrome 之前先跑）=====
  await step('16) 单文件零外部资源（index.html 文本校验）', async () => {
    const raw = fs.readFileSync(GAME_FILE, 'utf8');
    const rules = [
      ['<script src=', /<script[^>]+src=/i],
      ['<link href=', /<link[^>]+href=/i],
      ['<img src=', /<img[^>]+src=/i]
    ];
    const hits = [];
    for (const [label, re] of rules) {
      const m = raw.match(re);
      if (m) hits.push(label + ' -> ' + m[0].slice(0, 80));
    }
    console.log('   · 被测文件 ' + GAME_FILE + '（' + raw.length + ' 字符）');
    expect('16) 单文件零外部资源', [
      ['不得出现 <script src= / <link href= / <img src=', hits.length === 0, hits.join(' | ') || 'none']
    ]);
  });

  // ===== 启动真实 Chrome =====
  if (!fs.existsSync(CHROME)) { fail('环境', '找不到 Chrome: ' + CHROME); }
  if (!PROFILE.endsWith('.chrome-r10')) { console.error('FAIL: 临时目录路径异常 ' + PROFILE); process.exit(1); }
  rmrf(PROFILE);                      // 每次从干净 profile 起跑，保证 localStorage 起点确定
  console.log('   · Chrome profile: ' + PROFILE);

  try {
    chrome = spawn(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
      '--disable-breakpad', '--no-first-run', '--hide-scrollbars',
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + PORT, '--window-size=1440,900', 'about:blank'
    ], { stdio: 'ignore' });

    cdp = new CDP(await connect());
    await cdp.open();
    cdp.onEvent = m => {
      if (m.method === 'Page.loadEventFired' && pendingLoad) {
        const p = pendingLoad; pendingLoad = null; clearTimeout(p.timer); p.res();
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push((d.exception && d.exception.description) || d.text);
      }
      // 文件选择框会以模态形式阻塞渲染进程：拦截下来，否则后续 Runtime.evaluate 会超时
      if (m.method === 'Page.fileChooserOpened') fileChoosers.push(m.params && m.params.mode);
    };
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    try { await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }); } catch (e) {}
    await cdp.send('Page.navigate', { url: URL_FILE });
    const ready = await waitFor('typeof window.__neon === "object" && !!window.__neon.G', 20000);
    await sleep(400);
    await ev(HELPERS);
    if (!ready) fail('0) 页面初始化', '20s 内未等到 window.__neon');

    // ===== 0) 契约成员与 DOM 存在性 =====
    await step('0) 契约成员与 DOM 存在性', async () => {
      const pres = await ev(`(function () {
        var N = window.__neon || {};
        var missing = [];
        function bad(m) { missing.push(m); }
        if (N.SAVE_VERSION !== 1) bad('SAVE_VERSION 应为 1，实际 ' + JSON.stringify(N.SAVE_VERSION));
        if (N.SAVE_KEY !== 'entropyTideSave') bad('SAVE_KEY 应为 entropyTideSave，实际 ' + JSON.stringify(N.SAVE_KEY));
        var lk = N.LEGACY_KEYS;
        if (!Array.isArray(lk) || lk.indexOf('neonArenaBest') < 0 || lk.indexOf('entropyTideMeta') < 0) {
          bad('LEGACY_KEYS 应含 neonArenaBest / entropyTideMeta，实际 ' + JSON.stringify(lk));
        }
        var S = N.SAVE;
        if (!S || typeof S !== 'object') bad('SAVE 不是对象');
        else {
          if (!('version' in S)) bad('SAVE.version 缺失');
          if (!('best' in S)) bad('SAVE.best 缺失');
          if (!S.meta || typeof S.meta !== 'object') bad('SAVE.meta 缺失或非对象');
          if (!S.stats || typeof S.stats !== 'object') bad('SAVE.stats 缺失或非对象');
        }
        ['saveGame', 'loadGame', 'migrateSave', 'exportSave', 'importSave', 'resetSave', 'saveSummary', 'showSaveScreen']
          .forEach(function (f) { if (typeof N[f] !== 'function') bad('__neon.' + f + ' 不是函数'); });
        if (!N.MIGRATIONS || typeof N.MIGRATIONS !== 'object') bad('__neon.MIGRATIONS 不是对象');
        var ids = ['overlaySave', 'saveSummary', 'saveExportBox', 'btnSaveExport', 'btnSaveCopy',
                   'btnSaveDownload', 'saveImportBox', 'btnSaveImport', 'btnSaveImportFile',
                   'btnSaveReset', 'btnSaveClose', 'overlayConfirm', 'confirmText', 'btnConfirmYes',
                   'btnConfirmNo', 'btnSaveTitle', 'btnSavePause'];
        var missDom = ids.filter(function (i) { return !document.getElementById(i); });
        return { missing: missing, missDom: missDom, totalDoms: ids.length };
      })()`);
      expect('0) 契约成员与 DOM 存在性', [
        ['API 成员全部存在', pres.missing.length === 0, pres.missing.join(' / ') || 'none'],
        ['DOM id 全部存在（共 ' + pres.totalDoms + ' 个）', pres.missDom.length === 0, pres.missDom.join(',') || 'none']
      ]);
    });

    // ===== 1) 空档启动 =====
    await step('1) 空档启动（无存档）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, out = {};
        try {
          localStorage.removeItem('entropyTideSave');
          localStorage.removeItem('neonArenaBest');
          localStorage.removeItem('entropyTideMeta');
        } catch (e) {}
        out.load = 'skipped';
        try { var v = N.loadGame(); out.load = (v === null) ? 'null' : (typeof v); }
        catch (e) { out.threw = String((e && e.message) || e); }
        out.best = (N.G ? N.G.best : 'no-G');
        return out;
      })()`);
      expect('1) 空档启动', [
        ['loadGame() 未抛异常', !r.threw, r.threw || 'none'],
        ['loadGame() 返回 null', r.load === 'null', r.load],
        ['G.best === 0', r.best === 0, r.best]
      ]);
    });

    // ===== 2) 导出结构 =====
    await step('2) 导出结构（Base64 / JSON 字段）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, out = {};
        try {
          var w = N.saveGame();
          out.saveGameReturn = (w && typeof w === 'object') ? 'object' : String(w);
          var b64 = N.exportSave();
          out.type = typeof b64;
          out.len = (typeof b64 === 'string') ? b64.length : -1;
          var d = JSON.parse(decodeURIComponent(escape(atob(b64))));   // 必须能用标准 atob 解回 JSON
          out.version = d.version;
          out.hasBest = ('best' in d);
          out.hasMeta = !!d.meta && typeof d.meta === 'object';
          out.hasStats = !!d.stats && typeof d.stats === 'object';
          out.exportedAt = typeof d.exportedAt;
          out.exportedAtOk = (typeof d.exportedAt === 'number' && d.exportedAt > 0);
          out.keys = Object.keys(d).join(',');
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      expect('2) 导出结构', [
        ['未抛异常', !r.err, r.err || 'none'],
        ['saveGame() 返回数据对象', r.saveGameReturn === 'object', r.saveGameReturn],
        ['exportSave() 返回非空字符串', r.type === 'string' && r.len > 0, r.type + '/' + r.len],
        ['version === 1', r.version === 1, r.version],
        ['含 best', r.hasBest === true, r.hasBest],
        ['含 meta 对象', r.hasMeta === true, r.hasMeta],
        ['含 stats 对象', r.hasStats === true, r.hasStats],
        ['exportedAt 为数字时间戳', r.exportedAtOk === true, r.exportedAt],
        ['JSON 字段 = ' + r.keys, true, r.keys]
      ]);
    });

    // ===== 3) 导出 -> 导入回环 =====
    await step('3) 导出 → 导入回环', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        try {
          if (N.G) N.G.best = 12345;
          if (N.SAVE) N.SAVE.best = 12345;
          T.setMeta('points', 7);
          T.setStats('totalKills', 99);
          N.saveGame();
          var b64 = N.exportSave();
          // 内存改成别的值，再导入回环
          if (N.G) N.G.best = 1;
          if (N.SAVE) N.SAVE.best = 1;
          T.setMeta('points', 0);
          T.setStats('totalKills', 0);
          var res = N.importSave(b64);
          out.ok = !!(res && res.ok === true);
          out.version = res && res.version;
          out.best = (N.G ? N.G.best : 'no-G');
          out.points = T.meta('points');
          out.kills = T.stats('totalKills');
          var p = T.parsed();
          out.diskBest = p ? p.best : null;
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      expect('3) 导出 → 导入回环', [
        ['未抛异常', !r.err, r.err || 'none'],
        ['importSave 返回 ok:true', r.ok === true, r.ok],
        ['返回 version === 1', r.version === 1, r.version],
        ['G.best === 12345', r.best === 12345, r.best],
        ['META.points === 7', r.points === 7, r.points],
        ['SAVE.stats.totalKills === 99', r.kills === 99, r.kills],
        ['localStorage.best === 12345', r.diskBest === 12345, r.diskBest]
      ]);
    });

    // ===== 4) 非法输入 =====
    await step('4) 非法输入不崩', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, out = {};
        try {
          var res = N.importSave('这不是base64!!!');
          out.ok = !!(res && res.ok === false);
          out.reason = (res && typeof res.reason === 'string') ? res.reason : String(res && res.reason);
          out.reasonHasFormat = (res && typeof res.reason === 'string') ? (res.reason.indexOf('格式') >= 0) : false;
          var w = N.saveGame();
          out.saveOk = !!(w && typeof w === 'object');
          var ld = N.loadGame();
          out.loadOk = !!ld;
          out.best = (N.G ? N.G.best : 'no-G');
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      expect('4) 非法输入不崩', [
        ['importSave 返回 ok:false', r.ok === true, r.ok],
        ['reason 含「格式」', r.reasonHasFormat === true, r.reason],
        ['随后 saveGame() 仍可用', r.saveOk === true, r.saveOk],
        ['随后 loadGame() 仍可用', r.loadOk === true, r.loadOk]
      ]);
    });

    // ===== 5) 版本过高 =====
    await step('5) 版本过高拒绝导入且不覆盖本地档', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        try {
          if (N.G) N.G.best = 555;
          if (N.SAVE) N.SAVE.best = 555;
          N.saveGame();
          var before = T.parsed();
          out.beforeBest = before ? before.best : null;
          var b64 = btoa(unescape(encodeURIComponent(JSON.stringify({ version: 999, best: 1 }))));
          var res = N.importSave(b64);
          out.ok = !!(res && res.ok === false);
          out.reason = (res && res.reason);
          out.reasonHasVersion = !!(res && typeof res.reason === 'string' && res.reason.indexOf('版本') >= 0);
          var after = T.parsed();
          out.afterBest = after ? after.best : null;
          out.memBest = (N.G ? N.G.best : 'no-G');
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      expect('5) 版本过高', [
        ['importSave 返回 ok:false', r.ok === true, r.ok],
        ['reason 含「版本」', r.reasonHasVersion === true, r.reason],
        ['本地存档未被覆盖（best 仍 555）', r.afterBest === 555, r.afterBest],
        ['内存态未被覆盖（G.best 仍 555）', r.memBest === 555, r.memBest]
      ]);
    });

    // ===== 6) 迁移链：缺函数 / 注入 / 抛错 / 无版本号 =====
    await step('6) 迁移链行为', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, out = {};
        try {
          var had = Object.prototype.hasOwnProperty.call(N.MIGRATIONS, 1);
          var orig = N.MIGRATIONS[1];
          out.hadPreexisting = had;
          if (had) delete N.MIGRATIONS[1];
          var m0 = N.migrateSave({ version: 0 });
          out.missingNull = (m0 === null);
          out.missingActual = (m0 === null) ? 'null' : JSON.stringify(m0);
          // 注入迁移 1：version 0 -> 1，并补默认字段
          N.MIGRATIONS[1] = function (d) {
            d.version = 1;
            if (d.best === undefined) d.best = 0;
            if (!d.meta) d.meta = { points: 0, totalEarned: 0, endlessWavesCleared: 0, unlocked: {}, initialModule: null };
            if (!d.stats) d.stats = { totalKills: 0, totalRuns: 0, totalPlayTime: 0 };
            return d;
          };
          var m1 = N.migrateSave({ version: 0, best: 5 });
          out.migrated = (m1 === null) ? 'null' : 'object';
          out.migratedVersion = m1 && m1.version;
          out.migratedBest = m1 && m1.best;
          // 迁移函数抛错 -> null
          var good = N.MIGRATIONS[1];
          N.MIGRATIONS[1] = function () { throw new Error('boom'); };
          var m2 = N.migrateSave({ version: 0 });
          out.throwNull = (m2 === null);
          // version 不是数字 -> 视为 1
          N.MIGRATIONS[1] = good;
          var m3 = N.migrateSave({ best: 42 });
          out.noVersion = (m3 === null) ? 'null' : 'object';
          out.noVersionVersion = m3 && m3.version;
          out.noVersionBest = m3 && m3.best;
          // 还原（不留下测试注入的迁移函数）
          if (had) N.MIGRATIONS[1] = orig; else delete N.MIGRATIONS[1];
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      const name = '6) 迁移链行为' + (r.hadPreexisting ? '（注意：MIGRATIONS[1] 原本已存在，已临时移除后测试）' : '');
      expect(name, [
        ['缺 MIGRATIONS[1] 时 migrateSave({version:0}) 返回 null', r.missingNull === true, r.missingActual],
        ['注入迁移后返回对象', r.migrated === 'object', r.migrated],
        ['迁移结果 version === 1', r.migratedVersion === 1, r.migratedVersion],
        ['迁移结果 best === 5', r.migratedBest === 5, r.migratedBest],
        ['迁移函数抛错时返回 null', r.throwNull === true, r.throwNull],
        ['version 非数字视为 1（返回对象）', r.noVersion === 'object', r.noVersion],
        ['非数字 version 结果 version === 1', r.noVersionVersion === 1, r.noVersionVersion]
      ]);
    });

    // ===== 7) 旧 key 兼容迁移（需要重新加载页面）=====
    await step('7) 旧 key 兼容迁移', async () => {
      await ev(`(function () {
        try {
          localStorage.removeItem('entropyTideSave');
          localStorage.setItem('neonArenaBest', '8888');
          localStorage.setItem('entropyTideMeta', JSON.stringify({ points: 3, totalEarned: 5, endlessWavesCleared: 9, unlocked: { A0: true }, initialModule: null }));
        } catch (e) {}
        return 1;
      })()`);
      await reload();
      const r = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        try {
          var res = N.loadGame();
          out.loadReturns = (res === null) ? 'null' : typeof res;
          out.best = (N.G ? N.G.best : 'no-G');
          out.points = T.meta('points');
          var u = T.meta('unlocked');
          out.unlockedA0 = (u && typeof u === 'object') ? u.A0 : 'no-unlocked';
          out.newKey = (T.raw() === null) ? 'null' : 'present';
          out.legacyBest = localStorage.getItem('neonArenaBest');
          out.legacyMeta = localStorage.getItem('entropyTideMeta');
          var p = T.parsed();
          out.diskBest = p ? p.best : null;
          out.diskVersion = p ? p.version : null;
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      expect('7) 旧 key 兼容迁移', [
        ['未抛异常', !r.err, r.err || 'none'],
        ['loadGame() 生效（非 null）', r.loadReturns === 'object', r.loadReturns],
        ['G.best === 8888', r.best === 8888, r.best],
        ['META.points === 3', r.points === 3, r.points],
        ['META.unlocked.A0 === true', r.unlockedA0 === true, r.unlockedA0],
        ['新 key entropyTideSave 已写入', r.newKey === 'present', r.newKey],
        ['旧 key neonArenaBest 已删除', r.legacyBest === null, r.legacyBest],
        ['旧 key entropyTideMeta 已删除', r.legacyMeta === null, r.legacyMeta],
        ['落盘 best === 8888', r.diskBest === 8888, r.diskBest]
      ]);
    });

    // ===== 8) 统计落盘（resetSave -> startGame）=====
    await step('8) 统计落盘与局数累计', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        try {
          var resetReturn = N.resetSave();
          out.resetReturn = (resetReturn === true);
          var s0 = N.saveSummary();
          var zeros = ['best', 'points', 'totalEarned', 'totalKills', 'totalRuns', 'totalPlayTime'];
          out.zeroBad = zeros.filter(function (k) { return s0[k] !== 0; }).map(function (k) { return k + '=' + s0[k]; });
          out.versionAfterReset = s0.version;
          var resetRaw = T.raw();
          out.resetDiskNull = (resetRaw === null);
          N.startGame();
          var s1 = N.saveSummary();
          out.runs = s1.totalRuns;
          out.runsOk = (typeof s1.totalRuns === 'number' && s1.totalRuns >= 1);
          var p = T.parsed();
          out.diskRuns = (p && p.stats) ? p.stats.totalRuns : null;
          out.diskRunsOk = (typeof out.diskRuns === 'number' && out.diskRuns >= 1);
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      expect('8) 统计落盘与局数累计', [
        ['未抛异常', !r.err, r.err || 'none'],
        ['resetSave() 返回 true', r.resetReturn === true, r.resetReturn],
        ['resetSave 后 localStorage 无存档', r.resetDiskNull === true, r.resetDiskNull],
        ['resetSave 后六项计数归零', r.zeroBad.length === 0, r.zeroBad.join(',') || 'all 0'],
        ['resetSave 后 version 仍为 SAVE_VERSION(1)', r.versionAfterReset === 1, r.versionAfterReset],
        ['startGame 后 saveSummary().totalRuns >= 1', r.runsOk === true, r.runs],
        ['localStorage.stats.totalRuns >= 1', r.diskRunsOk === true, r.diskRuns]
      ]);
    });

    // ===== 9) 统计字段类型 =====
    await step('9) saveSummary 字段类型', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, out = {};
        try {
          var s = N.saveSummary();
          var need = ['version', 'best', 'points', 'totalEarned', 'totalKills', 'totalRuns', 'totalPlayTime'];
          out.keys = Object.keys(s).join(',');
          out.missing = need.filter(function (k) { return !(k in s); });
          out.nonNum = need.filter(function (k) { return typeof s[k] !== 'number' || !isFinite(s[k]); });
          out.kills = s.totalKills;
          out.play = s.totalPlayTime;
          out.nonNeg = (typeof s.totalKills === 'number' && s.totalKills >= 0) &&
                       (typeof s.totalPlayTime === 'number' && s.totalPlayTime >= 0);
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      expect('9) saveSummary 字段类型', [
        ['七个字段齐全（' + r.keys + '）', r.missing.length === 0, r.missing.join(',') || 'none'],
        ['七个字段均为有限数字', r.nonNum.length === 0, r.nonNum.join(',') || 'none'],
        ['totalKills >= 0', typeof r.kills === 'number' && r.kills >= 0, r.kills],
        ['totalPlayTime >= 0', typeof r.play === 'number' && r.play >= 0, r.play]
      ]);
    });

    // ===== 10) 面板与关闭 =====
    await step('10) 存档面板显示与关闭', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        try {
          if (typeof N.showTitle === 'function') N.showTitle();
          N.showSaveScreen('title');
          var ov = document.getElementById('overlaySave');
          out.visible = !!ov && !ov.classList.contains('hidden');
          var sum = document.getElementById('saveSummary');
          out.summaryText = sum ? String(sum.textContent || '').slice(0, 120) : 'no-element';
          out.hasBestWord = !!sum && String(sum.textContent || '').indexOf('最高分') >= 0;
          T.mark();
          var b = document.getElementById('btnSaveClose');
          if (!b) throw new Error('缺少 #btnSaveClose');
          b.click();
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      await sleep(250);
      const after = await ev(`(function () {
        var T = window.__t;
        var t = document.getElementById('overlayTitle');
        var s = document.getElementById('overlaySave');
        return {
          titleVisible: !!t && !t.classList.contains('hidden'),
          saveHidden: !!s && s.classList.contains('hidden'),
          errs: T ? T.newErrs() : ['no-__t']
        };
      })()`);
      expect('10) 存档面板与关闭', [
        ['未抛异常', !r.err, r.err || 'none'],
        ['showSaveScreen 后 #overlaySave 可见（无 hidden）', r.visible === true, r.visible],
        ['#saveSummary 文本含「最高分」', r.hasBestWord === true, r.summaryText],
        ['点击 #btnSaveClose 后 #overlayTitle 可见', after.titleVisible === true, after.titleVisible],
        ['点击关闭未产生未捕获错误', after.errs.length === 0, after.errs.join(' | ') || 'none']
      ]);
    });

    // ===== 11) 暂停页入口 =====
    await step('11) 暂停页入口 #btnSavePause', async () => {
      await ev(`(function () {
        var N = window.__neon || {};
        try { N.startGame(); } catch (e) {}
        return 1;
      })()`);
      await sleep(400);
      await ev(`(function () {
        try { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); } catch (e) {}
        return 1;
      })()`);
      await sleep(250);
      const pauseOpen = await ev(`(function () {
        var p = document.getElementById('overlayPause');
        return !!p && !p.classList.contains('hidden');
      })()`);
      const r = await ev(`(function () {
        var T = window.__t, out = {};
        var b = document.getElementById('btnSavePause');
        out.exists = !!b;
        T.mark();
        try { if (b) b.click(); } catch (e) { out.threw = String((e && e.message) || e); }
        return out;
      })()`);
      await sleep(300);
      const after = await ev(`(function () {
        var T = window.__t;
        var s = document.getElementById('overlaySave');
        return { errs: T ? T.newErrs() : ['no-__t'], saveVisible: !!s && !s.classList.contains('hidden') };
      })()`);
      console.log('   · 暂停面板可见=' + pauseOpen + '，点击后存档面板可见=' + after.saveVisible);
      expect('11) 暂停页入口 #btnSavePause', [
        ['#btnSavePause 存在', r.exists === true, r.exists],
        ['点击未同步抛错', !r.threw, r.threw || 'none'],
        ['点击未产生未捕获错误', after.errs.length === 0, after.errs.join(' | ') || 'none']
      ]);
    });

    // ===== 12) 导入覆盖二次确认 =====
    await step('12) 导入覆盖二次确认', async () => {
      const prep = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        try {
          if (N.G) N.G.best = 24680;
          if (N.SAVE) N.SAVE.best = 24680;
          N.saveGame();
          out.b64 = N.exportSave();
          if (N.G) N.G.best = 777;
          if (N.SAVE) N.SAVE.best = 777;
          N.saveGame();
          var p = T.parsed();
          out.localBest = p ? p.best : null;
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      if (prep.err || typeof prep.b64 !== 'string' || !prep.b64) {
        fail('12) 导入覆盖二次确认', '前置准备失败: ' + (prep.err || 'exportSave() 未返回字符串'));
        return;
      }
      console.log('   · 本地档 best=' + prep.localBest + '，待导入档 best=24680');
      const fill = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        try {
          N.showSaveScreen('title');
          var box = document.getElementById('saveImportBox');
          if (!box) throw new Error('缺少 #saveImportBox');
          box.value = ${JSON.stringify(prep.b64)};
          T.mark();
          var btn = document.getElementById('btnSaveImport');
          if (!btn) throw new Error('缺少 #btnSaveImport');
          btn.click();
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      await sleep(300);
      const confirm = await ev(`(function () {
        var T = window.__t, c = document.getElementById('overlayConfirm'), ct = document.getElementById('confirmText'), out = {};
        out.visible = !!c && !c.classList.contains('hidden');
        out.text = ct ? String(ct.textContent || '').slice(0, 160) : 'no-element';
        out.hasOverwrite = !!ct && String(ct.textContent || '').indexOf('覆盖') >= 0;
        out.errs = T ? T.newErrs() : ['no-__t'];
        return out;
      })()`);
      const yes = await ev(`(function () {
        var out = {};
        try {
          var b = document.getElementById('btnConfirmYes');
          if (!b) throw new Error('缺少 #btnConfirmYes');
          b.click();
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      await sleep(300);
      const after = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        out.best = (N.G ? N.G.best : 'no-G');
        var p = T.parsed();
        out.diskBest = p ? p.best : null;
        return out;
      })()`);
      expect('12) 导入覆盖二次确认', [
        ['填写 + 点击 #btnSaveImport 未抛错', !fill.err, fill.err || 'none'],
        ['#overlayConfirm 出现', confirm.visible === true, confirm.visible],
        ['#confirmText 含「覆盖」', confirm.hasOverwrite === true, confirm.text],
        ['点击 #btnConfirmYes 未抛错', !yes.err, yes.err || 'none'],
        ['导入生效：G.best === 24680', after.best === 24680, after.best],
        ['已写入 localStorage：best === 24680', after.diskBest === 24680, after.diskBest]
      ]);
    });

    // ===== 13) 重置二次确认 =====
    await step('13) 重置二次确认', async () => {
      const before = await ev(`(function () {
        var N = window.__neon || {};
        try {
          if (N.G) N.G.best = 999;
          if (N.SAVE) N.SAVE.best = 999;
          N.saveGame();
          N.showSaveScreen('title');
        } catch (e) {}
        var r = localStorage.getItem('entropyTideSave');
        return r === null ? 'null' : 'present';
      })()`);
      await sleep(200);
      const clickReset = await ev(`(function () {
        var out = {};
        try {
          var b = document.getElementById('btnSaveReset');
          if (!b) throw new Error('缺少 #btnSaveReset');
          b.click();
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      await sleep(300);
      const confirm = await ev(`(function () {
        var c = document.getElementById('overlayConfirm');
        return { visible: !!c && !c.classList.contains('hidden') };
      })()`);
      const clickYes = await ev(`(function () {
        var out = {};
        try {
          var b = document.getElementById('btnConfirmYes');
          if (!b) throw new Error('缺少 #btnConfirmYes');
          b.click();
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      await sleep(300);
      const after = await ev(`(function () {
        var N = window.__neon || {};
        return {
          raw: localStorage.getItem('entropyTideSave') === null ? 'null' : 'present',
          best: (N.G ? N.G.best : 'no-G')
        };
      })()`);
      expect('13) 重置二次确认', [
        ['前置：本地已有存档', before === 'present', before],
        ['点击 #btnSaveReset 未抛错', !clickReset.err, clickReset.err || 'none'],
        ['#overlayConfirm 出现', confirm.visible === true, confirm.visible],
        ['点击 #btnConfirmYes 未抛错', !clickYes.err, clickYes.err || 'none'],
        ['localStorage 中存档已移除', after.raw === 'null', after.raw],
        ['G.best === 0', after.best === 0, after.best]
      ]);
    });

    // ===== 14) 刷新持久化 =====
    await step('14) 刷新后持久化', async () => {
      const prep = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        try {
          if (typeof N.showTitle === 'function') N.showTitle();   // 清掉本局，避免「本局增量折算」覆盖刻意写入的统计
          if (N.G) N.G.best = 4321;
          if (N.SAVE) N.SAVE.best = 4321;
          T.setStats('totalKills', 77);
          T.setStats('totalRuns', 11);
          T.setStats('totalPlayTime', 1234);
          N.saveGame();
          var p = T.parsed();
          out.diskBest = p ? p.best : null;
          out.diskKills = (p && p.stats) ? p.stats.totalKills : null;
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      console.log('   · 刷新前落盘 best=' + prep.diskBest + ' totalKills=' + prep.diskKills);
      await reload();
      const r = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        out.best = (N.G ? N.G.best : 'no-G');
        var s = N.SAVE && N.SAVE.stats;
        out.hasStats = !!s && typeof s === 'object';
        out.kills = s ? s.totalKills : null;
        out.runs = s ? s.totalRuns : null;
        out.play = s ? s.totalPlayTime : null;
        out.tKills = T ? T.stats('totalKills') : null;
        return out;
      })()`);
      expect('14) 刷新后持久化', [
        ['刷新前样本写入正确', prep.diskBest === 4321 && prep.diskKills === 77, prep.diskBest + '/' + prep.diskKills],
        ['刷新后 G.best === 4321', r.best === 4321, r.best],
        ['刷新后 SAVE.stats 仍是对象', r.hasStats === true, r.hasStats],
        ['SAVE.stats.totalKills === 77', r.kills === 77, r.kills],
        ['SAVE.stats.totalRuns === 11', r.runs === 11, r.runs],
        ['SAVE.stats.totalPlayTime === 1234', r.play === 1234, r.play]
      ]);
    });

    // ===== 15) key 唯一性 =====
    await step('15) 单一 key 唯一性', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, out = {};
        try { N.saveGame(); } catch (e) { out.err = String((e && e.message) || e); }
        out.legacyBest = localStorage.getItem('neonArenaBest');
        out.legacyMeta = localStorage.getItem('entropyTideMeta');
        out.newKey = localStorage.getItem('entropyTideSave') === null ? 'null' : 'present';
        out.legacyKeysCfg = Array.isArray(N.LEGACY_KEYS) ? N.LEGACY_KEYS.join(',') : String(N.LEGACY_KEYS);
        return out;
      })()`);
      expect('15) 单一 key 唯一性', [
        ['saveGame() 后 neonArenaBest 为 null', r.legacyBest === null, r.legacyBest],
        ['saveGame() 后 entropyTideMeta 为 null', r.legacyMeta === null, r.legacyMeta],
        ['entropyTideSave 存在', r.newKey === 'present', r.newKey]
      ]);
    });

    // ===== 17) 文件通道降级检查 =====
    await step('17) 文件通道降级（仅存在性 + 不抛错）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, out = {};
        var d = document.getElementById('btnSaveDownload');
        var f = document.getElementById('btnSaveImportFile');
        out.domOk = !!d && !!f;
        try {
          N.showSaveScreen('title');
          var box = document.getElementById('saveExportBox');
          if (box) box.value = N.exportSave();          // 让下载按钮有内容可读
        } catch (e) {}
        T.mark();
        try { if (d) d.click(); } catch (e) { out.dlThrew = String((e && e.message) || e); }
        try { if (f) f.click(); } catch (e) { out.impThrew = String((e && e.message) || e); }
        return out;
      })()`);
      await sleep(400);
      const after = await ev(`(function () {
        var T = window.__t;
        return { errs: T ? T.newErrs() : ['no-__t'] };
      })()`);
      expect('17) 文件通道降级', [
        ['#btnSaveDownload / #btnSaveImportFile 存在', r.domOk === true, r.domOk],
        ['点击两个按钮均未同步抛错', !r.dlThrew && !r.impThrew, (r.dlThrew || r.impThrew || 'none')],
        ['点击未产生未捕获错误', after.errs.length === 0, after.errs.join(' | ') || 'none']
      ]);
    });
  } catch (e) {
    fail('运行环境 / CDP', (e && e.stack) || String(e));
  }

  try {
    // ===== 18) 复制按钮：真实点击 + Clipboard API 被拒绝时必须回退 execCommand =====
    //  复现并锁死用户实测的缺陷：以前不处理 writeText() 的 Promise 拒绝，
    //  会弹「已复制到剪贴板」但剪贴板其实是空的。
    await step('18) 复制按钮回退链（真实点击）', async () => {
      const T0 = Date.now();
      const tick = s => console.log('   · ' + s + '（+' + (Date.now() - T0) + 'ms）');
      async function realClick(id) {
        const pos = await ev(`(function () {
          var el = document.getElementById('${id}');
          if (!el) return null;
          try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
          var r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        if (!pos) return false;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none' });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
        return true;
      }
      const READ_POPUPS = `(function () {
        var N = window.__neon || {}, S = window.__copyStats || {}, T = window.__t;
        var arr = (N.G && N.G.popups) || [];
        var txt = arr.map(function (p) { return String(p && p.t !== undefined ? p.t : ((p && p.text) || '')); }).join(' | ');
        return { rejected: S.rejected || 0, execCalls: S.execCalls || 0, popups: txt, errs: T ? T.newErrs() : [] };
      })()`;

      // 准备：生成存档串；把 Clipboard API 打桩成「一律拒绝」，并统计 execCommand 调用
      const prep = await ev(`(function () {
        var N = window.__neon || {}, out = {};
        N.showSaveScreen('title');
        document.getElementById('btnSaveExport').click();
        var box = document.getElementById('saveExportBox');
        out.len = box ? box.value.length : 0;
        out.hadClipboard = !!(navigator.clipboard && navigator.clipboard.writeText);
        window.__copyStats = { rejected: 0, execCalls: 0, execResult: true };
        try {
          window.__origWriteText = navigator.clipboard ? navigator.clipboard.writeText : null;
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: function () {
              window.__copyStats.rejected++;
              return Promise.reject(new Error('NotAllowedError'));
            } }
          });
          out.clipStubbed = true;
        } catch (e) { out.clipStubErr = String((e && e.message) || e); }
        try {
          window.__origExecCommand = document.execCommand;
          document.execCommand = function (c) {
            if (c === 'copy') { window.__copyStats.execCalls++; return window.__copyStats.execResult; }
            return window.__origExecCommand ? window.__origExecCommand.apply(document, arguments) : false;
          };
          out.execStubbed = true;
        } catch (e) { out.execStubErr = String((e && e.message) || e); }
        if (N.G) N.G.popups.length = 0;
        window.__t.mark();
        return out;
      })()`);

      const clicked = await realClick('btnSaveCopy');
      tick('真实点击 #btnSaveCopy 完成=' + clicked);
      await sleep(600);
      const r1 = await ev(READ_POPUPS);
      tick('第一轮读数完成 rejected=' + r1.rejected + ' execCalls=' + r1.execCalls);

      // 第二轮：execCommand 也失败 —— 必须如实提示失败，不能谎报「已复制」
      await ev(`(function () {
        window.__copyStats.execResult = false;
        window.__copyStats.execCalls = 0;
        window.__copyStats.rejected = 0;
        if (window.__neon && window.__neon.G) window.__neon.G.popups.length = 0;
        window.__t.mark();
        return 1;
      })()`);
      await realClick('btnSaveCopy');
      await sleep(600);
      const r2 = await ev(READ_POPUPS);

      // 第三轮：点一下导出框，应当自动全选，方便手动 Ctrl+C
      await realClick('saveExportBox');
      await sleep(300);
      const r3 = await ev(`(function () {
        var box = document.getElementById('saveExportBox');
        return { s: box.selectionStart, e: box.selectionEnd, len: box.value.length };
      })()`);

      // 收尾：还原打桩（本项是最后一项，仍还原以免将来调整顺序时踩坑）
      await ev(`(function () {
        try {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: window.__origWriteText ? { writeText: window.__origWriteText } : undefined
          });
        } catch (e) {}
        if (window.__origExecCommand) document.execCommand = window.__origExecCommand;
        return 1;
      })()`);

      console.log('   · 打桩环境：原 Clipboard API 存在=' + prep.hadClipboard +
        ' · 第一轮 rejected=' + r1.rejected + ' execCalls=' + r1.execCalls +
        ' · 第二轮 execCalls=' + r2.execCalls);
      expect('18) 复制回退链', [
        ['导出框已生成存档串（>20 字符）', prep.len > 20, prep.len],
        ['Clipboard API 打桩成功', prep.clipStubbed === true, prep.clipStubErr || 'ok'],
        ['execCommand 打桩成功', prep.execStubbed === true, prep.execStubErr || 'ok'],
        ['真实点击 #btnSaveCopy 生效', clicked === true, clicked],
        ['Clipboard API 确实被调用', r1.rejected >= 1, r1.rejected],
        ['Promise 被拒绝后回退 execCommand', r1.execCalls >= 1, r1.execCalls],
        ['execCommand 成功时提示「已复制到剪贴板」', /已复制到剪贴板/.test(r1.popups), r1.popups.slice(0, 120) || '(无提示)'],
        ['第一轮无未捕获异常', r1.errs.length === 0, r1.errs.join(' | ') || 'none'],
        ['全部失败时提示失败而非谎报成功', /复制失败/.test(r2.popups) && !/已复制到剪贴板/.test(r2.popups), r2.popups.slice(0, 120) || '(无提示)'],
        ['第二轮仍走过 execCommand', r2.execCalls >= 1, r2.execCalls],
        ['点击导出框自动全选', r3.s === 0 && r3.e === r3.len && r3.len > 0, r3.s + '/' + r3.e + ' len=' + r3.len]
      ]);
    });
  } catch (e) {
    fail('运行环境 / CDP', (e && e.stack) || String(e));
  } finally {
    if (cdp) cdp.close();
    if (chrome) chrome.kill();
    await sleep(600);
    rmrf(PROFILE);
  }

  // ===== 结果汇总 =====
  console.log('\n================ v1.7 存档系统验收结果 ================');
  console.log('PASS ' + PASSED.length + ' / FAIL ' + FAILED.length + '（共 ' + (PASSED.length + FAILED.length) + ' 项）');
  if (pageErrors.length) {
    console.log('\n[WARN] 页面未处理异常 ' + pageErrors.length + ' 条（不计入 FAIL，仅供排查）：');
    pageErrors.slice(0, 5).forEach(e => console.log('   ! ' + String(e).split('\n')[0]));
  } else {
    console.log('页面无未处理异常');
  }
  if (FAILED.length) {
    console.log('\n失败清单：');
    FAILED.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    process.exit(1);
  }
  console.log('\n全部通过 ✅');
  process.exit(0);
})();
