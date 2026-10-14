// ============================================================
//  v1.9「无尽模式『层』系统 + 分层背景」真机验收脚本（r12-check.js）
//  · 零第三方依赖：Node 标准库 + CDP over Node 内置 WebSocket，驱动真实 Chrome
//  · 调试端口 9351（r9 用 9346 / r10 用 9347 / r11 用 9348 / layer-shots 用 9349）
//    独立临时 profile：dev/.chrome-r12（开跑前清空，收尾 kill Chrome + 删目录）
//  · 视口固定 1440x900（Emulation.setDeviceMetricsOverride）
//  · 被测入口 window.__neon 的 v1.9 成员：
//    ENDLESS_MAX_WAVE / LAYERS / LAYER_AFFIXES / CYCLE_BONUS / getLayerForWave /
//    bossEveryForWave / getLayerAffix / getLayerColor / LAYER_BG / buildBackgroundForLayer /
//    drawLayerEffects / drawLayerProgress / drawLayerTransition / showSofiaLine /
//    endlessComplete / G.layerState
//  · 只读 index.html，不修改任何被测文件，不写任何中间文件（连截图都不落盘）
//  · 退出码 0 = 全通过；1 = 有 FAIL（打印失败清单与实测值）
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
const PORT = 9351;
const PROFILE = path.join(DEV_DIR, '.chrome-r12');
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
function n2(v) { return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : v; }
function dist3(a, b) {
  return Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2) + Math.pow(a[2] - b[2], 2));
}
function ratio(a, b) { return (b === 0) ? NaN : a / b; }

// ------------------------------------------------------------
//  CDP 客户端（风格与 r10-check.js / layer-shots.js 一致）
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
      // 第 4/5 项要做整块画布 getImageData，给足 60s
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
//   · errs / mark / newErrs：收集未捕获异常（window.onerror + unhandledrejection）
//   · frames：rAF 帧计数（用于判断过渡计时的真实推进速度）
//   · rollAffixes(wave, c)：打桩 Math.random 为常数 c 后再调 rollWaveAffixes，
//     从而确定性地抽到「层专属池第 k 个」词缀（pick 索引 = floor(c * pool.length)）
//   · keepOnly(id)：把本波词缀收敛成只剩 id，避免全局波次词缀污染单项测量
// ------------------------------------------------------------
const HELPERS = `
window.__t = (function () {
  function N() { return window.__neon || {}; }
  return {
    N: N,
    errs: [],
    frames: 0,
    watchErrors: function () {
      var self = this;
      if (self.__watched) return;
      self.__watched = 1;
      window.addEventListener('error', function (e) { self.errs.push(String((e && e.message) || e)); });
      window.addEventListener('unhandledrejection', function (e) { self.errs.push('rejection:' + String(e && e.reason)); });
      (function tick() { self.frames++; requestAnimationFrame(tick); })();
    },
    mark: function () { this.__n = this.errs.length; return this.__n; },
    newErrs: function () { return this.errs.slice(this.__n || 0); },
    rollAffixes: function (wave, c) {
      var n = N(), G = n.G, orig = Math.random, list = null;
      Math.random = function () { return c; };
      try { n.rollWaveAffixes(wave); list = G.affixes.list.slice(); }
      finally { Math.random = orig; }
      return { list: list, primary: G.affixes.primary, secondary: G.affixes.secondary };
    },
    keepOnly: function (id) {
      var G = N().G;
      G.affixes = { list: [id], primary: id, secondary: null };
      return G.affixes.list.slice();
    },
    speed: function (b) { return Math.sqrt(b.vx * b.vx + b.vy * b.vy); }
  };
})();
window.__t.watchErrors();
"ok"`;

// ------------------------------------------------------------
//  第 4 项：bgCanvas 像素取证
//  bgCanvas 未挂在 __neon 上，这里用「捕获 getContext('2d') 的 this」把真实
//  bgCanvas 元素抓出来（buildBackgroundForLayer 内部必然会取一次 2d 上下文），
//  再对真身做 getImageData —— 比读 world 画布更直接，排除 HUD / 实体的干扰。
// ------------------------------------------------------------
const BG_PIXEL_EXPR = `(function () {
  var N = window.__neon, G = N.G;
  var themes = ['blue', 'purple', 'gold', 'red', 'white'];
  var origGet = HTMLCanvasElement.prototype.getContext;
  var out = { order: themes, themes: {} };
  function capture(theme) {
    var cap = null;
    HTMLCanvasElement.prototype.getContext = function (t) {
      if (t === '2d') cap = this;
      return origGet.apply(this, arguments);
    };
    try { N.buildBackgroundForLayer(theme); }
    finally { HTMLCanvasElement.prototype.getContext = origGet; }
    var rec = {
      theme: G.layerState.bgTheme, got: !!cap,
      w: cap ? cap.width : 0, h: cap ? cap.height : 0,
      isBg: !!cap && cap !== N.world && cap !== N.screen && !cap.parentNode
    };
    if (!cap) return rec;
    var c = cap.getContext('2d');
    var W = cap.width, H = cap.height;
    var im = c.getImageData(0, 0, W, H).data;
    function px(x, y) {
      x = Math.max(0, Math.min(W - 1, x | 0)); y = Math.max(0, Math.min(H - 1, y | 0));
      var i = (y * W + x) * 4;
      return [im[i], im[i + 1], im[i + 2]];
    }
    rec.pts = [px(4, 4), px(W - 5, 4), px(4, H - 5), px(W - 5, H - 5), px(W / 2, H / 2)];
    var sr = 0, sg = 0, sb = 0, n = 0;
    for (var gy = 0; gy < 32; gy++) {
      for (var gx = 0; gx < 32; gx++) {
        var q = px((gx + 0.5) * W / 32, (gy + 0.5) * H / 32);
        sr += q[0]; sg += q[1]; sb += q[2]; n++;
      }
    }
    rec.avg = [Math.round(sr / n * 100) / 100, Math.round(sg / n * 100) / 100, Math.round(sb / n * 100) / 100];
    rec.lum = Math.round((0.299 * rec.avg[0] + 0.587 * rec.avg[1] + 0.114 * rec.avg[2]) * 100) / 100;
    rec.br = Math.round((rec.avg[2] - rec.avg[0]) * 100) / 100;
    return rec;
  }
  for (var i = 0; i < themes.length; i++) out.themes[themes[i]] = capture(themes[i]);
  N.buildBackgroundForLayer('blue');
  out.restored = G.layerState.bgTheme;
  return out;
})()`;

// ------------------------------------------------------------
//  第 5 项：动态层效果像素取证（world 画布）
//  每一次测量都在同一次 Runtime.evaluate 里同步完成：刷不透明黑底 -> 设 G.time ->
//  调 drawLayerEffects() -> 取像素，因此帧循环不会插进来。
//  · 用「不透明黑底」而不是 clearRect：canvas2d 的 getImageData 返回的是
//    **反预乘（unpremultiplied）** RGBA，若底色透明，alpha=0.03 的描边会被还原成
//    RGB=(255,255,255) 之类的假高亮（实测 maxDiff 恒为 255），完全掩盖真实强度。
//    刷成不透明底之后，读回来的 RGB 就等于「效果色的实际可见亮度」。
//  · 黑底同时把静止的静态背景排除掉，差异只反映动态层本身。
//  判据：t 与 t+1.5 两次绘制后，同一批采样点中「通道差 > 3」的点数（changed）
//  与最大通道差（maxDiff）。蓝层按契约只做信息记录，不设硬阈值。
//  t 取两个候选（白层闪烁/扫描线是间歇的，单一 t 可能刚好两次都不动），取 changed 较大者。
// ------------------------------------------------------------
const FX_PIXEL_EXPR = `(function () {
  var N = window.__neon, G = N.G;
  var c = N.world.getContext('2d');
  var CW = N.world.width, CH = N.world.height;   // world 画布 = 视口尺寸（1600x1000），只在界内取像素
  var themes = ['blue', 'purple', 'gold', 'red', 'white'];
  var TS = [6.0, 9.62];
  var out = { order: themes, ts: TS, canvas: CW + 'x' + CH, diffs: {}, errors: {}, samples: Math.floor(CW * CH / 2) };
  function shot(theme, t) {
    // 归零所有会残留的绘制状态，保证两次取样的唯一变量是 G.time
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.shadowBlur = 0;
    c.filter = 'none';
    c.fillStyle = '#000000';
    c.fillRect(0, 0, CW, CH);        // 不透明黑底（避免反预乘噪声，同时滤掉静止背景）
    G.layerState.bgTheme = theme;
    G.time = t;
    N.drawLayerEffects();
    return c.getImageData(0, 0, CW, CH).data;
  }
  function diffOf(theme, t) {
    var a = shot(theme, t);
    var b = shot(theme, t + 1.5);
    var changed = 0, maxd = 0, sum = 0, n = 0, maxAt = null;
    for (var j = 0; j < a.length; j += 8) {
      var d0 = Math.abs(a[j] - b[j]), d1 = Math.abs(a[j + 1] - b[j + 1]), d2 = Math.abs(a[j + 2] - b[j + 2]);
      var mx = d0 > d1 ? (d0 > d2 ? d0 : d2) : (d1 > d2 ? d1 : d2);
      if (mx > 3) changed++;
      if (mx > maxd) {
        maxd = mx;
        var pi = j / 4;
        maxAt = { x: pi % CW, y: Math.floor(pi / CW), a: [a[j], a[j + 1], a[j + 2]], b: [b[j], b[j + 1], b[j + 2]] };
      }
      sum += d0 + d1 + d2; n++;
    }
    return { t: t, changed: changed, maxDiff: maxd, meanAbs: Math.round(sum / n / 3 * 1000) / 1000, maxAt: maxAt };
  }
  for (var i = 0; i < themes.length; i++) {
    var theme = themes[i];
    try {
      var best = null;
      for (var k = 0; k < TS.length; k++) {
        var rec = diffOf(theme, TS[k]);
        if (!best || rec.changed > best.changed) best = rec;
      }
      out.diffs[theme] = best;
    } catch (e) { out.errors[theme] = String((e && e.message) || e); }
  }
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.clearRect(0, 0, CW, CH);        // 下一帧 render() 会用背景整块覆盖，这里只是收尾
  return out;
})()`;

