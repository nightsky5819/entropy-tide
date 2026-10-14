// ============================================================
//  v1.8「武器 / 攻击方式变异」真机验收脚本（r11-check.js）
//  · 零第三方依赖：Node 标准库 + CDP over 内置 WebSocket，驱动真实 Chrome
//  · 调试端口 9348（r9 用 9346、r10 用 9347，避免冲突），独立临时 profile：dev/.chrome-r11
//  · 被测入口 window.__neon（WEAPON_MUTATIONS / WEAPON_CONFLICTS / WEAPON_EXCLUSIVE /
//    upgradeBlocked / drawUpgradeOptions / renderUpgradeCards / chooseUpgrade /
//    applyUpgrade / undoUpgrade / removeTakenById / fire / updateBullets / updateEnemies /
//    step / spawnEnemy / explode / damageEnemy / UPG / CAT_INFO）
//  · 只读 index.html，不修改任何被测文件；退出码 0=全通过，1=有 FAIL
//  · 不写任何中间文件与截图；收尾 kill Chrome 并删除临时 profile
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
const PORT = 9348;
const PROFILE = path.join(DEV_DIR, '.chrome-r11');
const URL_FILE = 'file:///' + GAME_FILE.replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 14 张变异卡 → 玩家字段（Node 侧独立维护一份，避免"用被测数据验证被测数据"）
const MUT_FIELD = {
  boomerang: 'mutBoomerang',
  split_shot: 'mutSplitShot',
  bounce: 'mutBounce',
  linger: 'mutLinger',
  chain: 'mutChain',
  pierce_plus: 'mutPiercePlus',
  burst: 'mutBurst',
  homing_light: 'mutHomingLight',
  impact: 'mutImpact',
  corrode: 'mutCorrode',
  vampire: 'mutVampire',
  twin: 'mutTwin',
  orbit: 'mutOrbit',
  delay: 'mutDelay'
};
const MUT_IDS = Object.keys(MUT_FIELD);
// 契约里声明的冲突对（用于校验实现，而不是从实现里读回来）
const WANT_CONFLICTS = [
  ['boomerang', 'bounce'],
  ['linger', 'chain'],
  ['delay', 'corrode'],
  ['homing_light', 'homing'],
  ['twin', 'proj']
];

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
//  CDP 客户端（风格与 r10-check.js 一致）
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
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
//  页面内测试助手 window.__t
//  · 错误收集：window error / unhandledrejection
//  · arena()：把一局游戏压到"确定的空白战场"——
//      固定职业 / 模式 / 难度，清空敌人与所有实体，waveState='idle'（不触发波次结算与升级），
//      玩家血量与无敌时间拉满，避免测试因页面残留状态（上一轮的敌人、波次、升级弹窗）而抖动。
//      这样后续每一项都从同一个已知起点出发，不依赖页面内部初始状态。
//  · mkBullet / mkEnemy：构造契约里描述的子弹对象与高血量敌人
// ------------------------------------------------------------
const HELPERS = `
window.__t = (function () {
  function N() { return window.__neon || {}; }
  var INIT = {
    mutBoomerang: false, mutSplitShot: false, mutBounce: 0, mutLinger: false, mutChain: false,
    mutPiercePlus: 0, mutBurst: 0, mutHomingLight: 0, mutImpact: 0, mutCorrode: 0, mutVampire: 0,
    mutTwin: 0, mutOrbit: 0, mutDelay: false
  };
  return {
    N: N,
    init: INIT,
    MUT_FIELD: ${JSON.stringify(MUT_FIELD)},
    raw: function () { try { return localStorage.getItem('entropyTideSave'); } catch (e) { return null; } },
    errs: [],
    watchErrors: function () {
      var self = this;
      if (self.__watched) return;
      self.__watched = 1;
      window.addEventListener('error', function (e) { self.errs.push(String((e && e.message) || e)); });
      window.addEventListener('unhandledrejection', function (e) { self.errs.push('rejection:' + String(e && e.reason)); });
    },
    mark: function () { this.__n = this.errs.length; return this.__n; },
    newErrs: function () { return this.errs.slice(this.__n || 0); },
    // 确定的空白战场
    arena: function () {
      var n = N();
      n.G.cls = 'vanguard'; n.G.mode = 'endless'; n.G.diff = 'normal';
      n.startGame();
      var p = n.G.p;
      n.G.bullets.length = 0; n.G.ebullets.length = 0; n.G.enemies.length = 0;
      n.G.parts.length = 0; n.G.dmgs.length = 0; n.G.popups.length = 0;
      n.G.spawnQ.length = 0; n.G.waveState = 'idle'; n.G.waveDelay = 0;
      n.G.deadT = 0; n.G.hitstop = 0;
      if (n.G.grid) n.G.grid.clear();
      p.hp = 1e6; p.maxHp = 1e6; p.inv = 1e6;
      return p;
    },
    mkBullet: function (x, y, vx, vy, dmg) {
      return {
        x: x, y: y, vx: vx, vy: vy, r: 5, dmg: dmg, baseDmg: dmg, pierce: 0,
        life: 1.5, maxLife: 1.5, hit: [], col: '#8ff6ff', homing: 0, trail: [], bounces: 0
      };
    },
    mkEnemy: function (type, x, y) {
      var n = N();
      var e = n.spawnEnemy(type, x, y);
      if (e) { e.hp = 1e6; e.maxHp = 1e6; e.spawnT = 0; }
      return e;
    }
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
  let pendingLoad = null;

  function nextLoad() {
    return new Promise(res => {
      const timer = setTimeout(() => { if (pendingLoad && pendingLoad.res === res) pendingLoad = null; res(); }, 20000);
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

  // ===== 9) 单文件零外部资源（Node 侧文本校验，Chrome 之前先跑）=====
  await step('9) 单文件零外部资源（index.html 文本校验）', async () => {
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
    expect('9) 单文件零外部资源', [
      ['不得出现 <script src= / <link href= / <img src=', hits.length === 0, hits.join(' | ') || 'none']
    ]);
  });

  // ===== 启动真实 Chrome =====
  if (!fs.existsSync(CHROME)) { fail('环境', '找不到 Chrome: ' + CHROME); }
  if (!PROFILE.endsWith('.chrome-r11')) { console.error('FAIL: 临时目录路径异常 ' + PROFILE); process.exit(1); }
  rmrf(PROFILE);                      // 每次从干净 profile 起跑，保证 localStorage 起点确定
  console.log('   · Chrome profile: ' + PROFILE);

  try {
    chrome = spawn(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
      '--disable-breakpad', '--no-first-run', '--hide-scrollbars', '--mute-audio',
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
    };
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const wait = nextLoad();
    await cdp.send('Page.navigate', { url: URL_FILE });
    const ready = await waitFor('typeof window.__neon === "object" && !!window.__neon.G', 25000);
    await wait;
    await sleep(400);
    await ev(HELPERS);
    if (!ready) fail('0) 页面初始化', '25s 内未等到 window.__neon');

    // ===== 0) 契约成员与玩家字段存在性 =====
    await step('0) v1.8 契约成员与玩家变异字段存在性', async () => {
      const pres = await ev(`(function () {
        var N = window.__neon || {}, T = window.__t, missing = [];
        function F(f) { if (typeof N[f] !== 'function') missing.push('__neon.' + f + ' 不是函数'); }
        ['upgradeBlocked', 'applyUpgrade', 'undoUpgrade', 'removeTakenById', 'drawUpgradeOptions',
         'renderUpgradeCards', 'chooseUpgrade', 'fire', 'updateBullets', 'updateEnemies', 'step',
         'spawnEnemy', 'explode', 'damageEnemy'].forEach(F);
        if (!Array.isArray(N.WEAPON_MUTATIONS)) missing.push('WEAPON_MUTATIONS 不是数组');
        if (!Array.isArray(N.WEAPON_CONFLICTS)) missing.push('WEAPON_CONFLICTS 不是数组');
        if (!Array.isArray(N.WEAPON_EXCLUSIVE)) missing.push('WEAPON_EXCLUSIVE 不是数组');
        if (!Array.isArray(N.UPG)) missing.push('UPG 不是数组');
        if (!N.CAT_INFO || !N.CAT_INFO.weapon) missing.push('CAT_INFO.weapon 缺失');
        var p = T.arena();
        var fl = Object.keys(T.init);
        var missField = fl.filter(function (f) { return !(f in p); });
        var dom = ['cards', 'overlayTitle'].filter(function (i) { return !document.getElementById(i); });
        return { missing: missing, missField: missField, dom: dom, nField: fl.length };
      })()`);
      expect('0) 契约成员与玩家变异字段存在性', [
        ['API 成员全部存在', pres.missing.length === 0, pres.missing.join(' / ') || 'none'],
        ['14 个 mut* 玩家字段全部初始化（共 ' + pres.nField + '）', pres.missField.length === 0, pres.missField.join(',') || 'none'],
        ['#cards / #overlayTitle 存在', pres.dom.length === 0, pres.dom.join(',') || 'none']
      ]);
    });

    // ===== 1) 卡表 =====
    await step('1) 武器变异卡表（14 张 / 并入 UPG / tier≤3 / id 唯一 / fn 为函数）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, M = N.WEAPON_MUTATIONS, out = {};
        out.isArr = Array.isArray(M);
        out.n = M ? M.length : -1;
        out.weaponInUpg = N.UPG.filter(function (u) { return u.cat === 'weapon'; }).length;
        out.upgTotal = N.UPG.length;
        var bad = [], ids = {};
        for (var i = 0; i < M.length; i++) {
          var u = M[i];
          if (!u || typeof u !== 'object') { bad.push('#' + i + ' 非对象'); continue; }
          if (typeof u.id !== 'string' || !u.id) bad.push('#' + i + ' id 非法');
          if (typeof u.ico !== 'string' || !u.ico) bad.push(u.id + ' ico 非法');
          if (typeof u.nm !== 'string' || !u.nm) bad.push(u.id + ' nm 非法');
          if (typeof u.ds !== 'string' || !u.ds) bad.push(u.id + ' ds 非法');
          if (u.cat !== 'weapon') bad.push(u.id + ' cat=' + u.cat);
          if (typeof u.tier !== 'number' || !(u.tier <= 3)) bad.push(u.id + ' tier=' + u.tier);
          if (typeof u.max !== 'number' || !(u.max >= 1)) bad.push(u.id + ' max=' + u.max);
          if (!(u.rep === 0 || u.rep === 1)) bad.push(u.id + ' rep=' + u.rep);
          if (typeof u.fn !== 'function') bad.push(u.id + ' fn 非函数');
          if (ids[u.id]) bad.push('重复 id ' + u.id);
          ids[u.id] = 1;
        }
        out.bad = bad;
        out.ids = Object.keys(ids);
        out.notSameRef = M.filter(function (u) { return N.UPG.indexOf(u) < 0; }).map(function (u) { return u.id; });
        return out;
      })()`);
      const wanted = MUT_IDS.slice().sort().join(',');
      const got = (r.ids || []).slice().sort().join(',');
      console.log('   · UPG 总数 ' + r.upgTotal + '，其中 cat=weapon ' + r.weaponInUpg + ' 张');
      expect('1) 武器变异卡表', [
        ['WEAPON_MUTATIONS 是数组且长度 14', r.isArr === true && r.n === 14, r.n],
        ['UPG 中 cat===weapon 的卡为 14 张', r.weaponInUpg === 14, r.weaponInUpg],
        ['UPG 总数为 37（原 23 + 变异 14）', r.upgTotal === 37, r.upgTotal],
        ['14 张卡的 id 与契约一致', got === wanted, got],
        ['tier≤3 / id 唯一 / fn 为函数 / cat 均为 weapon', r.bad.length === 0, r.bad.join('；') || 'none'],
        ['14 张卡都是 UPG 中的同一对象引用', r.notSameRef.length === 0, r.notSameRef.join(',') || 'none']
      ]);
    });

    // ===== 2) 冲突表与类目上限完整性 =====
    await step('2) 冲突表 / 类目上限完整性（含普通卡 homing / proj）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, out = {};
        out.conflicts = (N.WEAPON_CONFLICTS || []).map(function (c) { return [c[0], c[1]]; });
        out.n = (N.WEAPON_CONFLICTS || []).length;
        var ids = {};
        for (var i = 0; i < N.UPG.length; i++) ids[N.UPG[i].id] = 1;
        var missing = [];
        for (var j = 0; j < (N.WEAPON_CONFLICTS || []).length; j++) {
          var cf = N.WEAPON_CONFLICTS[j];
          if (!ids[cf[0]]) missing.push(cf[0] + ' 不在 UPG');
          if (!ids[cf[1]]) missing.push(cf[1] + ' 不在 UPG');
        }
        out.missing = missing;
        var ex = N.WEAPON_EXCLUSIVE;
        out.exIsArr = Array.isArray(ex);
        out.exLen = out.exIsArr ? ex.length : -1;
        out.exGroups = out.exIsArr ? ex.map(function (g) {
          return (g.ids || []).slice().sort().join(',') + '@' + g.max;
        }) : [];
        var exMissing = [];
        if (out.exIsArr) ex.forEach(function (g) { (g.ids || []).forEach(function (id) { if (!ids[id]) exMissing.push(id); }); });
        out.exMissing = exMissing;
        var ci = (N.CAT_INFO && N.CAT_INFO.weapon) || {};
        out.cat = { nm: ci.nm, col: ci.col, ico: ci.ico };
        return out;
      })()`);
      const norm = arr => arr.map(c => c.slice().sort().join('|')).sort().join(' ');
      const gotC = norm(r.conflicts || []);
      const wantC = norm(WANT_CONFLICTS);
      const wantEx = ['boomerang,bounce,linger@2', 'delay,orbit,twin@1'];   // 组内 id 按字典序（与页面侧排序一致）
      console.log('   · 实测冲突对：' + gotC);
      expect('2) 冲突表 / 类目上限完整性', [
        ['WEAPON_CONFLICTS 为 5 组且与契约一致', r.n === 5 && gotC === wantC, gotC],
        ['每一对的两个 id 都存在于 UPG（含 homing / proj）', r.missing.length === 0, r.missing.join(',') || 'none'],
        ['WEAPON_EXCLUSIVE = 2 组，ids@max 与契约一致', r.exIsArr === true && r.exLen === 2 && r.exGroups.join(' ') === wantEx.join(' '), r.exGroups.join(' ')],
        ['类目上限里的 id 都存在于 UPG', r.exMissing.length === 0, r.exMissing.join(',') || 'none'],
        ['CAT_INFO.weapon = {nm:变异, col:#c07dff, ico:⁂}', r.cat.nm === '变异' && r.cat.col === '#c07dff' && r.cat.ico === '⁂',
          JSON.stringify(r.cat)]
      ]);
    });

    // ===== 3) 抽取过滤（真机路径：真实 startGame + drawUpgradeOptions 循环采样）=====
    await step('3) 抽取过滤（真实 drawUpgradeOptions 循环采样，每场景 40 轮 × 4 张）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, out = [];
        var sc = [
          { name: 'taken=[boomerang] 不应出现 bounce', taken: ['boomerang'], forbid: ['bounce'] },
          { name: 'taken=[bounce] 不应出现 boomerang', taken: ['bounce'], forbid: ['boomerang'] },
          { name: 'taken=[twin] 不应出现 orbit/delay', taken: ['twin'], forbid: ['orbit', 'delay'] },
          { name: 'taken=[boomerang,linger] 不应出现 bounce', taken: ['boomerang', 'linger'], forbid: ['bounce'] },
          { name: 'taken=[homing_light] 不应出现 homing', taken: ['homing_light'], forbid: ['homing'] },
          { name: 'taken=[proj] 不应出现 twin', taken: ['proj'], forbid: ['twin'] }
        ];
        var ROUNDS = 40;
        for (var s = 0; s < sc.length; s++) {
          var scen = sc[s], hits = {}, drew = 0, err = null;
          try {
            for (var r = 0; r < ROUNDS; r++) {
              N.startGame();
              var p = N.G.p;
              p.taken = scen.taken.slice();
              N.G.wave = 20;                      // 解锁全部品质门槛，让 14 张变异卡都有机会被抽到
              var opts = N.drawUpgradeOptions(p, 4);
              drew += opts.length;
              for (var i = 0; i < opts.length; i++) {
                var u = opts[i];
                if (u && scen.forbid.indexOf(u.id) >= 0) hits[u.id] = (hits[u.id] || 0) + 1;
              }
            }
          } catch (e) { err = String((e && e.message) || e); }
          var bad = [];
          for (var k in hits) bad.push(k + '×' + hits[k]);
          out.push({ name: scen.name, bad: bad, drew: drew, want: ROUNDS * 4, err: err });
        }
        return out;
      })()`);
      const conds = [['六个场景都真实跑完 40 轮', (r || []).length === 6, (r || []).length]];
      for (const s of (r || [])) {
        if (!s) { conds.push(['场景缺失', false, 'null']); continue; }
        const drewOk = s.drew === s.want;
        const noHit = s.bad.length === 0;
        console.log('   · ' + s.name + '：抽到 ' + s.drew + ' 张，违禁命中 ' + (s.bad.join(',') || '无'));
        conds.push([s.name + (drewOk ? '' : ' [抽取次数异常 ' + s.drew + '/' + s.want + ']'),
          drewOk && noHit && !s.err, (s.err || s.bad.join(',') || 'clean')]);
      }
      expect('3) 抽取过滤（冲突对 / 类目上限）', conds);
    });

    // ===== 4) 卡面「变异」标签 =====
    await step('4) 卡面「变异」标签（DOM #cards > .card > .tags > .tag.cat）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, T = window.__t;
        T.arena();
        N.G.options = N.WEAPON_MUTATIONS.slice(0, 3);
        N.renderUpgradeCards();
        var cards = document.querySelectorAll('#cards > .card');
        var info = [];
        for (var i = 0; i < cards.length; i++) {
          var c = cards[i];
          var tag = c.querySelector('.tags .tag.cat');
          var nmEl = c.querySelector('.nm');
          info.push({
            txt: tag ? String(tag.textContent || '') : null,
            col: tag ? String(tag.style.color || '') : null,
            nm: nmEl ? String(nmEl.textContent || '') : null
          });
        }
        return { count: cards.length, info: info };
      })()`);
      const normCol = c => String(c || '').toLowerCase().replace(/\s+/g, '');
      const colOk = v => v === '#c07dff' || v === 'rgb(192,125,255)';
      const bad = (r.info || []).filter(t => !(t.txt && t.txt.indexOf('变异') >= 0) || !colOk(normCol(t.col)));
      console.log('   · 3 张卡的类别标签：' + (r.info || []).map(t => (t.nm || '?') + '/' + t.txt + '/' + t.col).join(' · '));
      expect('4) 卡面「变异」标签', [
        ['#cards 内渲染出 3 张 .card', r.count === 3, r.count],
        ['每张卡都有 .tags > .tag.cat', (r.info || []).length === 3 && (r.info || []).every(t => t.txt !== null), (r.info || []).length],
        ['标签文本含「变异」', (r.info || []).every(t => t.txt && t.txt.indexOf('变异') >= 0), (r.info || []).map(t => t.txt).join(',')],
        ['标签颜色为 #c07dff（或 rgb(192, 125, 255)）', bad.length === 0, (r.info || []).map(t => t.col).join(',')]
      ]);
    });

    // ===== 5) 真实战斗里逐张应用 14 张变异不崩 =====
    await step('5) 真实战斗里逐张应用 14 张变异（各 180 帧 · 真子弹 · 真敌人）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, T = window.__t, M = N.WEAPON_MUTATIONS, res = {};
        for (var i = 0; i < M.length; i++) {
          var card = M[i], id = card.id, f = T.MUT_FIELD[id];
          var o = { id: id, field: f };
          try {
            var p = T.arena();
            N.applyUpgrade(p, card);
            p.hp = 1e6; p.maxHp = 1e6; p.inv = 1e6;
            // 让波次一直处于"出兵中"，波次不会结算 → G.state 不会被升级面板抢走，
            // 同时场上会有真实敌人与真实子弹碰撞（不伪造战斗）。
            N.G.spawnQ.length = 0;
            for (var q = 0; q < 80; q++) N.G.spawnQ.push('tank');
            N.G.waveState = 'spawning'; N.G.spawnT = 0.05;
            var st0 = N.G.state;
            T.mark();
            for (var fr = 0; fr < 180; fr++) {
              if (fr % 30 === 0) N.fire();
              N.step(1 / 60);
            }
            o.state0 = st0;
            o.state = N.G.state;
            o.stateOk = (N.G.state === st0);
            o.errs = T.newErrs();
            o.val = p[f];
            o.valOk = (typeof o.val === 'boolean') ? (o.val === true) : (typeof o.val === 'number' && o.val >= 1);
            o.enemies = N.G.enemies.length;
            o.bullets = N.G.bullets.length;
          } catch (e) {
            o.threw = String((e && e.message) || e);
          }
          res[id] = o;
        }
        return { total: M.length, res: res };
      })()`);
      const conds = [['14 张卡逐张跑完', r.total === 14 && Object.keys(r.res).length === 14, Object.keys(r.res).length]];
      for (const id of MUT_IDS) {
        const o = r.res[id];
        if (!o) { conds.push([id + '：缺少结果', false, 'missing']); continue; }
        const ok = !o.threw && o.stateOk === true && (o.errs || []).length === 0 && o.valOk === true;
        if (!ok) {
          conds.push([id + '（字段 ' + o.field + '）', false,
            (o.threw ? '抛错 ' + o.threw : '') +
            (o.stateOk === false ? ' state ' + o.state0 + '→' + o.state : '') +
            ((o.errs || []).length ? ' 未捕获异常 ' + o.errs.join('|') : '') +
            (o.valOk === false ? ' ' + o.field + '=' + JSON.stringify(o.val) : '')]);
        } else {
          conds.push([id + '：状态稳定 + 字段生效', true, o.field + '=' + JSON.stringify(o.val)]);
        }
      }
      const failedIds = MUT_IDS.filter(id => {
        const o = r.res[id];
        return !o || o.threw || o.stateOk !== true || (o.errs || []).length || o.valOk !== true;
      });
      console.log('   · 逐卡结果：' + MUT_IDS.map(id => {
        const o = r.res[id] || {};
        return id + (failedIds.indexOf(id) >= 0 ? '✗' : '✓') + '(' + JSON.stringify(o.val) + ')';
      }).join(' '));
      expect('5) 14 张变异在真实战斗中逐张应用', conds);
    });

    // ===== 6) 关键变异的运行时事实 =====
    await step('6) 关键变异的运行时事实（回旋/分裂/延迟/环绕/双管）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, T = window.__t, out = {};
        function guard(name, fn) { try { fn(); } catch (e) { out[name + 'Err'] = String((e && e.message) || e); } }

        // (a) 回旋弹：行程过半后 returning=true 且速度反向
        guard('boom', function () {
          var p = T.arena();
          p.mutBoomerang = true;
          var b = T.mkBullet(p.x, p.y, 600, 0, 10);
          var vx0 = b.vx, dmg0 = b.dmg;
          N.G.bullets.push(b);
          for (var i = 0; i < 46; i++) N.step(1 / 60);
          out.boom = {
            returning: b.returning === true,
            vx0: vx0, vx: b.vx, vy: b.vy, dmg0: dmg0, dmg: b.dmg,
            life: b.life, alive: N.G.bullets.indexOf(b) >= 0
          };
        });

        // (b) 分裂弹：命中后出现 splitChild 子弹
        guard('split', function () {
          var p = T.arena();
          p.mutSplitShot = true;
          var en = T.mkEnemy('chaser', p.x + 300, p.y);
          if (!en) throw new Error('spawnEnemy 未返回敌人');
          N.G.bullets.push(T.mkBullet(en.x, en.y, 0, 0, 10));
          N.step(1 / 60);
          var n = 0;
          for (var i = 0; i < N.G.bullets.length; i++) if (N.G.bullets[i].splitChild === true) n++;
          out.split = { children: n, bullets: N.G.bullets.length };
        });

        // (c) 延迟引爆：命中不立即掉血、只标记；1 秒后掉血
        guard('delay', function () {
          var p = T.arena();
          p.mutDelay = true;
          var en = T.mkEnemy('chaser', p.x + 300, p.y);
          if (!en) throw new Error('spawnEnemy 未返回敌人');
          N.G.bullets.push(T.mkBullet(en.x, en.y, 0, 0, 13));
          var hp0 = en.hp;
          N.step(1 / 60);
          var hp1 = en.hp, mark = en.delayMark || 0, dt1 = en.delayT || 0;
          for (var j = 0; j < 65; j++) N.step(1 / 60);
          out.delay = { hp0: hp0, hp1: hp1, hp2: en.hp, mark: mark, delayT: dt1, noInstant: hp1 === hp0, dropped: en.hp < hp1 };
        });

        // (d) 弹幕环绕：推进 2 秒后 4 颗 orbitOwner 子弹
        guard('orbit', function () {
          var p = T.arena();
          p.mutOrbit = 1;
          for (var i = 0; i < 130; i++) N.step(1 / 60);
          var n = 0;
          for (var k = 0; k < N.G.bullets.length; k++) if (N.G.bullets[k].orbitOwner === p) n++;
          out.orbit = { count: n, bullets: N.G.bullets.length, orbitT: p.orbitT };
        });

        // (e) 双管齐发：单次 fire() 子弹数 = proj×2，每发伤害 0.65×
        guard('twin', function () {
          var p = T.arena();
          p.mutTwin = 1;
          var before = N.G.bullets.length;
          N.fire();
          var added = N.G.bullets.slice(before);
          var want = p.proj * 2, wantDmg = p.dmg * 0.65;
          var dmgOk = added.length > 0;
          for (var i = 0; i < added.length; i++) if (added[i].dmg !== wantDmg) dmgOk = false;
          out.twin = { added: added.length, want: want, proj: p.proj, dmgOk: dmgOk,
                       dmg: added.length ? added[0].dmg : null, wantDmg: wantDmg };
        });
        return out;
      })()`);
      const b = r.boom || {}, s = r.split || {}, d = r.delay || {}, o = r.orbit || {}, t = r.twin || {};
      console.log('   · 回旋 ' + JSON.stringify(b));
      console.log('   · 分裂 ' + JSON.stringify(s));
      console.log('   · 延迟 ' + JSON.stringify(d));
      console.log('   · 环绕 ' + JSON.stringify(o));
      console.log('   · 双管 ' + JSON.stringify(t));
      expect('6) 关键变异的运行时事实', [
        ['回旋弹：returning===true 且速度反向（vx 600 → ' + b.vx + '）',
          !r.boomErr && b.returning === true && b.vx < 0 && b.vy === 0, r.boomErr || JSON.stringify(b)],
        ['分裂弹：命中后出现 3 颗 splitChild 子弹（实测 ' + s.children + '）',
          !r.splitErr && s.children >= 3, r.splitErr || JSON.stringify(s)],
        ['延迟引爆：命中瞬间 hp 不变且 delayMark>0（mark=' + d.mark + '）',
          !r.delayErr && d.noInstant === true && d.mark > 0, r.delayErr || JSON.stringify(d)],
        ['延迟引爆：推进 1 秒后 hp 下降（' + d.hp1 + ' → ' + d.hp2 + '）',
          !r.delayErr && d.dropped === true, r.delayErr || JSON.stringify(d)],
        ['弹幕环绕：推进 2 秒后 orbitOwner 子弹数为 4（实测 ' + o.count + '）',
          !r.orbitErr && o.count === 4, r.orbitErr || JSON.stringify(o)],
        ['双管齐发：单次 fire() 产生 proj×2=' + t.want + ' 发（实测 ' + t.added + '）且每发 dmg=' + t.wantDmg,
          !r.twinErr && t.added === t.want && t.dmgOk === true, r.twinErr || JSON.stringify(t)]
      ]);
    });

    // ===== 7) 回退系统兼容 =====
    await step('7) 回退系统兼容（applyUpgrade → removeTakenById 逐张还原）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, T = window.__t, M = N.WEAPON_MUTATIONS, bad = [], rows = [];
        for (var i = 0; i < M.length; i++) {
          var card = M[i], id = card.id, f = T.MUT_FIELD[id], init = T.init[f];
          try {
            var p = T.arena();
            p.taken = []; p.takenDelta = [];
            N.applyUpgrade(p, card);
            var deltaAfterApply = p.takenDelta.length;
            var takenAfterApply = p.taken.length;
            var vApplied = p[f];
            var rem = N.removeTakenById(p, id);
            var v = p[f];
            rows.push({ id: id, field: f, applied: vApplied, back: v, init: init,
                        delta: p.takenDelta.length, taken: p.taken.length, rem: rem });
            if (rem !== true) bad.push(id + ': removeTakenById 返回 ' + rem);
            if (deltaAfterApply !== 1) bad.push(id + ': 应用后 takenDelta=' + deltaAfterApply);
            if (takenAfterApply !== 1) bad.push(id + ': 应用后 taken=' + takenAfterApply);
            if (p.takenDelta.length !== 0) bad.push(id + ': 回退后 takenDelta=' + p.takenDelta.length);
            if (p.taken.length !== 0) bad.push(id + ': 回退后 taken=' + p.taken.length);
            if (v !== init) bad.push(id + ': ' + f + '=' + JSON.stringify(v) + ' 应为 ' + JSON.stringify(init));
          } catch (e) { bad.push(id + ': 抛错 ' + String((e && e.message) || e)); }
        }
        return { bad: bad, rows: rows, n: M.length };
      })()`);
      console.log('   · 还原抽样：' + (r.rows || []).slice(0, 4).map(x => x.id + ' ' + JSON.stringify(x.applied) + '→' + JSON.stringify(x.back)).join(' · '));
      expect('7) 回退系统兼容', [
        ['14 张卡全部 apply→remove 且 takenDelta 归零', (r.rows || []).length === 14 && r.bad.length === 0, r.bad.join('；') || 'none']
      ]);
    });

    // ===== 8) 存档不受影响 =====
    await step('8) 存档不受影响（版本 1 / 不含 mut 字段 / 仍可存读）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, T = window.__t, out = {};
        out.sv = N.SAVE_VERSION;
        var p = T.arena();
        N.saveGame();
        var raw0 = T.raw() || '';
        out.cleanHasMut = raw0.indexOf('"mut') >= 0;
        // 把 14 张变异全部应用到本局玩家，再落盘
        for (var i = 0; i < N.WEAPON_MUTATIONS.length; i++) N.applyUpgrade(p, N.WEAPON_MUTATIONS[i]);
        out.applied = p.taken.length;
        N.G.best = 777; N.SAVE.best = 777;
        var w = N.saveGame();
        out.saveReturnOk = !!(w && typeof w === 'object');
        var raw = T.raw() || '';
        out.rawHasMut = raw.indexOf('"mut') >= 0;
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { out.parseErr = String((e && e.message) || e); }
        out.parsedOk = !!parsed;
        out.version = parsed ? parsed.version : null;
        out.keys = parsed ? Object.keys(parsed).join(',') : '';
        out.deepHasMut = raw.indexOf('mut') >= 0;
        var ld = N.loadGame();
        out.loadOk = !!ld && typeof ld === 'object';
        out.bestAfterLoad = N.G.best;
        out.exportedAt = parsed ? parsed.exportedAt : 'n/a';
        // 变异是本局内状态：读档不应把 mut* 写回或抹掉
        out.mutKept = (p.mutBoomerang === true && p.mutTwin === 1 && p.mutDelay === true);
        return out;
      })()`);
      console.log('   · 落盘字段：' + r.keys + ' · 版本 ' + r.version + ' · 应用变异 ' + r.applied + ' 张');
      expect('8) 存档不受影响', [
        ['SAVE_VERSION === 1', r.sv === 1, r.sv],
        ['干净存档串不含 "mut', r.cleanHasMut === false, r.cleanHasMut],
        ['14 张变异全部应用后 saveGame() 返回对象', r.saveReturnOk === true && r.applied === 14, r.applied],
        ['存档串不含 "mut（含子串扫描）', r.rawHasMut === false && r.deepHasMut === false, 'rawHasMut=' + r.rawHasMut + ' deep=' + r.deepHasMut],
        ['存档可解析且 version===1', r.parsedOk === true && r.version === 1, r.version],
        ['存档字段 = ' + r.keys, (r.keys || '').indexOf('version') >= 0 && (r.keys || '').indexOf('best') >= 0 &&
          (r.keys || '').indexOf('meta') >= 0 && (r.keys || '').indexOf('stats') >= 0, r.keys],
        ['loadGame() 之后仍可用且 best 回读正确', r.loadOk === true && r.bestAfterLoad === 777, r.bestAfterLoad],
        ['变异是本局状态：读档后 mut* 仍在（不影响存档）', r.mutKept === true, r.mutKept]
      ]);
    });

    // ===== 10) 版本标记 =====
    //  Lead 于 v1.9 调整：原断言写死「v1.8」，版本号一升级就会误报；改为「存在 vX.Y 版本标记」，
    //  这样 r11 作为回归脚本可以长期复用（功能断言仍然全部针对 v1.8 的变异系统）。
    await step('10) 版本标记（#overlayTitle .sub 含 vX.Y）', async () => {
      const r = await ev(`(function () {
        var el = document.querySelector('#overlayTitle .sub');
        var txt = el ? String(el.textContent || '') : null;
        var m = txt ? txt.match(/v\\d+\\.\\d+/) : null;
        return { txt: txt, ver: m ? m[0] : null };
      })()`);
      console.log('   · #overlayTitle .sub = ' + JSON.stringify(r.txt) + ' · 识别版本 = ' + r.ver);
      expect('10) 版本标记', [
        ['#overlayTitle .sub 存在', r.txt !== null, r.txt === null ? 'element missing' : 'ok'],
        ['文本含 vX.Y 版本标记', !!r.ver, r.txt]
      ]);
    });
  } catch (e) {
    fail('运行环境 / CDP', (e && e.stack) || String(e));
  } finally {
    if (cdp) cdp.close();
    if (chrome) chrome.kill();
    await sleep(700);
    rmrf(PROFILE);
  }

  // ===== 结果汇总 =====
  console.log('\n================ v1.8 武器/攻击方式变异验收结果 ================');
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