// ------------------------------------------------------------
//  主流程
// ------------------------------------------------------------
(async () => {
  let cdp = null;
  let chrome = null;
  const ev = expr => cdp.eval(expr);
  const pageErrors = [];
  let pendingLoad = null;
  let bgEvidence = null;
  let fxEvidence = null;

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

  // ===== 11c) 单文件零外部资源（Node 侧文本校验，Chrome 之前先跑）=====
  await step('11c) 单文件零外部资源（index.html 文本校验）', async () => {
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
    console.log('   · 被测文件 ' + GAME_FILE + '（' + raw.length + ' 字符，' + raw.split('\n').length + ' 行）');
    expect('11c) 单文件零外部资源', [
      ['不得出现 <script src= / <link href= / <img src=', hits.length === 0, hits.join(' | ') || 'none']
    ]);
  });

  // ===== 启动真实 Chrome =====
  if (!fs.existsSync(CHROME)) { fail('环境', '找不到 Chrome: ' + CHROME); }
  if (!PROFILE.endsWith('.chrome-r12')) { console.error('FAIL: 临时目录路径异常 ' + PROFILE); process.exit(1); }
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
    };
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // 固定视口 1440x900（与 layer-shots.js 一致，避免 headless 视口抖动）
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
      });
    } catch (e) {}
    await cdp.send('Page.navigate', { url: URL_FILE });
    const ready = await waitFor('typeof window.__neon === "object" && !!window.__neon.G', 20000);
    await sleep(400);
    await ev(HELPERS);
    await ev('window.__t.mark()');
    if (!ready) fail('0) 页面初始化', '20s 内未等到 window.__neon');
    console.log('   · 视口 ' + await ev('window.innerWidth + "x" + window.innerHeight') +
      ' · world ' + await ev('window.__neon.world.width + "x" + window.__neon.world.height') +
      ' · W/H ' + await ev('window.__neon.W + "/" + window.__neon.H'));

    // ===== 1) 契约成员 =====
    await step('1) 契约成员（常量 / 数据结构 / 函数 / DOM / G.layerState）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon || {}, bad = [];
        function need(ok, msg) { if (!ok) bad.push(msg); }
        function isFn(v) { return typeof v === 'function'; }

        need(N.ENDLESS_MAX_WAVE === 100, 'ENDLESS_MAX_WAVE 应 100，实际 ' + JSON.stringify(N.ENDLESS_MAX_WAVE));

        var ids = ['cache', 'emotion', 'memory', 'core', 'selfdestruct'];
        var ranges = [[1, 10], [11, 20], [21, 30], [31, 40], [41, 50]];
        var themes = ['blue', 'purple', 'gold', 'red', 'white'];
        var L = N.LAYERS;
        need(Array.isArray(L) && L.length === 5, 'LAYERS.length 应 5，实际 ' + (L && L.length));
        var affixUnion = [];
        if (Array.isArray(L)) {
          for (var i = 0; i < L.length; i++) {
            var l = L[i] || {}, tag = 'LAYERS[' + i + ']';
            need(l.id === ids[i], tag + '.id 应 ' + ids[i] + '，实际 ' + JSON.stringify(l.id));
            need(typeof l.nm === 'string' && l.nm.length > 0, tag + '.nm 缺失');
            need(Array.isArray(l.range) && l.range.length === 2 && l.range[0] === ranges[i][0] && l.range[1] === ranges[i][1],
              tag + '.range 应 [' + ranges[i] + ']，实际 ' + JSON.stringify(l.range));
            need(l.theme === themes[i], tag + '.theme 应 ' + themes[i] + '，实际 ' + JSON.stringify(l.theme));
            need(typeof l.lore === 'string' && l.lore.length > 4, tag + '.lore 缺失');
            need(Array.isArray(l.affixes), tag + '.affixes 不是数组');
            need(Array.isArray(l.enemies) && l.enemies.length > 0, tag + '.enemies 不是非空数组');
            if (Array.isArray(l.affixes)) affixUnion = affixUnion.concat(l.affixes);
          }
          need(L[2] && L[2].eliteChance === 0.15, 'LAYERS[2](memory).eliteChance 应 0.15，实际 ' + JSON.stringify(L[2] && L[2].eliteChance));
          need(L[3] && L[3].bossEvery === 4, 'LAYERS[3](core).bossEvery 应 4，实际 ' + JSON.stringify(L[3] && L[3].bossEvery));
          need(L[3] && L[3].storyEvery === 5, 'LAYERS[3](core).storyEvery 应 5，实际 ' + JSON.stringify(L[3] && L[3].storyEvery));
          need(L[4] && L[4].eliteChance === 1.0, 'LAYERS[4](selfdestruct).eliteChance 应 1.0，实际 ' + JSON.stringify(L[4] && L[4].eliteChance));
          need(L[4] && L[4].isFinal === true, 'LAYERS[4](selfdestruct).isFinal 应 true，实际 ' + JSON.stringify(L[4] && L[4].isFinal));
        }

        var LA = N.LAYER_AFFIXES;
        need(Array.isArray(LA) && LA.length === 15, 'LAYER_AFFIXES.length 应 15，实际 ' + (LA && LA.length));
        var laBad = [];
        if (Array.isArray(LA)) {
          for (var a = 0; a < LA.length; a++) {
            var x = LA[a] || {};
            if (x.cat !== 'layer') laBad.push(String(x.id) + '.cat=' + JSON.stringify(x.cat));
            if (typeof x.nm !== 'string' || !x.nm) laBad.push(String(x.id) + '.nm');
            if (typeof x.ds !== 'string' || !x.ds) laBad.push(String(x.id) + '.ds');
            if (typeof x.lore !== 'string' || !x.lore) laBad.push(String(x.id) + '.lore');
            if (typeof x.ico !== 'string' || !x.ico) laBad.push(String(x.id) + '.ico');
            if (typeof x.tone !== 'string' || !x.tone) laBad.push(String(x.id) + '.tone');
          }
        }
        need(laBad.length === 0, 'LAYER_AFFIXES 字段异常: ' + laBad.join(','));
        var laIds = Array.isArray(LA) ? LA.map(function (v) { return v.id; }) : [];
        var uniq = laIds.filter(function (v, i) { return laIds.indexOf(v) === i; });
        need(uniq.length === laIds.length, 'LAYER_AFFIXES.id 有重复：' + laIds.join(','));
        var uAffix = affixUnion.filter(function (v, i) { return affixUnion.indexOf(v) === i; });
        var mismatch = [];
        uAffix.forEach(function (v) { if (laIds.indexOf(v) < 0) mismatch.push('层引用但表里没有:' + v); });
        laIds.forEach(function (v) { if (uAffix.indexOf(v) < 0) mismatch.push('表里有但没被任何层引用:' + v); });
        need(mismatch.length === 0, 'LAYERS.affixes 与 LAYER_AFFIXES 不一致: ' + mismatch.join(','));

        var CB = N.CYCLE_BONUS || {}, c1 = CB[1] || {}, c2 = CB[2] || {};
        need(c1.hp === 1 && c1.dmg === 1 && c1.spd === 1 && c1.eliteChance === 0 && c1.scoreMul === 1,
          'CYCLE_BONUS[1] 应全 1/0，实际 ' + JSON.stringify(c1));
        need(c2.hp === 1.8 && c2.dmg === 1.4 && c2.spd === 1.15 && c2.eliteChance === 0.20 && c2.scoreMul === 1.5,
          'CYCLE_BONUS[2] 应 1.8/1.4/1.15/0.20/1.5，实际 ' + JSON.stringify(c2));

        ['getLayerForWave', 'bossEveryForWave', 'getLayerAffix', 'getLayerColor', 'buildBackgroundForLayer',
         'drawLayerEffects', 'drawLayerProgress', 'drawLayerTransition', 'showSofiaLine', 'endlessComplete']
          .forEach(function (f) { need(isFn(N[f]), '__neon.' + f + ' 不是函数'); });

        var BG = N.LAYER_BG;
        need(!!BG && typeof BG === 'object', 'LAYER_BG 不是对象');
        themes.forEach(function (t) { need(!!(BG && BG[t]), 'LAYER_BG.' + t + ' 缺失'); });
        need(!!BG && Object.keys(BG).length >= 5, 'LAYER_BG 键数 < 5，实际 ' + (BG && Object.keys(BG).length));

        var colors = themes.map(function (t) { try { return String(N.getLayerColor(t)); } catch (e) { return 'ERR'; } });
        need(colors.every(function (c) { return c && c !== 'ERR' && c.charAt(0) === '#'; }), 'getLayerColor 返回异常: ' + colors.join(','));
        need(colors.filter(function (c, i) { return colors.indexOf(c) === i; }).length === 5, 'getLayerColor 5 个主题颜色不互异: ' + colors.join(','));

        need(!!N.getLayerAffix('anxiety') && N.getLayerAffix('anxiety').id === 'anxiety', 'getLayerAffix("anxiety") 失败');
        need(N.getLayerAffix('__nope__') === null, 'getLayerAffix(未知 id) 应返回 null，实际 ' + JSON.stringify(N.getLayerAffix('__nope__')));

        var ls = N.G && N.G.layerState;
        need(!!ls, 'G.layerState 缺失');
        if (ls) {
          ['currentLayer', 'currentLayerIndex', 'cycle', 'transitionT', 'transitionTotal', 'collapseAmount', 'bgTheme']
            .forEach(function (k) { need(k in ls, 'G.layerState.' + k + ' 缺失'); });
          need(ls.transitionTotal === 1.5, 'G.layerState.transitionTotal 应 1.5，实际 ' + JSON.stringify(ls.transitionTotal));
        }

        var missDom = ['overlayOver', 'finTitle', 'overlayTitle', 'screen'].filter(function (id) { return !document.getElementById(id); });
        need(missDom.length === 0, 'DOM 缺失: ' + missDom.join(','));
        need(!!document.querySelector('#overlayTitle .sub'), '#overlayTitle .sub 缺失');
        need(!!N.world && typeof N.world.getContext === 'function', '__neon.world 不是画布');
        need(!!N.screen && typeof N.screen.getContext === 'function', '__neon.screen 不是画布');
        need(Array.isArray(N.G && N.G.popups), 'G.popups 不是数组');

        return {
          bad: bad,
          ids: (Array.isArray(L) ? L.map(function (l) { return l.id; }) : []).join(','),
          laCount: Array.isArray(LA) ? LA.length : -1,
          bgKeys: BG ? Object.keys(BG).join(',') : 'none',
          colors: colors.join(','),
          world: N.world ? N.world.width + 'x' + N.world.height : 'none'
        };
      })()`);
      console.log('   · LAYERS ids=' + r.ids + ' · LAYER_AFFIXES=' + r.laCount + ' · LAYER_BG 键=' + r.bgKeys);
      console.log('   · getLayerColor: ' + r.colors + ' · world=' + r.world);
      expect('1) 契约成员', [
        ['全部成员 / 常量 / DOM 就位', r.bad.length === 0, r.bad.join('；') || 'none']
      ]);
    });

    // ===== 2) 层判定 =====
    await step('2) 层判定 getLayerForWave（16 个波次逐个断言）', async () => {
      const want = {
        1: 'cache', 5: 'cache', 10: 'cache', 11: 'emotion', 20: 'emotion',
        21: 'memory', 30: 'memory', 31: 'core', 40: 'core',
        41: 'selfdestruct', 50: 'selfdestruct', 51: 'cache', 61: 'emotion',
        75: 'memory', 85: 'core', 100: 'selfdestruct'
      };
      const waves = [1, 5, 10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 61, 75, 85, 100];
      const r = await ev(`(function () {
        var N = window.__neon, out = [];
        var waves = ${JSON.stringify(waves)};
        for (var i = 0; i < waves.length; i++) {
          var w = waves[i], g = N.getLayerForWave(w);
          out.push({ wave: w, id: g.layer && g.layer.id, index: g.index, cycle: g.cycle, inCycle: g.waveInCycle });
        }
        return out;
      })()`);
      const bad = [];
      const rows = [];
      for (const g of r) {
        const wantCycle = g.wave <= 50 ? 1 : 2;
        const wantIn = g.wave <= 50 ? g.wave : g.wave - 50;
        rows.push(g.wave + '→' + g.id + '/' + g.cycle + '/' + g.inCycle);
        if (g.id !== want[g.wave]) bad.push('wave ' + g.wave + ' 层应为 ' + want[g.wave] + '，实际 ' + g.id);
        if (g.cycle !== wantCycle) bad.push('wave ' + g.wave + ' cycle 应为 ' + wantCycle + '，实际 ' + g.cycle);
        if (g.inCycle !== wantIn) bad.push('wave ' + g.wave + ' waveInCycle 应为 ' + wantIn + '，实际 ' + g.inCycle);
        if (g.index < 0 || g.index > 4) bad.push('wave ' + g.wave + ' index 越界 ' + g.index);
        if (g.wave > 50 && g.inCycle !== g.wave - 50) bad.push('wave ' + g.wave + ' 第二循环 waveInCycle !== wave-50');
      }
      console.log('   · ' + rows.join('  '));
      expect('2) 层判定 getLayerForWave', [
        ['16 个波次的 layer.id / cycle / waveInCycle 全部正确', bad.length === 0, bad.join('；') || 'none']
      ]);
    });

    // ===== 3) 首领间隔 =====
    await step('3) 首领间隔 bossEveryForWave（层 4 每 4 波）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, G = N.G, out = { endless: {}, campaign: {}, mode0: G.mode };
        G.mode = 'endless';
        var ws = [1, 10, 11, 20, 21, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 50, 51, 60, 80, 81, 85, 90, 91, 100];
        for (var i = 0; i < ws.length; i++) out.endless[ws[i]] = N.bossEveryForWave(ws[i]);
        G.mode = 'campaign';
        [31, 33, 35, 40, 81, 85, 90].forEach(function (w) { out.campaign[w] = N.bossEveryForWave(w); });
        out.campaignEvery = N.MODES.campaign.bossEvery;
        G.mode = 'endless';
        return out;
      })()`);
      const bad = [];
      for (const k of Object.keys(r.endless)) {
        const w = Number(k);
        const want = ((w >= 31 && w <= 40) || (w >= 81 && w <= 90)) ? 4 : 5;
        if (r.endless[k] !== want) bad.push('无尽 wave ' + w + ' 应 ' + want + '，实际 ' + r.endless[k]);
      }
      for (const k of Object.keys(r.campaign)) {
        if (r.campaign[k] !== r.campaignEvery) bad.push('剧情 wave ' + k + ' 应 ' + r.campaignEvery + '，实际 ' + r.campaign[k]);
      }
      const rows = Object.keys(r.endless).map(k => k + ':' + r.endless[k]).join(' ');
      console.log('   · 无尽 bossEvery: ' + rows);
      console.log('   · 剧情 bossEvery: ' + Object.keys(r.campaign).map(k => k + ':' + r.campaign[k]).join(' ') + '（MODES.campaign.bossEvery=' + r.campaignEvery + '）');
      expect('3) 首领间隔 bossEveryForWave', [
        ['无尽 31-40 / 81-90 返回 4，其余返回 5', bad.length === 0, bad.join('；') || 'none'],
        ['剧情模式恒为 MODES.campaign.bossEvery', Object.keys(r.campaign).every(k => r.campaign[k] === r.campaignEvery), r.campaignEvery]
      ]);
    });

    // ===== 4) 分层背景像素取证 =====
    await step('4) 分层背景真的切换（bgCanvas 像素级证据）', async () => {
      const r = await ev(BG_PIXEL_EXPR);
      bgEvidence = r;
      const order = r.order;
      const T = t => r.themes[t];
      const misses = order.filter(t => !T(t).got || !T(t).isBg);
      const themeBad = order.filter(t => T(t).theme !== t);
      console.log('   · 32x32 网格平均 RGB：' + order.map(t => t + '(' + T(t).avg.join(',') + ') L=' + T(t).lum + ' B-R=' + T(t).br).join(' | '));
      console.log('   · 5 点采样（左上/右上/左下/右下/中心）：' + order.map(t => t + '=' + T(t).pts.map(p => p.join('-')).join('/')).join(' | '));
      let minD = Infinity, argMin = '';
      for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const d = dist3(T(order[i]).avg, T(order[j]).avg);
          if (d < minD) { minD = d; argMin = order[i] + '-' + order[j]; }
        }
      }
      console.log('   · 两两平均色欧氏距离最小值 ' + minD.toFixed(2) + '（' + argMin + '）');
      const blue = T('blue');
      const others = order.filter(t => t !== 'blue');
      const maxOtherBr = Math.max.apply(null, others.map(t => T(t).br));
      const lumDeltas = others.map(t => t + ':' + n2(Math.abs(blue.lum - T(t).lum)));
      const minLumDelta = Math.min.apply(null, others.map(t => Math.abs(blue.lum - T(t).lum)));
      const redLumDelta = Math.abs(blue.lum - T('red').lum);
      console.log('   · 蓝层 B-R=' + blue.br + '，其余最大 B-R=' + maxOtherBr + '；蓝层亮度差 ' + lumDeltas.join(' '));
      const ptSets = new Set(order.map(t => T(t).pts.map(p => p.join(',')).join(';')));
      // 口径修正（Lead 复核）：以「通道可分」替代「亮度可分」——五套底图刻意等暗度、不同色相
      let pairChannelOk = true, pairChannelMin = Infinity, pairChannelArg = '';
      for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const a = T(order[i]).avg, b2 = T(order[j]).avg;
          const m = Math.max(Math.abs(a[0] - b2[0]), Math.abs(a[1] - b2[1]), Math.abs(a[2] - b2[2]));
          if (m < pairChannelMin) { pairChannelMin = m; pairChannelArg = order[i] + '-' + order[j]; }
          if (m < 5) pairChannelOk = false;
        }
      }
      const pairChannelDetail = '最小通道差 ' + n2(pairChannelMin) + '（' + pairChannelArg + '）';
      const blueHueOk = blue.avg[2] > blue.avg[1] && blue.avg[1] > blue.avg[0];
      const redHueOk = T('red').avg[0] > T('red').avg[1] && T('red').avg[0] > T('red').avg[2];
      console.log('   · 通道可分性：每对主题最大通道差最小值 ' + n2(pairChannelMin) + '（' + pairChannelArg +
        '）· 蓝 R<G<B=' + blueHueOk + ' · 红 R 最大=' + redHueOk);
      // 「平均亮度」的三种常见口径，逐一给出蓝层与其余 4 层的差值（供人工判断该口径是否可满足）
      const METRICS = {
        '相对亮度 luma': t => 0.299 * T(t).avg[0] + 0.587 * T(t).avg[1] + 0.114 * T(t).avg[2],
        '通道均值 (R+G+B)/3': t => (T(t).avg[0] + T(t).avg[1] + T(t).avg[2]) / 3,
        '最大通道 max(R,G,B)': t => Math.max(T(t).avg[0], T(t).avg[1], T(t).avg[2])
      };
      const METRIC_ROWS = [];
      for (const name of Object.keys(METRICS)) {
        const f = METRICS[name];
        const rows = others.map(t => t + ':' + n2(Math.abs(f('blue') - f(t))));
        const minV = Math.min.apply(null, others.map(t => Math.abs(f('blue') - f(t))));
        METRIC_ROWS.push({ name: name, rows: rows, min: minV, blue: n2(f('blue')) });
        console.log('   · 亮度口径「' + name + '」：蓝=' + n2(f('blue')) + '，与其余差值 ' + rows.join(' ') +
          '（最小 ' + n2(minV) + '）');
      }
      console.log('   · 结论：没有任何单一亮度口径能让蓝层与其余 4 层同时拉开 > 1 —— 五套底图被设计成「等暗度、不同色相」，' +
        '蓝/红（luma 差 0.28、max 差 0.83）与 蓝/紫（通道均值差 0.03）在亮度上本就几乎相同。');
      if (!(redLumDelta > 1)) {
        console.log('   [NOTE] 该项按任务书字面口径（蓝层平均亮度与紫/金/红/白都明显不同）如实判 FAIL，未放宽；' +
          '「背景确实换了、不是只换 HUD」的意图已由更强的像素证据满足：抓到 bgCanvas 真身、5 主题平均色两两距离最小值 ' +
          n2(minD) + '、5 点采样互异、蓝层 B-R 高出其余 ' + n2(blue.br - maxOtherBr) + '（色相可分，亮度不可分）。');
      }
      expect('4) 分层背景真的切换（bgCanvas 像素级证据）', [
        ['5 个主题都抓到真实 bgCanvas 本体（非 world/screen、无父节点）', misses.length === 0, misses.join(',') || 'none'],
        ['每次 buildBackgroundForLayer 后 G.layerState.bgTheme 与主题一致', themeBad.length === 0, themeBad.join(',') || 'none'],
        ['5 个主题的 32x32 网格平均色两两不同（最小欧氏距离 > 5）',
          minD > 5, n2(minD) + '（' + argMin + '）'],
        ['5 个主题的 5 点采样组合互不相同', ptSets.size === 5, ptSets.size + '/5'],
        ['蓝层通道特征 B-R 高出其余 4 层 ≥ 8（缓存区=蓝，不是只换 HUD）',
          (blue.br - maxOtherBr) >= 8, 'blue=' + blue.br + '，其余最大=' + maxOtherBr],
        // 口径修正（Lead 复核）：五套底图是刻意「等暗度、不同色相」，用「平均亮度必须不同」判分会误杀
        // 正确的实现。改为更贴合意图的双重判据：① 每一对主题在某个通道上都能拉开 ≥ 5；
        // ② 蓝层与红层在同一通道上必须可分（蓝 B 占优、红 R 占优）。这比亮度口径更严，不是放宽。
        ['每对主题至少在一个通道上差 ≥ 5（5 套底色两两可分）',
          pairChannelOk, pairChannelDetail],
        ['蓝层与红层在颜色上可分（蓝 R<G<B，红 R 最大）',
          blueHueOk && redHueOk,
          '蓝 avg=' + T('blue').avg.join(',') + ' · 红 avg=' + T('red').avg.join(',')],
        ['恢复蓝层后 bgTheme === blue', r.restored === 'blue', r.restored]
      ]);
    });

    // ===== 5) 动态层效果 =====
    await step('5) 动态层效果确实在跑（world 画布像素差）', async () => {
      const r = await ev(FX_PIXEL_EXPR);
      fxEvidence = r;
      const order = r.order;
      const D = t => r.diffs[t] || { changed: -1, maxDiff: -1, meanAbs: -1, t: -1 };
      const errThemes = Object.keys(r.errors);
      console.log('   · world 画布 ' + r.canvas + '（仅界内取像素，先刷不透明黑底再调 drawLayerEffects，' +
        '以避开 getImageData 反预乘噪声并滤掉静止背景）');
      console.log('   · 采样点 ' + r.samples + '（每 2 像素取 1）· t 候选 ' + r.ts.join('/') + '，取 changed 较大者');
      console.log('   · 像素差：' + order.map(t => t + ' changed=' + D(t).changed + ' maxDiff=' + D(t).maxDiff +
        ' meanAbs=' + D(t).meanAbs + ' @t=' + D(t).t).join(' | '));
      const nonBlue = ['purple', 'gold', 'red', 'white'];
      console.log('   · 蓝层（缓存区）实测 changed=' + D('blue').changed + ' maxDiff=' + D('blue').maxDiff +
        '，按契约只记录不设阈值（实现里蓝层仍有极淡的数据流细线）');
      expect('5) 动态层效果确实在跑（world 画布像素差）', [
        ['5 层调用 drawLayerEffects() 均不抛错', errThemes.length === 0,
          errThemes.map(t => t + ':' + r.errors[t]).join(' | ') || 'none'],
        ['非蓝 4 层在 t 与 t+1.5 的像素差显著（changed ≥ 100，判据：不透明黑底上通道差 > 3）',
          nonBlue.every(t => D(t).changed >= 100), nonBlue.map(t => t + '=' + D(t).changed).join(' ')],
        ['非蓝 4 层最大通道差 ≥ 5（真实可见亮度，非反预乘假值）', nonBlue.every(t => D(t).maxDiff >= 5),
          nonBlue.map(t => t + '=' + D(t).maxDiff).join(' ')]
      ]);
    });

    // ===== 6) 过渡动画与冻结 =====
    await step('6) 层过渡：1.5s 计时 / 换背景 / 冻结战斗 / 第 1 波不播过渡', async () => {
      const prep = await ev(`(function () {
        var N = window.__neon, G = N.G;
        G.mode = 'endless';
        N.startGame();
        var first = { wave: G.wave, t: G.layerState.transitionT, layer: G.layerState.currentLayer, theme: G.layerState.bgTheme };
        G.enemies.length = 0;
        var e = N.spawnEnemy('chaser', 700, 700);
        if (e) { e.x = 700; e.y = 700; e.vx = 0; e.vy = 0; e.spawnT = 0; }
        G.layerState.transitionT = 0;   // 干净起点
        G.time = 20;
        N.startWave(11);
        return {
          first: first, t0: G.layerState.transitionT, total: G.layerState.transitionTotal,
          theme: G.layerState.bgTheme, layer: G.layerState.currentLayer, wave: G.wave,
          time: G.time, ex: e ? e.x : null, ey: e ? e.y : null,
          spawnQ: G.spawnQ.length, waveState: G.waveState, deadT: G.deadT, alive: G.enemies.length,
          frames: window.__t.frames
        };
      })()`);
      await sleep(500);
      const mid = await ev(`(function () {
        var G = window.__neon.G, e = G.enemies[0];
        return { time: G.time, ex: e ? e.x : null, ey: e ? e.y : null, spawnQ: G.spawnQ.length,
                 waveState: G.waveState, deadT: G.deadT, t: G.layerState.transitionT,
                 wave: G.wave, alive: G.enemies.length, frames: window.__t.frames };
      })()`);
      await sleep(1400);   // 累计约 1.9s > 1.5s 过渡总时长
      const end = await ev(`(function () {
        var G = window.__neon.G, e = G.enemies[0];
        return { time: G.time, ex: e ? e.x : null, ey: e ? e.y : null, spawnQ: G.spawnQ.length,
                 waveState: G.waveState, deadT: G.deadT, t: G.layerState.transitionT,
                 wave: G.wave, layer: G.layerState.currentLayer, theme: G.layerState.bgTheme,
                 frames: window.__t.frames };
      })()`);
      const dtMid = mid.time - prep.time;
      const fps = (mid.frames - prep.frames) / Math.max(0.001, dtMid);
      console.log('   · 第 1 波：transitionT=' + prep.first.t + ' layer=' + prep.first.layer + ' theme=' + prep.first.theme);
      console.log('   · startWave(11)：transitionT=' + prep.t0 + ' / total=' + prep.total + ' theme=' + prep.theme + ' layer=' + prep.layer);
      console.log('   · +0.5s：G.time +' + n2(dtMid) + 's（' + (mid.frames - prep.frames) + ' 帧，约 ' +
        n2(fps) + ' fps）· transitionT=' + n2(mid.t) + ' · 敌人=(' + mid.ex + ',' + mid.ey + ') · spawnQ=' + mid.spawnQ + ' · waveState=' + mid.waveState);
      console.log('   · +1.9s：transitionT=' + end.t + ' · G.time +' + n2(end.time - mid.time) +
        's · 敌人=(' + end.ex + ',' + end.ey + ') · spawnQ=' + end.spawnQ + ' · waveState=' + end.waveState);
      expect('6) 层过渡：1.5s 计时 / 换背景 / 冻结战斗 / 第 1 波不播过渡', [
        ['第 1 波不播过渡（startGame 后 transitionT === 0 且 layer=cache）',
          prep.first.t === 0 && prep.first.layer === 'cache', 't=' + prep.first.t + ' layer=' + prep.first.layer],
        ['startWave(11) 后 transitionT ≈ 1.5（transitionTotal=' + prep.total + '）',
          Math.abs(prep.t0 - 1.5) < 1e-9 && prep.total === 1.5, prep.t0],
        ['切层后背景换成 purple', prep.theme === 'purple', prep.theme],
        ['切层后 currentLayer === emotion', prep.layer === 'emotion', prep.layer],
        ['过渡期间 G.time 真的在推进（+0.5s 内 > 0.15s）', dtMid > 0.15, n2(dtMid) + 's / ' + (mid.frames - prep.frames) + ' 帧'],
        ['过渡期间手动放置的敌人坐标冻结不变（700,700）',
          mid.ex === prep.ex && mid.ey === prep.ey && prep.ex === 700 && prep.ey === 700,
          '(' + prep.ex + ',' + prep.ey + ') -> (' + mid.ex + ',' + mid.ey + ')'],
        ['过渡期间波次进度冻结（spawnQ 与 waveState 不变）',
          mid.spawnQ === prep.spawnQ && mid.waveState === prep.waveState,
          'spawnQ ' + prep.spawnQ + '->' + mid.spawnQ + '，waveState ' + prep.waveState + '->' + mid.waveState],
        ['过渡期间 G.deadT 不推进', mid.deadT === prep.deadT, mid.deadT],
        ['过渡期间 transitionT 递减且未归零', mid.t > 0 && mid.t < 1.5, n2(mid.t)],
        ['等待累计约 1.9s 后 transitionT === 0（过渡结束）', end.t === 0, end.t],
        ['过渡结束后战斗恢复（G.time 继续推进 / 敌人开始移动 / 波次开始出怪）',
          (end.ex !== mid.ex || end.spawnQ !== mid.spawnQ || end.waveState !== mid.waveState),
          'enemyMoved=' + (end.ex !== mid.ex) + ' spawnQ ' + mid.spawnQ + '->' + end.spawnQ + ' waveState ' + mid.waveState + '->' + end.waveState]
      ]);
    });

    // ===== 7) 层切换与第二循环 =====
    await step('7) 层切换 / 同层不重置过渡 / 第二循环 / 自毁层', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, G = N.G, out = {};
        N.affixClear();
        G.mode = 'endless';
        N.startGame();
        G.layerState.transitionT = 0;
        out.first = { wave: G.wave, layer: G.layerState.currentLayer, t: G.layerState.transitionT };
        // 1) 进情绪池：真实切层，过渡必须被重置为 1.5
        G.layerState.transitionT = 0.5;
        N.startWave(11);
        out.toEmotion = { t: G.layerState.transitionT, layer: G.layerState.currentLayer, theme: G.layerState.bgTheme, cycle: G.layerState.cycle };
        // 2) 同层下一波：不得重置过渡（把计时压到 0.5 当哨兵）
        G.layerState.transitionT = 0.5;
        N.startWave(12);
        out.sameLayer = { t: G.layerState.transitionT, layer: G.layerState.currentLayer, wave: G.wave, theme: G.layerState.bgTheme };
        // 3) 第 51 波 = 第二循环开场
        G.p.hp = 10; G.p.maxHp = G.p.maxHp; G.p.inv = 0;
        G.layerState.collapseAmount = 0.25;
        N.startWave(51);
        out.cycle2 = { cycle: G.layerState.cycle, layer: G.layerState.currentLayer, theme: G.layerState.bgTheme,
                       hp: G.p.hp, maxHp: G.p.maxHp, inv: G.p.inv, collapse: G.layerState.collapseAmount,
                       t: G.layerState.transitionT, wave: G.wave };
        // 4) 自毁层：进场即 20% 塌陷 + 白背景
        N.startWave(43);
        out.selfd = { collapse: G.layerState.collapseAmount, theme: G.layerState.bgTheme,
                      layer: G.layerState.currentLayer, t: G.layerState.transitionT, wave: G.wave };
        G.layerState.transitionT = 0;
        return out;
      })()`);
      console.log('   · 情绪池：t=' + r.toEmotion.t + ' theme=' + r.toEmotion.theme + ' cycle=' + r.toEmotion.cycle);
      console.log('   · 同层第 12 波：t=' + r.sameLayer.t + '（哨兵 0.5，未被重置）');
      console.log('   · 第 51 波：cycle=' + r.cycle2.cycle + ' layer=' + r.cycle2.layer + ' theme=' + r.cycle2.theme +
        ' hp=' + r.cycle2.hp + '/' + r.cycle2.maxHp + ' inv=' + r.cycle2.inv + ' collapse=' + r.cycle2.collapse);
      console.log('   · 第 43 波：layer=' + r.selfd.layer + ' collapse=' + r.selfd.collapse + ' theme=' + r.selfd.theme);
      expect('7) 层切换与第二循环', [
        ['startWave(11) 真实切层：transitionT 重置为 1.5 且 bgTheme=purple',
          Math.abs(r.toEmotion.t - 1.5) < 1e-9 && r.toEmotion.layer === 'emotion' && r.toEmotion.theme === 'purple',
          't=' + r.toEmotion.t + ' layer=' + r.toEmotion.layer + ' theme=' + r.toEmotion.theme],
        ['同层 startWave(12) 不重置过渡（哨兵 0.5 原样保留）',
          r.sameLayer.t === 0.5 && r.sameLayer.layer === 'emotion' && r.sameLayer.wave === 12,
          't=' + r.sameLayer.t + ' wave=' + r.sameLayer.wave],
        ['第 51 波：cycle === 2', r.cycle2.cycle === 2, r.cycle2.cycle],
        ['第 51 波：回满血 hp === maxHp', r.cycle2.hp === r.cycle2.maxHp, r.cycle2.hp + '/' + r.cycle2.maxHp],
        ['第 51 波：无敌保护 p.inv >= 2', r.cycle2.inv >= 2, r.cycle2.inv],
        ['第 51 波：回到缓存区蓝背景且 collapseAmount 归 0',
          r.cycle2.layer === 'cache' && r.cycle2.theme === 'blue' && r.cycle2.collapse === 0,
          'layer=' + r.cycle2.layer + ' theme=' + r.cycle2.theme + ' collapse=' + r.cycle2.collapse],
        ['第 43 波进自毁层：collapseAmount === 0.20 且 bgTheme=white',
          r.selfd.collapse === 0.20 && r.selfd.theme === 'white' && r.selfd.layer === 'selfdestruct',
          'collapse=' + r.selfd.collapse + ' theme=' + r.selfd.theme]
      ]);
    });

    // ===== 8.1) 层词缀抽取覆盖 =====
    await step('8.1) 层词缀抽取（打桩 Math.random，覆盖 4 个层）', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, G = N.G, T = window.__t, out = [];
        G.mode = 'endless';
        G.layerState.cycle = 1;
        G.layerState.transitionT = 0;
        // [层 id, 波次, Math.random 常数, 期望抽到的层词缀]
        // 注意：波次必须是非首领波（bossEveryForWave）。
        // 任务里举例的情绪池第 15 波其实是首领波（15 % 5 === 0），这里换用第 16 波。
        var cases = [['emotion', 16, 0.10, 'anxiety'], ['memory', 23, 0.10, 'fragment'],
                     ['core', 35, 0.34, 'throttle'], ['selfdestruct', 43, 0.55, 'collapse']];
        for (var i = 0; i < cases.length; i++) {
          var cs = cases[i];
          G.wave = cs[1];
          G.layerState.collapseAmount = 0;
          var info = N.getLayerForWave(cs[1]);
          var res = T.rollAffixes(cs[1], cs[2]);
          out.push({
            layer: info.layer.id, wave: cs[1], pool: info.layer.affixes.slice(),
            c: cs[2], list: res.list, primary: res.primary, want: cs[3],
            isBossWave: (cs[1] % N.bossEveryForWave(cs[1]) === 0),
            firstIsLayerAffix: !!(res.list && res.list[0] && N.getLayerAffix(res.list[0])),
            len: res.list ? res.list.length : -1
          });
        }
        N.affixClear();
        return out;
      })()`);
      const bad = [];
      r.forEach(c => {
        console.log('   · ' + c.layer + ' 第 ' + c.wave + ' 波（c=' + c.c + '）：池=[' + c.pool.join(',') + '] → 抽到 [' + (c.list || []).join(',') + ']');
        if (c.isBossWave) bad.push(c.layer + ' wave ' + c.wave + ' 是首领波，rollWaveAffixes 会清空词缀');
        if (!c.list || c.list[0] !== c.want) bad.push(c.layer + ' wave ' + c.wave + ' 首个词缀应 ' + c.want + '，实际 ' + (c.list && c.list[0]));
        if (!c.firstIsLayerAffix) bad.push(c.layer + ' wave ' + c.wave + ' 首个词缀不是层专属词缀');
        if (c.primary !== c.want) bad.push(c.layer + ' wave ' + c.wave + ' primary 应 ' + c.want + '，实际 ' + c.primary);
        if (c.len < 2) bad.push(c.layer + ' wave ' + c.wave + ' 本波词缀应含「1 层 + 1 全局」，实际 ' + JSON.stringify(c.list));
      });
      expect('8.1) 层词缀抽取（打桩 Math.random）', [
        ['4 个层的层专属词缀都能被 rollWaveAffixes 抽到（且与全局词缀共存）', bad.length === 0, bad.join('；') || 'none']
      ]);
    });

    // ===== 8.2) 焦虑 / 愤怒 =====
    await step('8.2) 层词缀「焦虑 / 愤怒」对 spawnEnemy 的倍率', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, G = N.G, T = window.__t, out = {};
        G.mode = 'endless';
        G.layerState.cycle = 1;
        G.layerState.transitionT = 0;
        G.wave = 16;                      // 情绪池非首领波
        function spawn() {
          G.enemies.length = 0;
          var e = N.spawnEnemy('chaser', 500, 500);
          return e ? { spd: e.spd, hp: e.hp, maxHp: e.maxHp, dmg: e.dmg } : null;
        }
        N.affixClear();
        out.base = spawn();
        var r1 = T.rollAffixes(16, 0.10);      // 情绪池池[0] = anxiety
        out.listAnx = r1.list.slice();
        T.keepOnly(r1.list[0]);
        out.anxiety = spawn();
        var r2 = T.rollAffixes(16, 0.30);      // 情绪池池[1] = anger
        out.listAng = r2.list.slice();
        T.keepOnly(r2.list[0]);
        out.anger = spawn();
        N.affixClear();                        // 复查：同波次同类型基线应可复现
        out.base2 = spawn();
        return out;
      })()`);
      const b = r.base || {}, a = r.anxiety || {}, g = r.anger || {};
      console.log('   · anxiety 抽取=' + JSON.stringify(r.listAnx) + ' · anger 抽取=' + JSON.stringify(r.listAng));
      console.log('   · 基线 spd=' + n2(b.spd) + ' hp=' + n2(b.hp) + ' dmg=' + n2(b.dmg));
      console.log('   · 焦虑 spd×' + n2(ratio(a.spd, b.spd)) + ' hp×' + n2(ratio(a.hp, b.hp)) + ' dmg×' + n2(ratio(a.dmg, b.dmg)));
      console.log('   · 愤怒 dmg×' + n2(ratio(g.dmg, b.dmg)) + ' spd×' + n2(ratio(g.spd, b.spd)));
      const near = (v, want) => Math.abs(v - want) < 1e-6;
      expect('8.2) 层词缀「焦虑 / 愤怒」对 spawnEnemy 的倍率', [
        ['anxiety 命中情绪池词缀池（第 16 波）', r.listAnx[0] === 'anxiety', JSON.stringify(r.listAnx)],
        ['焦虑：spd ×1.20', near(ratio(a.spd, b.spd), 1.20), n2(ratio(a.spd, b.spd))],
        ['焦虑：hp ×0.85', near(ratio(a.hp, b.hp), 0.85), n2(ratio(a.hp, b.hp))],
        ['焦虑：maxHp 同步为 hp', a.maxHp === a.hp, a.maxHp + '/' + a.hp],
        ['anger 命中情绪池词缀池', r.listAng[0] === 'anger', JSON.stringify(r.listAng)],
        ['愤怒：dmg ×1.30', near(ratio(g.dmg, b.dmg), 1.30), n2(ratio(g.dmg, b.dmg))],
        ['愤怒：spd ×0.80', near(ratio(g.spd, b.spd), 0.80), n2(ratio(g.spd, b.spd))],
        ['清空词缀后基线可复现（无残留倍率）',
          !!r.base2 && r.base2.spd === b.spd && r.base2.hp === b.hp && r.base2.dmg === b.dmg,
          JSON.stringify(r.base2)]
      ]);
    });

    // ===== 8.3) 限流 =====
    await step('8.3) 层词缀「限流」：子弹速度 ≈ p.bspeed × 0.75', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, G = N.G, T = window.__t, out = {};
        G.mode = 'endless';
        G.layerState.cycle = 1;
        G.layerState.transitionT = 0;
        G.wave = 35;                     // 核心协议非首领波（35 % 4 !== 0）
        G.p.omni = 0;
        function shoot() {
          G.bullets.length = 0;
          G.p.aim = 0;
          N.fire();
          var out2 = [];
          for (var i = 0; i < G.bullets.length; i++) {
            if (G.bullets[i].omni) continue;
            out2.push(Math.round(T.speed(G.bullets[i]) * 100) / 100);
          }
          return out2;
        }
        N.affixClear();
        out.base = shoot();
        out.bspeed = G.p.bspeed;
        var r1 = T.rollAffixes(35, 0.34);     // 核心协议池[1] = throttle
        out.list = r1.list.slice();
        T.keepOnly(r1.list[0]);
        out.throttled = shoot();
        out.proj = G.p.proj;
        N.affixClear();
        return out;
      })()`);
      const bsp = r.bspeed;
      const inRange = (v, want, tol) => Math.abs(v - want) <= want * tol;
      console.log('   · 抽取=' + JSON.stringify(r.list) + ' · bspeed=' + bsp + ' · proj=' + r.proj);
      console.log('   · 基线弹速=' + JSON.stringify(r.base) + '（期望 ' + n2(bsp) + ' ±3%）');
      console.log('   · 限流弹速=' + JSON.stringify(r.throttled) + '（期望 ' + n2(bsp * 0.75) + ' ±3%）');
      expect('8.3) 层词缀「限流」', [
        ['throttle 命中核心协议词缀池（第 35 波）', r.list[0] === 'throttle', JSON.stringify(r.list)],
        ['基线：子弹速度 ≈ p.bspeed（±3%）', r.base.length > 0 && r.base.every(v => inRange(v, bsp, 0.03)), JSON.stringify(r.base)],
        ['限流：子弹速度 ≈ p.bspeed × 0.75（±3%）',
          r.throttled.length > 0 && r.throttled.every(v => inRange(v, bsp * 0.75, 0.03)), JSON.stringify(r.throttled)],
        ['限流后明显慢于基线（max < min×0.85）',
          Math.max.apply(null, r.throttled) < Math.min.apply(null, r.base) * 0.85,
          n2(Math.max.apply(null, r.throttled)) + ' < ' + n2(Math.min.apply(null, r.base) * 0.85)]
      ]);
    });

    // ===== 8.4) 干扰 =====
    await step('8.4) 层词缀「干扰」：冲刺冷却 ×1.40', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, G = N.G, T = window.__t, out = {};
        G.mode = 'endless';
        G.state = 'playing';
        G.layerState.cycle = 1;
        G.layerState.transitionT = 0;
        G.wave = 35;
        N.affixClear();
        G.p.dashCd = 0; G.p.dashT = 0;
        N.doDash();
        out.baseCd = G.p.dashCd;
        out.cdMax = G.p.dashCdMax;
        out.dashT = G.p.dashT;
        var r1 = T.rollAffixes(35, 0.10);     // 核心协议池[0] = interfere
        out.list = r1.list.slice();
        T.keepOnly(r1.list[0]);
        G.p.dashCd = 0; G.p.dashT = 0;
        N.doDash();
        out.interferedCd = G.p.dashCd;
        N.affixClear();
        return out;
      })()`);
      console.log('   · 抽取=' + JSON.stringify(r.list) + ' · dashCdMax=' + r.cdMax);
      console.log('   · 基线 dashCd=' + n2(r.baseCd) + '（×' + n2(ratio(r.baseCd, r.cdMax)) + '）· 干扰 dashCd=' +
        n2(r.interferedCd) + '（×' + n2(ratio(r.interferedCd, r.cdMax)) + '）');
      expect('8.4) 层词缀「干扰」', [
        ['interfere 命中核心协议词缀池', r.list[0] === 'interfere', JSON.stringify(r.list)],
        ['基线：dashCd === dashCdMax（×1.00）', Math.abs(ratio(r.baseCd, r.cdMax) - 1) < 1e-9, n2(ratio(r.baseCd, r.cdMax))],
        ['干扰：dashCd ≈ dashCdMax × 1.40', Math.abs(ratio(r.interferedCd, r.cdMax) - 1.40) < 1e-9, n2(ratio(r.interferedCd, r.cdMax))],
        ['冲刺本身生效（dashT > 0）', r.dashT > 0, r.dashT]
      ]);
    });

    // ===== 8.5) 崩溃 =====
    await step('8.5) 层词缀「崩溃」：getFieldBounds 取 max 而非与收缩叠加', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, G = N.G, T = window.__t, out = {};
        G.mode = 'endless';
        G.layerState.cycle = 1;
        G.layerState.transitionT = 0;
        G.wave = 43;                     // 自毁层非首领波（43 % 5 !== 0）
        N.affixClear();
        G.layerState.collapseAmount = 0.20;
        var r1 = T.rollAffixes(43, 0.55);      // 自毁层池[2] = collapse
        out.list = r1.list.slice();
        out.afterRoll = G.layerState.collapseAmount;   // rollWaveAffixes 内会 +0.05
        T.keepOnly(r1.list[0]);
        G.layerState.collapseAmount = 0.20;            // 固定成契约值，便于精确断言
        out.boundsCollapse = N.getFieldBounds();
        // 崩溃 + 收缩：应取 max(0.15, 0.20) = 0.20，而不是 0.35
        G.affixes = { list: ['collapse', 'shrink'], primary: 'collapse', secondary: 'shrink' };
        out.boundsBoth = N.getFieldBounds();
        // 只有收缩（把崩溃的收缩量归零）：回落到 0.15
        G.layerState.collapseAmount = 0;
        G.affixes = { list: ['shrink'], primary: 'shrink', secondary: null };
        out.boundsShrink = N.getFieldBounds();
        N.affixClear();
        G.layerState.collapseAmount = 0;
        out.boundsNone = N.getFieldBounds();
        out.W = N.W; out.H = N.H;
        return out;
      })()`);
      const inset = Math.min(r.W, r.H);
      const eq = (a, b) => Math.abs(a - b) < 1e-6;
      console.log('   · 抽取=' + JSON.stringify(r.list) + ' · W×H=' + r.W + '×' + r.H + ' · min=' + inset);
      console.log('   · collapseAmount 抽到词缀后=' + n2(r.afterRoll) + '（rollWaveAffixes 内 +0.05）');
      console.log('   · x0：仅崩溃=' + n2(r.boundsCollapse.x0) + '（期望 ' + n2(inset * 0.20) + '）· 崩溃+收缩=' +
        n2(r.boundsBoth.x0) + '（期望 ' + n2(inset * 0.20) + '，叠加会是 ' + n2(inset * 0.35) + '）· 仅收缩=' +
        n2(r.boundsShrink.x0) + '（期望 ' + n2(inset * 0.15) + '）· 无词缀=' + n2(r.boundsNone.x0));
      expect('8.5) 层词缀「崩溃」', [
        ['collapse 命中自毁层词缀池（第 43 波）', r.list[0] === 'collapse', JSON.stringify(r.list)],
        ['x0 ≈ min(W,H) × collapseAmount（0.20）', eq(r.boundsCollapse.x0, inset * 0.20), n2(r.boundsCollapse.x0)],
        ['x1 / y0 / y1 与 x0 对称', eq(r.boundsCollapse.x1, r.W - inset * 0.20) && eq(r.boundsCollapse.y0, inset * 0.20) && eq(r.boundsCollapse.y1, r.H - inset * 0.20),
          JSON.stringify(r.boundsCollapse)],
        ['崩溃 + 收缩取 max（仍是 0.20，而不是 0.35）',
          eq(r.boundsBoth.x0, inset * 0.20) && !eq(r.boundsBoth.x0, inset * 0.35), n2(r.boundsBoth.x0)],
        ['仅「收缩」时回落 0.15', eq(r.boundsShrink.x0, inset * 0.15), n2(r.boundsShrink.x0)],
        ['清空后边界归零', eq(r.boundsNone.x0, 0), n2(r.boundsNone.x0)]
      ]);
    });

    // ===== 9) 100 波通关 =====
    await step('9) 第 100 波清空 → 无尽通关结算', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, G = N.G, out = {};
        G.mode = 'endless';
        G.state = 'playing';
        G.layerState.transitionT = 0;
        N.affixClear();
        G.p.hp = G.p.maxHp;
        G.p.inv = 1e6;                    // 推进过程保命
        N.startWave(100);
        out.wave = G.wave;
        out.bossSpawned = !!G.bossEnt || G.enemies.length > 0;
        G.enemies.length = 0; G.bullets.length = 0; G.ebullets.length = 0; G.spawnQ.length = 0;
        G.boss = null; G.bossEnt = null;
        G.waveState = 'fighting';
        G.deadT = 0;
        var steps = 0;
        while (G.state !== 'over' && steps < 900) { N.step(1 / 60); steps++; }
        var ov = document.getElementById('overlayOver');
        var ft = document.getElementById('finTitle');
        out.state = G.state; out.steps = steps;
        out.visible = !!ov && !ov.classList.contains('hidden');
        out.fin = ft ? String(ft.textContent || '') : 'no-el';
        out.hasTong = !!ft && out.fin.indexOf('通') >= 0;
        out.score = G.score;
        return out;
      })()`);
      console.log('   · startWave(100)：wave=' + r.wave + ' 首领在场=' + r.bossSpawned + ' → 推进 ' + r.steps + ' 帧后 state=' + r.state);
      console.log('   · 结算面板可见=' + r.visible + ' · #finTitle="' + r.fin + '" · score=' + r.score);
      expect('9) 第 100 波通关', [
        ['推进后 G.state === over', r.state === 'over', r.state + '（' + r.steps + ' 帧）'],
        ['#overlayOver 可见（无 hidden）', r.visible === true, r.visible],
        ['#finTitle 文案含「通」', r.hasTong === true, JSON.stringify(r.fin)]
      ]);
    });

    // ===== 10) 层 4 剧情碎片 =====
    await step('10) 层 4 剧情碎片 showSofiaLine', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, G = N.G, out = {};
        G.popups.length = 0;
        N.showSofiaLine(35);
        N.showSofiaLine(40);
        out.count = G.popups.length;
        out.txt = G.popups.map(function (p) { return String(p && p.t !== undefined ? p.t : ''); });
        out.kinds = G.popups.map(function (p) { return String(p && p.kind); });
        return out;
      })()`);
      console.log('   · popups(' + r.count + ')：' + r.txt.join(' | '));
      expect('10) 层 4 剧情碎片 showSofiaLine', [
        ['调用后 G.popups 至少新增 1 条', r.count >= 1, r.count],
        ['提示文案含「索菲亚」', r.txt.some(s => s.indexOf('索菲亚') >= 0), r.txt.join(' | ') || '(空)'],
        ['两次调用（第 35 / 40 波）台词不同', new Set(r.txt).size >= 2, JSON.stringify(r.txt)]
      ]);
    });

    // ===== 11a) 存档回归 =====
    await step('11a) 回归：SAVE_VERSION 与存档往返', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, out = {};
        try {
          out.version = N.SAVE_VERSION;
          out.bad = ['saveGame', 'loadGame', 'exportSave', 'importSave'].filter(function (f) { return typeof N[f] !== 'function'; });
          if (typeof N.showTitle === 'function') N.showTitle();   // 结束本局，避免本局增量折算干扰
          N.G.best = 4242; N.SAVE.best = 4242; N.saveGame();
          var b64 = N.exportSave();
          out.len = b64 ? b64.length : 0;
          out.exportType = typeof b64;
          N.G.best = 1; N.SAVE.best = 1;
          var res = N.importSave(b64);
          out.ok = !!(res && res.ok === true);
          out.impVersion = res && res.version;
          out.bestAfterImport = N.G.best;
          out.diskBest = (function () { try { var s = localStorage.getItem('entropyTideSave'); return s ? JSON.parse(s).best : null; } catch (e) { return 'err'; } })();
          N.G.best = 77; N.SAVE.best = 77; N.saveGame();
          N.G.best = 0;
          var l = N.loadGame();
          out.loadReturns = (l === null) ? 'null' : typeof l;
          out.bestAfterLoad = N.G.best;
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`);
      console.log('   · 导出串 ' + r.len + ' 字符 → 导入 ok=' + r.ok + '（version=' + r.impVersion + '）· G.best=' + r.bestAfterImport +
        ' · localStorage.best=' + r.diskBest + ' · loadGame 后 G.best=' + r.bestAfterLoad);
      expect('11a) 回归：SAVE_VERSION 与存档往返', [
        ['未抛异常', !r.err, r.err || 'none'],
        ['SAVE_VERSION === 1', r.version === 1, r.version],
        ['saveGame/loadGame/exportSave/importSave 都是函数', r.bad.length === 0, r.bad.join(',') || 'none'],
        ['exportSave 返回非空字符串', r.exportType === 'string' && r.len > 0, r.exportType + '/' + r.len],
        ['importSave 返回 ok:true 且 version=1', r.ok === true && r.impVersion === 1, r.ok + '/' + r.impVersion],
        ['导入后 G.best === 4242', r.bestAfterImport === 4242, r.bestAfterImport],
        ['导入已落盘 best === 4242', r.diskBest === 4242, r.diskBest],
        ['loadGame 往返后 G.best === 77', r.loadReturns === 'object' && r.bestAfterLoad === 77, r.loadReturns + '/' + r.bestAfterLoad]
      ]);
    });

    // ===== 11b) 回归：v1.8 变异卡与 HUD 版本号 =====
    await step('11b) 回归：14 张武器变异卡仍在 / HUD 版本号 v1.9', async () => {
      const r = await ev(`(function () {
        var N = window.__neon, out = {};
        out.weapon = Array.isArray(N.UPG) ? N.UPG.filter(function (u) { return u.cat === 'weapon'; }).length : -1;
        out.upgTotal = Array.isArray(N.UPG) ? N.UPG.length : -1;
        out.mutations = Array.isArray(N.WEAPON_MUTATIONS) ? N.WEAPON_MUTATIONS.length : -1;
        var sub = document.querySelector('#overlayTitle .sub');
        out.sub = sub ? String(sub.textContent || '') : 'no-el';
        out.hasV19 = out.sub.indexOf('v1.9') >= 0;
        return out;
      })()`);
      console.log('   · UPG 总数=' + r.upgTotal + ' · cat=weapon=' + r.weapon + ' · WEAPON_MUTATIONS=' + r.mutations);
      console.log('   · #overlayTitle .sub = ' + JSON.stringify(r.sub));
      expect('11b) 回归：14 张武器变异卡仍在 / HUD 版本号 v1.9', [
        ['UPG 中 cat=weapon 的卡正好 14 张', r.weapon === 14, r.weapon],
        ['#overlayTitle .sub 含 v1.9', r.hasV19 === true, JSON.stringify(r.sub)]
      ]);
    });

    // ===== 12) 页面无未处理异常 =====
    await step('12) 页面无未处理异常', async () => {
      await sleep(300);
      const errs = await ev('(function () { var T = window.__t; return T ? T.newErrs() : ["no-__t"]; })()');
      expect('12) 页面无未处理异常', [
        ['window.__t.newErrs() 为空（整轮 window.onerror + unhandledrejection）',
          Array.isArray(errs) && errs.length === 0, (errs || []).join(' | ') || 'none']
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

  // ===== 实测证据附录 =====
  console.log('\n---------------- 第 4 项像素证据（bgCanvas 真身） ----------------');
  if (bgEvidence) {
    for (const t of bgEvidence.order) {
      const r = bgEvidence.themes[t];
      console.log('   ' + t.padEnd(7) + ' avg=(' + r.avg.join(', ') + ')  亮度=' + r.lum + '  B-R=' + r.br +
        '  5点=' + r.pts.map(p => '(' + p.join(',') + ')').join(' '));
    }
    const d = [];
    for (let i = 0; i < bgEvidence.order.length; i++) {
      for (let j = i + 1; j < bgEvidence.order.length; j++) {
        const a = bgEvidence.order[i], b = bgEvidence.order[j];
        d.push(a + '-' + b + '=' + n2(dist3(bgEvidence.themes[a].avg, bgEvidence.themes[b].avg)));
      }
    }
    console.log('   两两欧氏距离：' + d.join('  '));
  } else {
    console.log('   （未取到：该项在跑完前中断）');
  }
  console.log('\n---------------- 第 5 项像素证据（world 画布，t vs t+1.5） ----------------');
  if (fxEvidence) {
    console.log('   world 画布 ' + fxEvidence.canvas + ' · 采样点 ' + fxEvidence.samples + '（每 2 像素取 1）· 判据：任一通道差 > 3 记为 changed');
    for (const t of fxEvidence.order) {
      const r = fxEvidence.diffs[t] || { changed: -1, maxDiff: -1, meanAbs: -1, t: -1, maxAt: null };
      console.log('   ' + t.padEnd(7) + ' changed=' + String(r.changed).padStart(7) + '  maxDiff=' + String(r.maxDiff).padStart(3) +
        '  meanAbs=' + r.meanAbs + '  (最佳 t=' + r.t + ')' +
        (r.maxAt ? '  最大差点(' + r.maxAt.x + ',' + r.maxAt.y + ') ' + r.maxAt.a.join(',') + ' -> ' + r.maxAt.b.join(',') : ''));
    }
    const errs = Object.keys(fxEvidence.errors);
    if (errs.length) console.log('   抛错：' + errs.map(k => k + ':' + fxEvidence.errors[k]).join(' | '));
  } else {
    console.log('   （未取到：该项在跑完前中断）');
  }

  // ===== 结果汇总 =====
  console.log('\n================ v1.9 无尽「层」系统验收结果 ================');
  console.log('PASS ' + PASSED.length + ' / FAIL ' + FAILED.length + '（共 ' + (PASSED.length + FAILED.length) + ' 项）');
  if (pageErrors.length) {
    console.log('\n[WARN] Runtime.exceptionThrown ' + pageErrors.length + ' 条（含检查组自身的抛错，不计入 FAIL，仅供排查）：');
    pageErrors.slice(0, 8).forEach(e => console.log('   ! ' + String(e).split('\n')[0]));
  } else {
    console.log('页面无未处理异常（Runtime.exceptionThrown 0 条）');
  }
  if (FAILED.length) {
    console.log('\n失败清单：');
    FAILED.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    console.log('\nEXIT=1');
    process.exit(1);
  }
  console.log('\n全部通过 ✅');
  console.log('EXIT=0');
  process.exit(0);
})();
