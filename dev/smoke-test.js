// 无头冒烟测试：桩化 DOM + Canvas，模拟真实帧推进，抓运行时错误
//   A 段：普通机器人狂按键盘/鼠标自由混战
//   B 段：不死机器人（自动瞄准）推进到多轮 Boss，覆盖弹幕/相位/升级池抽空
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 游戏文件解析：优先同目录的 dev/neon-arena.html，其次仓库根目录的 index.html。
// 这样无论从 dev/ 还是仓库根目录运行都能找到同一个文件。
function resolveGameFile() {
  const candidates = [
    path.join(__dirname, 'neon-arena.html'),
    path.join(__dirname, 'index.html'),
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, '..', '..', 'neon-arena.html')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  console.error('FAIL: 找不到游戏文件，尝试过：\n  ' + candidates.join('\n  '));
  process.exit(1);
}
const htmlPath = resolveGameFile();
const html = fs.readFileSync(htmlPath, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: 未找到 <script> 块'); process.exit(1); }
const code = m[1];

// ---------- 桩化 Canvas 2D 上下文 ----------
const gradient = { addColorStop() {} };
const ctxMethods = ['save','restore','translate','rotate','scale','setTransform','resetTransform',
  'beginPath','closePath','moveTo','lineTo','quadraticCurveTo','bezierCurveTo','arc','arcTo','rect',
  'fill','stroke','clip','fillRect','strokeRect','clearRect','drawImage','fillText','strokeText',
  'setLineDash','measureText','createPattern'];
const ctxProps = ['fillStyle','strokeStyle','lineWidth','lineCap','lineJoin','globalAlpha',
  'globalCompositeOperation','shadowColor','shadowBlur','shadowOffsetX','shadowOffsetY',
  'font','textAlign','textBaseline','filter','imageSmoothingEnabled','miterLimit'];
function makeCtx(label) {
  const c = { __label: label || 'ctx', __maxDestW: 0 };
  for (const k of ctxMethods) c[k] = () => (k === 'measureText' ? { width: 10 } : undefined);
  // 记录世界画布上 drawImage 的目标宽度，用于捕捉「把设备像素尺寸画进逻辑画布」这类回归
  c.drawImage = function (img, a, b, cw, ch, dx, dy, dw, dh) {
    if (dw !== undefined && dw > c.__maxDestW) c.__maxDestW = dw;
  };
  for (const k of ctxProps) c[k] = '';
  c.createRadialGradient = () => gradient;
  c.createLinearGradient = () => gradient;
  c.getImageData = () => ({ data: new Uint8ClampedArray(4) });
  return c;
}

// ---------- 桩化元素 ----------
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: '',
    children: [], style: {}, _handlers: {},
    className: '', textContent: '', _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (v === '') this.children.length = 0; },
    width: 0, height: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
    },
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { (this._handlers[t] || []).forEach(fn => fn(ev || {})); },
    click() { this.dispatch('click', { button: 0 }); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: 节点不存在');
      this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    get firstChild() { return this.children[0] || null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 960 }; },
    getAttribute(k) { return this._attrs ? this._attrs[k] : null; },
    setAttribute(k, v) { (this._attrs = this._attrs || {})[k] = v; },
    getContext(kind) {
      const key = kind === '2d' ? '__c2d' : '__c_' + kind;
      if (!this[key]) this[key] = makeCtx(this.tagName + (this.id ? '#' + this.id : ''));
      return this[key];
    },
    focus() {}
  };
  return el;
}

// ---------- 桩化 document ----------
const els = {};
for (const id of ['screen','overlayTitle','overlayMode','overlayCls','overlayStory',
                  'overlayUp','overlayPause','overlayOver','cards',
                  'overlayTalents','talentTree','talentPoints','btnTalentClose','btnTalentReset',
                  'btnUpRefresh','btnStorySkip','finNote',
                  'overlayEvent','eventTitle','eventLore','eventBody',
                  'uptitle','upsub','pickhint','finStats','finTitle','modepick','clspick',
                  'clssub','storyHead','storyBody',
                  'btnEnter','btnModeBack','btnModeNext','btnClsBack','btnStoryNext',
                  'btnStart','btnAgain','btnMenu','btnResume','btnQuit','game']) {
  els[id] = makeEl(id === 'screen' ? 'canvas' : 'div');
  els[id].id = id;
}
els.game.appendChild(els.screen);
const diffEls = ['easy','normal','hard'].map(d => { const e = makeEl('div'); e._attrs = { 'data-diff': d }; return e; });

const document = {
  getElementById(id) { return els[id] || makeEl('div'); },
  createElement(tag) { return makeEl(tag); },
  querySelectorAll(sel) { return sel.indexOf('diffrow') >= 0 ? diffEls : []; },
  addEventListener() {},
  body: makeEl('body')
};

// ---------- 桩化 window / 计时器 ----------
let timerSeq = 1;
const timers = new Map();
function addTimer(fn, ms) { const id = timerSeq++; timers.set(id, { fn, ms, t: ms }); return id; }
function delTimer(id) { timers.delete(id); }
let rafCb = null;
const sandbox = {
  console, document, window: null,
  navigator: { maxTouchPoints: 0, userAgent: 'node' },
  location: { hash: '', href: 'file:///neon-arena.html' },
  localStorage: (function () {
    var store = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; },
      clear: function () { store = {}; },
      __store: store
    };
  })(),
  requestAnimationFrame(fn) { rafCb = fn; return 1; },
  cancelAnimationFrame() {},
  setTimeout: addTimer, clearTimeout: delTimer, setInterval: addTimer, clearInterval: delTimer,
  Math, Date, JSON, Object, Array, String, Number, Boolean, Error, isNaN, parseInt, parseFloat,
  Set, Map, Uint8ClampedArray, Float32Array, Symbol, RegExp, Promise, TypeError
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};
// 记录游戏向 window 注册的键盘监听（浏览器里按键事件走 window）
const winKeyHandlers = {};
sandbox.window.addEventListener = (type, fn) => { (winKeyHandlers[type] = winKeyHandlers[type] || []).push(fn); };
sandbox.window.removeEventListener = () => {};
sandbox.window.dispatchEvent = function (e) { (winKeyHandlers[e.type] || []).forEach(fn => fn(e)); };

const context = vm.createContext(sandbox);
try {
  vm.runInContext(code, context, { filename: 'neon-arena-inline.js' });
} catch (e) {
  console.error('FAIL: 脚本加载即抛错 ->', e && e.stack || e);
  process.exit(1);
}
const neon = sandbox.__neon;
if (!neon) { console.error('FAIL: 未暴露 window.__neon 自检入口'); process.exit(1); }
const G = neon.G;
const ev = (type, obj) => els.screen.dispatch(type, obj);
function keyDown(k) { sandbox.window.dispatchEvent({ type: 'keydown', key: k, preventDefault() {} }); }
function keyUp(k) { sandbox.window.dispatchEvent({ type: 'keyup', key: k, preventDefault() {} }); }
// 清空所有按键状态：避免上一阶段遗留的「按下中」按键互相抵消
function releaseAllKeys() { ['w', 'a', 's', 'd', ' ', 'p', 'Escape'].forEach(keyUp); }

// 渲染管线不变量：世界画布必须是固定「视口」分辨率，绘制不得越出它
const worldEl = neon.world;
if (!worldEl) { console.error('FAIL: 未暴露 world 画布'); process.exit(1); }
if (worldEl.width !== neon.VW || worldEl.height !== neon.VH) {
  console.error('FAIL: 视口画布应为 ' + neon.VW + 'x' + neon.VH + '，实际 ' + worldEl.width + 'x' + worldEl.height);
  process.exit(1);
}
if (!(neon.W > neon.VW && neon.H > neon.VH)) {
  console.error('FAIL: 战场尺寸必须大于视口才能有相机跟随（W=' + neon.W + ' H=' + neon.H + '）');
  process.exit(1);
}
function checkRenderInvariants() {
  const wc = worldEl.__c2d;
  if (wc && wc.__maxDestW > neon.VW) {
    console.error('FAIL: 有绘制把 ' + wc.__maxDestW + 'px 宽的目标画进 ' + neon.VW + 'px 视口画布');
    process.exit(1);
  }
}
console.log('OK  脚本加载并初始化完成（IIFE 未抛错，__neon 已暴露）');

// ---------- 帧驱动器 ----------
let t = 0, frames = 0;
function tickFrame() {
  t += 16.7;
  timers.forEach(tm => { tm.t -= 16.7; if (tm.t <= 0) { tm.t = tm.ms; if (tm.ms <= 120) tm.fn(); } });
  try { rafCb(t); } catch (e) {
    console.error('FAIL: 第 ' + frames + ' 帧 (t=' + Math.round(t) + 'ms) 抛错 ->', e && e.stack || e);
    process.exit(1);
  }
  frames++;
  checkRenderInvariants();
}
function aimAtNearest() {
  const p = G.p;
  if (!p) return;
  let best = null, bd = Infinity;
  for (const e of G.enemies) {
    if (e.dead) continue;
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  ev('mousemove', best ? { clientX: best.x, clientY: best.y } : { clientX: 720, clientY: 480 });
}

// ============================================================
//  0 段：分步流程（标题 -> 模式 -> 剧情 -> 职业）与序章剧情
// ============================================================
assert(!els.overlayTitle.classList.contains('hidden'), '开局未停在标题页');
assert(els.overlayMode.classList.contains('hidden'), '开局就显示了模式页');
// 静态标记直接校验源文件（桩 DOM 不解析页面里的静态 innerHTML）
const rawHtml = fs.readFileSync(htmlPath, 'utf8');
assert(/class="gametitle">熵/.test(rawHtml), '标题页未显示游戏标题《熵潮》');
assert(/id="btnEnter"/.test(rawHtml), '标题页缺少开始按钮');
assert(/索菲亚主机的最后一支杀毒协议/.test(rawHtml), '标题页缺少剧情副标题');
console.log('0-1段 OK 开局停在标题页《熵潮》，含标题、副标题与开始按钮');

els.btnEnter.click();
assert(!els.overlayMode.classList.contains('hidden'), '点开始后未进入模式选择');
assert(els.overlayTitle.classList.contains('hidden'), '模式页与标题页同时显示');
assert(els.modepick.children.length === Object.keys(neon.MODES).length,
  '模式选项数与 MODES 不一致（' + els.modepick.children.length + '）');
assert(/id="diffrow"/.test(rawHtml), '模式页缺少难度选择');
console.log('0-2段 OK 第 2 步为模式选择（' + els.modepick.children.length + ' 个模式 + 难度选择）');

// ---- 无尽模式：跳过剧情，直接到职业页
G.mode = 'endless';
els.btnModeNext.click();
assert(!els.overlayCls.classList.contains('hidden'), '无尽模式未直接进入职业选择');
assert(els.overlayStory.classList.contains('hidden'), '无尽模式不应播放剧情');
assert(els.clspick.children.length === Object.keys(neon.CLASSES).length,
  '职业选项数与 CLASSES 不一致（' + els.clspick.children.length + '）');
console.log('0-3段 OK 无尽模式：跳过剧情直接进入职业选择（' + els.clspick.children.length + ' 个职业）');

// ---- 剧情模式：先播序章，播完再进职业页
G.mode = 'campaign';
neon.showModeScreen();
els.btnModeNext.click();
assert(!els.overlayStory.classList.contains('hidden'), '剧情模式未弹出序章');
const pro = neon.STORY.prologue;
assert(pro && pro.chapters.length >= 3, '序章段落不足');
assert(els.storyBody.innerHTML.length > 40, '序章正文为空');
assert(/杀毒协议/.test(els.storyHead.innerHTML), '序章标题不正确');
let steps = 0;
while (!els.overlayStory.classList.contains('hidden') && steps < 30) {
  els.btnStoryNext.click();
  steps++;
}
assert(!els.overlayCls.classList.contains('hidden'), '序章播完未进入职业选择');
assert(steps === pro.chapters.length, '序章段落推进次数不符（' + steps + ' vs ' + pro.chapters.length + '）');
console.log('0-4段 OK 剧情模式：序章 ' + pro.chapters.length + ' 段逐段播放，播完进入职业选择');

// ---- 跳过键：一次点击直接跳过整段剧情
neon.showModeScreen();
G.mode = 'campaign';
els.btnModeNext.click();
assert(!els.overlayStory.classList.contains('hidden'), '再次进入剧情模式未弹序章');
assert(neon.storyState.step === 0, '序章起始段落应为 0');
neon.skipStory();
assert(els.overlayStory.classList.contains('hidden'), '点击跳过后序章未关闭');
assert(!els.overlayCls.classList.contains('hidden'), '跳过后未进入职业选择');
assert(neon.storyState.step === 0, '跳过应重置段落游标');
console.log('0-4b段 OK 跳过键：一次点击跳过整段序章并直接进入职业选择');

// ---- 职业页点「返回」直接回模式页（不重播序章）
els.btnClsBack.click();
assert(!els.overlayMode.classList.contains('hidden'), '职业页返回未回到模式页');
assert(els.overlayStory.classList.contains('hidden'), '职业页返回不应重播序章');
// ---- 从模式页前进（剧情模式会再次播序章），走到职业页并开战
els.btnModeNext.click();
assert(!els.overlayStory.classList.contains('hidden'), '再次前进未播放序章');
let g0 = 0;
while (!els.overlayStory.classList.contains('hidden') && g0++ < 30) els.btnStoryNext.click();
assert(!els.overlayCls.classList.contains('hidden'), '未能回到职业页');
els.btnStart.click();
assert(G.state === 'playing', '点开始战斗后未进入游戏（state=' + G.state + '）');
assert(els.overlayCls.classList.contains('hidden'), '开战后职业页未隐藏');
console.log('0-5段 OK 流程闭环：职业页可返回模式页，开战后进入游戏并隐藏所有面板');

// ============================================================
//  A 段：自由混战（真实受伤 + 死亡重开 + 升级选卡）
// ============================================================
els.btnStart.click();
if (rafCb === null) { console.error('FAIL: 未注册 requestAnimationFrame'); process.exit(1); }
let upgrades = 0, deaths = 0, maxParts = 0, maxEnemies = 0, maxBullets = 0, maxEBullets = 0;
const A = 9000;
for (let i = 0; i < A; i++) {
  tickFrame();
  if (i % 37 === 0) keyDown(['w','a','s','d'][(i / 37) % 4 | 0]);
  if (i % 53 === 0) keyUp('w');
  if (i % 11 === 0) ev('mousemove', { clientX: 200 + (i * 37) % 1000, clientY: 150 + (i * 53) % 700 });
  if (i === 30) ev('mousedown', { button: 0 });   // 之后一直按住开火
  if (i % 600 === 0) keyDown(' ');
  if (i % 1500 === 0) keyDown('p'); // 暂停
  if (i % 1500 === 20) keyDown('p'); // 继续

  const g = G;
  maxParts = Math.max(maxParts, g.parts.length);
  maxEnemies = Math.max(maxEnemies, g.enemies.length);
  maxBullets = Math.max(maxBullets, g.bullets.length);
  maxEBullets = Math.max(maxEBullets, g.ebullets.length);
  if (g.parts.length > 1700) { console.error('FAIL: 粒子无界增长 -> ' + g.parts.length); process.exit(1); }
  if (g.bullets.length > 900) { console.error('FAIL: 玩家子弹泄漏 -> ' + g.bullets.length); process.exit(1); }

  if (g.state === 'upgrade') {
    if (els.cards.children.length !== g.options.length) {
      console.error('FAIL: 卡片数 ' + els.cards.children.length + ' ≠ 选项数 ' + g.options.length); process.exit(1);
    }
    els.cards.children[i % g.options.length].click();
    upgrades++;
    if (g.state !== 'playing') { console.error('FAIL: 选卡后未回到 playing'); process.exit(1); }
  }
  if (!els.overlayOver.classList.contains('hidden')) {
    deaths++;
    if (!/SCORE/.test(els.finStats.innerHTML)) { console.error('FAIL: 结算面板未填充'); process.exit(1); }
    els.btnAgain.click();
  }
}
console.log('A段 OK  ' + A + ' 帧自由混战 · 选卡 ' + upgrades + ' · 死亡 ' + deaths);
console.log('        峰值 敌人' + maxEnemies + ' 子弹' + maxBullets + ' 敌弹' + maxEBullets + ' 粒子' + maxParts);

// ============================================================
//  B 段：不死机器人推进，覆盖 Boss / 相位 / 升级池
// ============================================================
G.state = 'menu'; G.p = null;
els.btnStart.click();
G.p.maxHp = 1e9;
let bossSeen = 0, phase3 = 0, maxWave = 0, bossKills = 0, picksB = 0, prevBoss = null;
const seenPicks = new Set();
const B = 26000;
for (let i = 0; i < B; i++) {
  const g = G;
  if (g.p) g.p.hp = g.p.maxHp;      // 不死
  aimAtNearest();
  if (i === 5) ev('mousedown', { button: 0 });   // 一直按住开火
  if (i % 500 === 0) keyDown(' ');
  tickFrame();

  maxWave = Math.max(maxWave, G.wave);
  const b = G.boss;
  if (b && !b.dead) {
    bossSeen++;
    if (b.phase === 2) phase3++;
  } else if (prevBoss && (!b || b.dead) && G.wave >= 5) {
    bossKills++;
  }
  prevBoss = b && !b.dead ? b : null;

  if (G.state === 'upgrade') {
    if (G.options.length !== 3) { console.error('FAIL: 升级选项数 ' + G.options.length + ' ≠ 3'); process.exit(1); }
    const idx = i % 3;
    seenPicks.add(G.options[idx].id);
    els.cards.children[idx].click();
    picksB++;
  }
  if (G.parts.length > 1700) { console.error('FAIL: B段粒子无界增长'); process.exit(1); }
  if (G.p && G.p.taken.length > 400) break;
}
console.log('B段 OK  ' + B + ' 帧不死推进 · 到达第 ' + maxWave + ' 波 · 选卡 ' + picksB + ' · Boss存活帧 ' + bossSeen + ' · 三相位帧 ' + phase3);
console.log('        已抽到卡种 ' + seenPicks.size + '/' + neon.UPG.length + ' · 玩家已选 ' + (G.p ? G.p.taken.length : 0) + ' 项升级');

// ============================================================
//  B2 段：满配压力测试（多重射击 + 制导 + 高射速 + 卫星 + 爆裂）
//  注意：必须用无尽模式 —— 剧情模式打到第 5 波会触发章节结算并结束本局
// ============================================================
G.mode = 'endless';
neon.startGame();
G.p.proj = 5; G.p.homing = 3; G.p.rate = 0.045; G.p.dmg = 42;
G.p.crit = 0.5; G.p.boom = 5; G.p.orbs = 3; G.p.pierce = 3;
G.p.speed = 900; G.p.regen = 5; G.p.maxHp = 400; G.p.hp = 400;
let sBullets = 0, sParts = 0, sEnemies = 0, sEB = 0, sWaves = 0;
let sOverAt = -1, sOverState = null, sMaxWave = 0;
const S = 5400;
let lastWaveS = 0;
for (let i = 0; i < S; i++) {
  G.p.hp = G.p.maxHp;
  aimAtNearest();
  if (i === 5) ev('mousedown', { button: 0 });
  if (i % 240 === 0) keyDown(' ');
  tickFrame();
  sBullets = Math.max(sBullets, G.bullets.length);
  sParts = Math.max(sParts, G.parts.length);
  sEnemies = Math.max(sEnemies, G.enemies.length);
  sEB = Math.max(sEB, G.ebullets.length);
  if (G.wave !== lastWaveS) { sWaves++; lastWaveS = G.wave; }
  sMaxWave = Math.max(sMaxWave, G.wave);
  // 升级：按实际选项数点，避免索引越界（局外天赋 G1 会让选项变成 4）
  if (G.state === 'upgrade') {
    const n = els.cards.children.length;
    if (n > 0) els.cards.children[i % n].click();
  }
  if (G.state !== 'playing' && sOverAt < 0) { sOverAt = i; sOverState = G.state; }
  if (G.parts.length > 1700) { console.error('FAIL: 压力测试粒子越界 ' + G.parts.length); process.exit(1); }
  if (G.bullets.length > 900) { console.error('FAIL: 压力测试子弹越界 ' + G.bullets.length); process.exit(1); }
}
console.log('B2段 OK 满配 ' + S + ' 帧 · 峰值 敌人' + sEnemies + ' 子弹' + sBullets + ' 敌弹' + sEB + ' 粒子' + sParts +
  ' · 通过 ' + sWaves + ' 波 · 最高波次 ' + sMaxWave +
  (sOverAt >= 0 ? (' · 第 ' + sOverAt + ' 帧离开 playing -> ' + sOverState) : ' · 全程 playing'));
// 段末把状态复位，避免把上一段的结算态泄漏给下一段
if (G.state !== 'playing') { G.state = 'playing'; G.deadT = 0; }

// ============================================================
//  C 段：菜单 / 暂停 / 放弃 / 结算 / 重开 的状态机
// ============================================================
function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg + ' (state=' + G.state + ')'); process.exit(1); }
}
// 按「游戏模拟时间」推进，避免依赖渲染帧率 / handleResize 的首帧提前返回
function advanceSim(seconds) {
  const target = G.time + seconds;
  let n = 0;
  while (G.time < target && n < 6000) { tickFrame(); n++; }
  if (G.time < target - 0.02) { console.error('FAIL: 模拟时间未推进（可能帧循环提前返回）'); process.exit(1); }
  return n;
}
// 暂停开关（P / Esc 由 window 键盘监听处理，浏览器语义）
assert(G.state === 'playing', 'C 段应以 playing 开始');
keyDown('p');
assert(G.state === 'pause', 'P 未暂停');
assert(!els.overlayPause.classList.contains('hidden'), '暂停面板未显示');
tickFrame(); tickFrame();
els.btnResume.click();                       // 面板上的「继续」
assert(G.state === 'playing', '继续未恢复');
assert(els.overlayPause.classList.contains('hidden'), '暂停面板未隐藏');
keyDown('Escape');                           // 大小写同样生效
assert(G.state === 'pause', 'Esc 未暂停');
els.btnQuit.click();                         // 从暂停态放弃本局
assert(G.state === 'menu', '放弃后未回到菜单');
assert(!els.overlayTitle.classList.contains('hidden'), '放弃后未回到标题页');

els.btnStart.click();
const p1 = G.p;
G.p.hp = 0;
neon.damagePlayer(999);
for (let i = 0; i < 140; i++) tickFrame();
assert(G.state === 'over', '致死伤害未进入结算');
assert(/SCORE/.test(els.finStats.innerHTML), '结算面板未填充');
for (let i = 0; i < 5; i++) tickFrame();
els.btnAgain.click();
assert(G.p !== p1, '再来一局未重建玩家');
assert(G.p.hp > 0 && G.p.hp === G.p.maxHp, '新玩家生命未初始化');
console.log('C段 OK  暂停/继续/放弃/结算/重开 状态机正确');

// ============================================================
//  D 段：把这次线上暴露的两个致命 bug 固化成回归测试
// ============================================================
// D1 菜单无玩家时渲染不得抛错（曾导致 rAF 循环当场中断）
G.state = 'menu';
G.p = null;
for (let i = 0; i < 30; i++) {
  try { tickFrame(); } catch (e) {
    console.error('FAIL: 菜单无玩家时渲染抛错 ->', e && e.stack || e); process.exit(1);
  }
}
console.log('D1段 OK 菜单状态下（G.p = null）连续 30 帧渲染无异常');

// D2 按键必须真正改变玩家位置（曾经速度在变、位置不动）
neon.startGame();
tickFrame();                       // 消化 handleResize 的首帧提前返回
releaseAllKeys();                  // 清掉前面阶段遗留的按键状态
const p2 = G.p;
p2.x = 720; p2.y = 480; p2.vx = 0; p2.vy = 0;
keyDown('w');
advanceSim(0.6);
const movedDown = 480 - p2.y;
keyUp('w');
assert(movedDown > 120, '按住 W 0.6s 后位移仅 ' + movedDown.toFixed(1) + 'px（速度未作用到位置）');
// 四个方向都要动
const dirs = [['a', 'x', -1], ['d', 'x', 1], ['s', 'y', 1]];
for (const [k, axis, sign] of dirs) {
  p2.x = 720; p2.y = 480; p2.vx = 0; p2.vy = 0;
  keyDown(k);
  advanceSim(0.6);
  keyUp(k);
  const delta = (axis === 'x' ? p2.x - 720 : p2.y - 480) * sign;
  assert(delta > 120, '按键 ' + k + ' 未产生预期位移（' + delta.toFixed(1) + 'px）');
}
// 冲刺必须真正位移（拖拽会快速衰减，所以看瞬时速度 + 短时位移两个指标）
p2.x = 720; p2.y = 480; p2.vx = 0; p2.vy = 0; p2.dashCd = 0;
const dx0 = p2.x, dy0 = p2.y;
keyDown(' ');                      // 冲刺键
tickFrame();
const dashSpeed = Math.hypot(p2.vx, p2.vy);
assert(dashSpeed > 700, '冲刺未施加冲量（瞬时速度仅 ' + dashSpeed.toFixed(0) + '）');
for (let i = 0; i < 10; i++) tickFrame();   // 约 0.17s
const dashDist = Math.hypot(p2.x - dx0, p2.y - dy0);
assert(dashDist > 50, '冲刺位移仅 ' + dashDist.toFixed(1) + 'px');
console.log('D2段 OK WASD + 冲刺 均真实改变位置（W 0.6s 位移 ' + movedDown.toFixed(0) +
  'px · 冲刺瞬时速度 ' + dashSpeed.toFixed(0) + ' · 0.17s 位移 ' + dashDist.toFixed(0) + 'px）');

// D3 源码级守卫：玩家位置积分必须存在（这是本次事故的直接原因）
const srcText = fs.readFileSync(htmlPath, 'utf8');
if (!/p\.x \+= p\.vx \* dt/.test(srcText) || !/p\.y \+= p\.vy \* dt/.test(srcText)) {
  console.error('FAIL: 玩家位置积分语句缺失（速度永远不会作用到位置）');
  process.exit(1);
}
console.log('D3段 OK 源码中玩家位置积分语句存在');

// ============================================================
//  E 段：相机跟随（地图扩大后的核心行为）
// ============================================================
neon.startGame();
advanceSim(0.3);
const cam = neon.cam;
const p3 = G.p;
// 与游戏内 camClamp 等价的局部实现，用于计算期望值
function camClampLocal(v, vertical) {
  const size = vertical ? neon.H : neon.W;
  const view = vertical ? neon.VH : neon.VW;
  return size <= view ? (size - view) / 2 : Math.min(Math.max(v, 0), size - view);
}
// E1 相机不得越出战场
const probes = [[100, 100], [neon.W - 100, 100], [100, neon.H - 100],
                [neon.W - 100, neon.H - 100], [neon.W / 2, neon.H / 2]];
for (const [px, py] of probes) {
  p3.x = px; p3.y = py; p3.vx = 0; p3.vy = 0;
  for (let i = 0; i < 90; i++) tickFrame();
  const bad = cam.x < -0.5 || cam.y < -0.5 ||
              cam.x > neon.W - neon.VW + 0.5 || cam.y > neon.H - neon.VH + 0.5;
  if (bad) {
    console.error('FAIL: 玩家在 (' + px + ',' + py + ') 时相机越界 cam=(' +
      cam.x.toFixed(1) + ',' + cam.y.toFixed(1) + ')');
    process.exit(1);
  }
}
console.log('E1段 OK 相机始终夹在战场内（战场 ' + neon.W + 'x' + neon.H + ' / 视口 ' + neon.VW + 'x' + neon.VH + '）');

// E2 场地中央时相机应紧跟玩家（每帧钉住位置，排除被敌人推开的干扰）
const px0 = neon.W / 2, py0 = neon.H / 2;
for (let i = 0; i < 220; i++) {
  p3.x = px0; p3.y = py0; p3.vx = 0; p3.vy = 0;
  tickFrame();
}
const wantX = camClampLocal(px0 - neon.VW / 2), wantY = camClampLocal(py0 - neon.VH / 2, true);
assert(Math.abs(cam.x - wantX) < 14 && Math.abs(cam.y - wantY) < 14,
  '中央区域相机未居中于玩家（cam=' + cam.x.toFixed(0) + ',' + cam.y.toFixed(0) +
  ' 期望 ' + wantX.toFixed(0) + ',' + wantY.toFixed(0) + '）');

// E3 靠角落时相机应贴住边界，且玩家仍在视口内可见
for (let i = 0; i < 160; i++) {
  p3.x = 40; p3.y = 40; p3.vx = 0; p3.vy = 0;
  tickFrame();
}
assert(cam.x <= 1 && cam.y <= 1, '左上角时相机未贴边界（cam=' + cam.x.toFixed(1) + ',' + cam.y.toFixed(1) + '）');
const sx = p3.x - cam.x, sy = p3.y - cam.y;
assert(sx >= 0 && sx <= neon.VW && sy >= 0 && sy <= neon.VH,
  '玩家跑出视口之外（视口内位置 ' + sx.toFixed(0) + ',' + sy.toFixed(0) + '）');
console.log('E2/E3段 OK 相机居中跟随正确 · 贴边限制正确 · 玩家始终在视口内');

// ---- E4 相机响应性：高速下每帧相对滞后必须很小，且不能有回弹式滞后
// （旧实现「指数平滑坐标 + 速度前瞻」在幻影速度下每帧滞后约 18px、平均偏离 173px，是晕眩主因）
G.enemies.length = 0;                  // 排除敌人推挤对位置测量的干扰
G.waveState = 'idle';                  // 不让波次结算打断采样
G.spawnQ.length = 0;
p3.x = neon.W / 2; p3.y = neon.H / 2; p3.vx = 0; p3.vy = 0;
advanceSim(0.6);
let prevPx = p3.x, prevPy = p3.y, prevCamX = cam.x, prevCamY = cam.y;
const lags = [];
const offs = [];
for (let i = 0; i < 300; i++) {
  if (i % 60 === 0) { p3.x = neon.W / 2; p3.y = neon.H / 2; cam.x = camClampLocal(p3.x - neon.VW / 2); cam.y = camClampLocal(p3.y - neon.VH / 2, true); prevPx = p3.x; prevPy = p3.y; prevCamX = cam.x; prevCamY = cam.y; }
  p3.vx = p3.speed * 0.98; p3.vy = 0;      // 持续高速右移
  G.state = 'playing';                      // 保持模拟运行
  tickFrame();
  const pStep = Math.hypot(p3.x - prevPx, p3.y - prevPy);
  const cStep = Math.hypot(cam.x - prevCamX, cam.y - prevCamY);
  if (pStep > 6) lags.push(pStep - cStep);
  // 只在远离场地边缘时统计「偏离中心」，避开边界钳制的合法偏移
  const farFromEdge = p3.x > neon.VW * 0.6 && p3.x < neon.W - neon.VW * 0.6 &&
                      p3.y > neon.VH * 0.6 && p3.y < neon.H - neon.VH * 0.6;
  if (farFromEdge && pStep > 6) {
    offs.push(Math.hypot(p3.x - cam.x - neon.VW / 2, p3.y - cam.y - neon.VH / 2));
  }
  prevPx = p3.x; prevPy = p3.y; prevCamX = cam.x; prevCamY = cam.y;
}
lags.sort((a, b) => a - b);
offs.sort((a, b) => a - b);
const medLag = lags[Math.floor(lags.length / 2)];
assert(lags.length > 100, '高速采样帧不足（' + lags.length + '）');
assert(medLag < 6, '相机每帧滞后过大（中位数 ' + medLag.toFixed(2) + 'px，应 < 6px）');
const medOff = offs.length ? offs[Math.floor(offs.length / 2)] : 0;
const maxOff = offs.length ? offs[offs.length - 1] : 0;
assert(offs.length > 30, '场地中央的高速采样不足（' + offs.length + '）');
assert(maxOff < 120, '场地中央高速移动时角色偏离视口中心过多（最大 ' + maxOff.toFixed(0) + 'px）');
console.log('E4段 OK 相机响应性：高速每帧滞后中位数 ' + medLag.toFixed(2) +
  'px · 场地中央偏离中心 中位 ' + medOff.toFixed(0) + 'px / 最大 ' + maxOff.toFixed(0) + 'px');

// ============================================================
//  F 段：升级卡的品质与类别体系
// ============================================================
const UPG = neon.UPG;
const TIERS = new Set([1, 2, 3, 4]);
const CATS = new Set(['atk', 'def', 'eco']);
const byTier = { 1: 0, 2: 0, 3: 0, 4: 0 }, byCat = { atk: 0, def: 0, eco: 0 };
for (const u of UPG) {
  if (!TIERS.has(u.tier)) { console.error('FAIL: 卡 ' + u.id + ' 品质非法 -> ' + u.tier); process.exit(1); }
  if (!CATS.has(u.cat)) { console.error('FAIL: 卡 ' + u.id + ' 类别非法 -> ' + u.cat); process.exit(1); }
  if (typeof u.fn !== 'function') { console.error('FAIL: 卡 ' + u.id + ' 缺少效果函数'); process.exit(1); }
  byTier[u.tier]++; byCat[u.cat]++;
}
for (const c of CATS) {
  if (byCat[c] < 5) { console.error('FAIL: 类别 ' + c + ' 只有 ' + byCat[c] + ' 张卡，分层不够'); process.exit(1); }
}
if (byTier[4] < 3) { console.error('FAIL: 传说卡太少（' + byTier[4] + '）'); process.exit(1); }
console.log('F1段 OK 卡池 ' + UPG.length + ' 张 · 品质分布 普通' + byTier[1] + '/稀有' + byTier[2] +
  '/史诗' + byTier[3] + '/传说' + byTier[4] + ' · 类别 战斗' + byCat.atk + '/防御' + byCat.def + '/发育' + byCat.eco);

// F2 高品质卡必须更晚出现（直接走真实抽卡路径）
neon.startGame();
function tierSample(wave, rounds) {
  const tiers = [];
  for (let r = 0; r < rounds; r++) {
    G.state = 'playing';
    G.wave = wave;
    G.p.taken = [];
    neon.openUpgrade();
    for (const o of G.options) tiers.push(o.tier);
  }
  return tiers;
}
const early = tierSample(1, 40);
const late = tierSample(16, 40);
const maxEarly = Math.max.apply(null, early);
const maxLate = Math.max.apply(null, late);
assert(maxEarly <= 1, '第 1 波就出现了超出普通的卡（最高品质 ' + maxEarly + '）');
assert(maxLate >= 3, '第 16 波仍抽不到史诗以上品质（最高 ' + maxLate + '）');
// 低波次也必须有足够的选择空间
neon.startGame();
G.wave = 1; G.p.taken = [];
neon.openUpgrade();
const earlyPool = neon.drawUpgradeOptions(G.p, 3).length;
assert(earlyPool === 3, '第 1 波抽不满 3 张卡（实际 ' + earlyPool + '）');
console.log('F2段 OK 品质门槛生效：第 1 波最高品质 ' + maxEarly + '（仍能抽满 3 张）· 第 16 波最高品质 ' + maxLate);

// ============================================================
//  G 段：职业系统
// ============================================================
const CLASS_KEYS = Object.keys(neon.CLASSES);
assert(CLASS_KEYS.length >= 3, '职业数量不足（' + CLASS_KEYS.length + '）');
const classStats = {};
for (const k of CLASS_KEYS) {
  G.cls = k;
  neon.startGame();
  tickFrame();
  const p = G.p;
  assert(p && p.cls === k, '职业 ' + k + ' 未正确应用到玩家');
  assert(p.maxHp > 0 && p.hp > 0, '职业 ' + k + ' 生命初始化异常');
  assert(p.speed > 0 && p.dmg > 0 && p.rate > 0 && p.bspeed > 0, '职业 ' + k + ' 基础属性异常');
  // 跑一段确认该职业没有运行时问题（守望者的环形弹幕路径尤其要覆盖）
  keyDown('w');
  const t0 = G.time;
  let n = 0;
  while (G.time - t0 < 0.5 && n < 900) { tickFrame(); n++; }
  keyUp('w');
  classStats[k] = {
    hp: Math.round(p.maxHp), dmg: +p.dmg.toFixed(1), rate: +p.rate.toFixed(3),
    prog: p.proj, speed: Math.round(p.speed), lifesteal: p.lifesteal
  };
  if (p.omni > 0 && G.bullets.length === 0) {
    console.error('FAIL: 守望者职业未产生环形弹幕'); process.exit(1);
  }
}
// 职业之间必须有实质性差异
const dpsOf = s => s.dmg * s.prog / s.rate;
const dpsList = CLASS_KEYS.map(k => dpsOf(classStats[k]));
if (Math.max.apply(null, dpsList) / Math.min.apply(null, dpsList) < 1.3) {
  console.error('FAIL: 各职业理论 DPS 差异过小：' + dpsList.map(v => v.toFixed(0)).join(' / '));
  process.exit(1);
}
console.log('G段 OK ' + CLASS_KEYS.length + ' 个职业可用：');
for (const k of CLASS_KEYS) {
  const s = classStats[k];
  console.log('    ' + neon.CLASSES[k].nm + '(' + k + '): 生命 ' + s.hp + ' · 单发 ' + s.dmg +
    ' · 间隔 ' + s.rate + 's · 弹数 ' + s.prog + ' · 速度 ' + s.speed +
    ' · 理论DPS ' + dpsOf(s).toFixed(0) + (s.lifesteal ? ' · 吸血 ' + s.lifesteal : ''));
}

// ============================================================
//  H 段：剧情模式（序章 5 小关 + 章节结束）
// ============================================================
const camp = neon.MODES.campaign;
assert(camp && camp.waves > 0, '剧情模式未定义有限波次');
assert(camp.nm === '剧情模式', '模式名称应为「剧情模式」，实际「' + camp.nm + '」');
assert(camp.chapter === '序章', '当前章节应为「序章」');
assert(camp.waves === 5, '序章应为 5 小关，实际 ' + camp.waves);
assert(camp.nextLocked === true, '后续章节应标记为未解锁');
assert(camp.waves % camp.bossEvery === 0, '剧情模式的波次数不能被首领间隔整除');
G.mode = 'campaign';
G.cls = 'vanguard';
neon.startGame();
// 快速推进：直接跳到最后一波并清空
G.wave = camp.waves;
G.p.maxHp = 1e9;
G.enemies.length = 0;
G.spawnQ.length = 0;
G.waveState = 'clear';
G.waveDelay = 0.05;
let winFrames = 0;
while (G.state !== 'over' && winFrames < 600) { tickFrame(); winFrames++; }
assert(G.state === 'over', '剧情模式打完最后一波未进入结算（state=' + G.state + '）');
assert(/序章/.test(els.finTitle.innerHTML) && /完成/.test(els.finTitle.innerHTML),
  '结算标题未显示「序章 完成」：' + els.finTitle.innerHTML);
assert(/评级/.test(els.finTitle.innerHTML), '章节结算未给出评级');
assert(/尚未解锁/.test(els.finTitle.innerHTML), '章节结算未提示后续章节未解锁');
const finalScore = G.score;
assert(finalScore >= 2000, '章节完成奖励未计入分数（' + finalScore + '）');
console.log('H1段 OK 剧情模式「序章」' + camp.waves + ' 小关 · 结算显示「序章 完成 + 评级 + 后续未解锁」');

// H2 无尽模式不应有通关判定
G.mode = 'endless';
neon.startGame();
G.wave = camp.waves;
G.p.maxHp = 1e9;
G.enemies.length = 0;
G.spawnQ.length = 0;
G.waveState = 'clear';
G.waveDelay = 0.05;
for (let i = 0; i < 240; i++) tickFrame();
assert(G.state === 'upgrade', '无尽模式在最后一波后未进入强化（state=' + G.state + '）');
console.log('H2段 OK 无尽模式无通关判定，继续进入强化选择');

// ============================================================
//  I 段：首领体系（三型 + 护盾 + 狂暴）
// ============================================================
G.mode = 'endless';
G.cls = 'vanguard';
neon.startGame();
G.wave = 4;

// 确定性伤害探针：一颗必定命中的子弹，步进足够帧数（首帧可能被 handleResize 吞掉）
let boss = null;
function hitBossOnce(dmg) {
  G.bullets.push({
    x: boss.x, y: boss.y, vx: 0, vy: 0, r: 6, dmg: dmg, pierce: 0,
    life: 1, hit: [], col: '#fff', homing: 0, trail: []
  });
  for (let i = 0; i < 4; i++) tickFrame();
}

// ---- 三型首领的属性必须符合设计定位
const BOSS_TYPES = neon.BOSS_TYPES;
const kinds = Object.keys(BOSS_TYPES);
assert(kinds.length === 3, '首领类型数应为 3，实际 ' + kinds.length);
const prop = {};
for (const k of kinds) {
  G.enemies.length = 0; G.boss = null; G.bossEnt = null;
  G.wave = 5;
  const b = neon.spawnBoss(k);
  assert(b && b.bossKind === k, '首领类型 ' + k + ' 未正确生成');
  prop[k] = { hp: b.maxHp, shield: b.maxShield, spd: b.def.spd, r: b.r };
}
assert(prop.basic.shield === 0, '基础型首领不应有护盾');
assert(prop.brute.shield > 0, '血牛型首领必须有护盾');
assert(prop.assassin.shield === 0, '刺客型首领不应有护盾');
assert(prop.brute.spd < prop.basic.spd && prop.basic.spd < prop.assassin.spd,
  '三型速度排序错误（血牛应最慢、刺客应最快）');
assert(prop.assassin.hp < prop.basic.hp, '刺客型血量应低于基础型（低血高机动）');
assert(prop.brute.hp > prop.assassin.hp, '血牛型血量应高于刺客型');
assert(prop.brute.r > prop.assassin.r, '血牛型体积应大于刺客型');
console.log('I1段 OK 三型首领定位正确：' +
  kinds.map(k => BOSS_TYPES[k].nm + '(血' + prop[k].hp + '/盾' + prop[k].shield + '/速' + prop[k].spd + ')').join(' · '));

// ---- 护盾循环（血牛型专属）
G.enemies.length = 0; G.boss = null; G.bossEnt = null;
G.wave = 10;
boss = neon.spawnBoss('brute');
assert(boss.maxShield > 0, '血牛型未生成护盾');
// 把本体血量抬高，保证击穿护盾的那一发不会直接把首领打死（要观察输出窗口）
boss.hp = 1e7; boss.maxHp = 1e7;
boss.shield = 10;
const hpBeforeShield = boss.hp;
hitBossOnce(5000);
assert(boss.shield <= 0, '护盾未被击穿（剩 ' + boss.shield.toFixed(1) + '）');
// 破盾后先有 shieldT 缓冲，再进入输出窗口
let gStag = 0;
while (!(boss.stagger > 0) && gStag++ < 600) { G.p.hp = G.p.maxHp; tickFrame(); }
assert(boss.stagger > 0, '护盾击破后未进入输出窗口');
console.log('I2段 OK 血牛护盾被击穿并进入输出窗口（护盾 ' + Math.round(boss.maxShield) +
  ' -> 0，窗口 ' + boss.stagger.toFixed(1) + 's，本体扣血 ' +
  (hpBeforeShield - boss.hp).toFixed(0) + '，说明护盾确实先吸收了伤害）');

// ---- 输出窗口伤害放大：直接测 damageEnemy 的倍率计算。
// 不用 tickFrame 走完整时序（会被 updateBoss 递减 stagger / 重铸护盾干扰，导致偶发测量偏差）。
// stagger 取 1（>0 即生效），这样即使被 updateBoss 递减也仍然为正。
var realDef = boss.def;
boss.def = { hasShield: false, moveKind: 'orbit', standoff: 300, fireRate: 0.17, shootCd: [99, 99, 99] };
boss.hp = 1e7; boss.maxHp = 1e7;
boss.shield = 0;
boss.invuln = false;
boss.stagger = 0;
var h0 = boss.hp;
neon.damageEnemyRef(boss, 100, false, G.p);
var dmgNormal = h0 - boss.hp;

boss.shield = 0;
boss.invuln = false;
boss.stagger = 1;              // 输出窗口开启
var h1 = boss.hp;
neon.damageEnemyRef(boss, 100, false, G.p);
var dmgStagger = h1 - boss.hp;
boss.def = realDef;
assert(dmgNormal > 0, '常态测量未命中（dmg=' + dmgNormal + '）');
assert(dmgStagger > dmgNormal * 1.4,
  '输出窗口未提供伤害加成（常态 ' + dmgNormal.toFixed(1) + ' vs 窗口 ' + dmgStagger.toFixed(1) + '）');
console.log('I3段 OK 输出窗口伤害放大生效（100 基础伤害：常态 ' + dmgNormal.toFixed(0) +
  ' -> 窗口内 ' + dmgStagger.toFixed(0) + '）');

// ---- 输出窗口耗尽后护盾重铸
boss.hp = boss.maxHp;
boss.shield = 0;
boss.stagger = 0.05;
let guard3 = 0;
while (boss.shield <= 0 && guard3++ < 900) { G.p.hp = G.p.maxHp; tickFrame(); }
assert(boss.shield > 0, '输出窗口结束后护盾没有重铸（循环节奏缺失）');
console.log('I4段 OK 护盾重铸生效（重铸到 ' + Math.round(boss.shield) + ' / ' + boss.maxShield + '）');

// ---- 狂暴：血量降到阈值以下必须触发，且弹幕更密
for (const k of kinds) {
  G.enemies.length = 0; G.boss = null; G.bossEnt = null;
  G.wave = 10;
  const b = neon.spawnBoss(k);
  b.spawnT = 0;
  assert(!b.enraged, k + ' 开局就处于狂暴');
  b.hp = b.maxHp * (b.def.enrageFrac - 0.01);
  G.p.hp = G.p.maxHp;
  let g4 = 0;
  while (!b.enraged && g4++ < 240) { G.p.hp = G.p.maxHp; tickFrame(); }
  assert(b.enraged, BOSS_TYPES[k].nm + ' 血量低于 ' + (b.def.enrageFrac * 100) + '% 未进入狂暴');
  // 狂暴后主弹幕冷却必须缩短
  const cdNormal = b.def.shootCd[1];
  const cdRage = cdNormal * b.def.enrageMul;
  assert(cdRage < cdNormal, BOSS_TYPES[k].nm + ' 狂暴后冷却没有缩短');
}
console.log('I5段 OK 三型首领在血量低于阈值时均进入狂暴，且主弹幕冷却缩短');

// ---- 基础型已移除护盾（首个首领不能有护盾，降低上手难度）
assert(BOSS_TYPES.basic.hasShield === false, '基础型仍带护盾（首个首领应简化）');
G.enemies.length = 0; G.boss = null; G.bossEnt = null;
G.wave = 5;
const first = neon.spawnBoss('basic');
assert(first.maxShield === 0 && first.def.hasShield === false, '第 5 波首个首领不应有护盾');
console.log('I6段 OK 首个首领（基础型）无护盾，机制已简化');

// ---- 出怪表：首个首领为基础型，之后按波次轮换
const kindAtWave = w => { const n = Math.floor(w / 5); return n <= 1 ? 'basic' : (n === 2 ? 'brute' : (n === 3 ? 'assassin' : null)); };
G.enemies.length = 0; G.boss = null; G.bossEnt = null;
G.wave = 5; assert(neon.spawnBoss().bossKind === 'basic', '第 5 波首领应为基础型');
G.enemies.length = 0; G.boss = null; G.bossEnt = null;
G.wave = 10; assert(neon.spawnBoss().bossKind === 'brute', '第 10 波首领应为血牛型');
G.enemies.length = 0; G.boss = null; G.bossEnt = null;
G.wave = 15; assert(neon.spawnBoss().bossKind === 'assassin', '第 15 波首领应为刺客型');
console.log('I7段 OK 出怪表：第 5 波基础型 / 第 10 波血牛型 / 第 15 波刺客型');

// ============================================================
//  J 段：局外天赋树「底层算力模块」
// ============================================================
const META = neon.META;
const TALENTS = neon.TALENTS;
// 注：规格文档标题写「共 28 节点」，但正文节点表与代码块实际为 4+9+9+4 = 26 个。
// 以节点表/代码块为准实现，此处断言 26。
assert(TALENTS.length === 26, '天赋节点应为 26 个（4+9+9+4），实际 ' + TALENTS.length);
const tIds = {};
for (const t of TALENTS) {
  if (tIds[t.id]) { console.error('FAIL: 天赋 ID 重复 ' + t.id); process.exit(1); }
  tIds[t.id] = true;
  if (![1, 2, 3, 4].includes(t.layer)) { console.error('FAIL: ' + t.id + ' 层级非法'); process.exit(1); }
  if (!['unlock', 'rule', 'param'].includes(t.type)) { console.error('FAIL: ' + t.id + ' 类型非法'); process.exit(1); }
  if (typeof t.cost !== 'number' || t.cost <= 0) { console.error('FAIL: ' + t.id + ' 消耗非法'); process.exit(1); }
}
// 前置必须存在；A0 是根
assert(tIds.A0, '缺少根节点 A0');
for (const t of TALENTS) {
  for (const r of t.req) {
    if (!tIds[r]) { console.error('FAIL: ' + t.id + ' 的前置 ' + r + ' 不存在'); process.exit(1); }
    if (t.reqMode !== 'any2' && r === t.id) { console.error('FAIL: ' + t.id + ' 自引用'); process.exit(1); }
  }
}
const byLayer = { 1: 0, 2: 0, 3: 0, 4: 0 };
for (const t of TALENTS) byLayer[t.layer]++;
assert(byLayer[1] === 4 && byLayer[2] === 9 && byLayer[3] === 9 && byLayer[4] === 4,
  '分层数量不符（应为 4/9/9/4，实际 ' + JSON.stringify(byLayer) + '）');
console.log('J1段 OK 天赋树 ' + TALENTS.length + ' 节点 · 分层 4/9/9/4 · 前置引用完整');

// J2 点数只能由无尽模式产出；每 3 波 +1
META.points = 0; META.totalEarned = 0; META.unlocked = {}; META.endlessWavesCleared = 0;
for (const w of [1, 2, 3]) neon.metaOnWaveClear(w, 'campaign');
assert(META.points === 0, '剧情模式不应产出点数（实际 ' + META.points + '）');
for (const w of [1, 2]) neon.metaOnWaveClear(w, 'endless');
assert(META.points === 0, '无尽前 2 波不应产点（实际 ' + META.points + '）');
neon.metaOnWaveClear(3, 'endless');
assert(META.points === 1, '无尽第 3 波应 +1 点（实际 ' + META.points + '）');
for (const w of [4, 5, 6]) neon.metaOnWaveClear(w, 'endless');
assert(META.points === 2, '无尽第 6 波应累计到 2 点（实际 ' + META.points + '）');
assert(META.endlessWavesCleared === 6, '无尽最高波次未更新（' + META.endlessWavesCleared + '）');
console.log('J2段 OK 点数规则：剧情模式不产点 · 无尽每 3 波 +1（当前 ' + META.points + ' 点，最高波次 ' + META.endlessWavesCleared + '）');

// J3 解锁前置与点数校验
assert(neon.talentHas('A0') === false, 'A0 初始不应已解锁');
assert(neon.talentCanUnlock('R1') === false, 'R1 在 A0 未解锁时不应可解锁');
assert(neon.talentCanUnlock('A0') === true, 'A0 在有 2 点时应可解锁');
neon.talentUnlock('A0');
assert(neon.talentHas('A0'), 'A0 解锁失败');
assert(META.points === 1, 'A0 消耗 1 点后剩 1 点（实际 ' + META.points + '）');
assert(neon.talentCanUnlock('R1') === false, 'R1 需要 2 点，当前 1 点不应可解锁');
META.points = 20;
assert(neon.talentCanUnlock('R1') === true, 'R1 在满足点数+前置后应可解锁');
neon.talentUnlock('R1');
assert(neon.talentHas('R1'), 'R1 解锁失败');
// any2 规则：T1 需要 RB2/BG2/RG2 中任意 2 个
META.points = 200;   // 前置链需要足够点数才能逐个解锁
assert(neon.talentCanUnlock('T1') === false, 'T1 在前置不足时不应可解锁');
const chain = ['B1', 'RB1', 'RB2', 'G1', 'BG1', 'BG2'];
for (const id of chain) {
  assert(neon.talentUnlock(id) === true, '前置节点 ' + id + ' 解锁失败');
}
assert(neon.talentCanUnlock('T1') === true, 'T1 满足 any2 前置后应可解锁');
console.log('J3段 OK 解锁判定：前置链 + 点数门槛 + any2 规则均正确');

// J4 参数型加成生效
META.unlocked = {}; META.points = 99;
neon.talentUnlock('A0'); neon.talentUnlock('A2'); neon.talentUnlock('B1');
neon.talentUnlock('R1'); neon.talentUnlock('R2'); neon.talentUnlock('B2'); neon.talentUnlock('G1'); neon.talentUnlock('G2');
neon.startGame();
const pm = G.p;
// 基线：同职业无天赋
const baseline = { maxHp: 100 * 1.0, rate: 0.155, pierce: 0, dashInv: 0.34, magnet: 0 };
assert(Math.abs(pm.maxHp - (baseline.maxHp + 5 + 15)) < 0.01,
  'A2+B1 生命加成未生效（' + pm.maxHp + '）');
assert(Math.abs(pm.rate - baseline.rate * 0.92) < 0.0005, 'R1 射速加成未生效（' + pm.rate + '）');
assert(pm.pierce === baseline.pierce + 1, 'R2 穿透加成未生效（' + pm.pierce + '）');
assert(Math.abs(pm.dashInv - (baseline.dashInv + 0.06)) < 0.0005, 'B2 无敌帧加成未生效（' + pm.dashInv + '）');
assert(Math.abs(pm.magnet - (baseline.magnet + 0.20)) < 0.0001, 'G2 拾取范围加成未生效（' + pm.magnet + '）');
assert(pm.hp === pm.maxHp, '加成后应满血（' + pm.hp + '/' + pm.maxHp + '）');
// G1 规则：升级选项 4 张
G.wave = 4; G.p.taken = [];
neon.openUpgrade();
assert(G.options.length === 4, 'G1 未把升级选项提升到 4 张（' + G.options.length + '）');
console.log('J4段 OK 参数型加成全部生效（生命+20 / 射速×0.92 / 穿透+1 / 无敌+0.06 / 拾取+0.2）· G1 选项数 4');

// J5 A1 保底稀有以上
META.points = 99; neon.talentUnlock('A1');
let guaranteed = true;
for (let round = 0; round < 30; round++) {
  G.p.taken = []; G.wave = 4;
  const opts = neon.drawUpgradeOptions(G.p, 3);
  if (!opts.some(o => o.tier >= 2)) { guaranteed = false; break; }
}
assert(guaranteed, 'A1 未保证每次都出现稀有以上品质');
console.log('J5段 OK A1 保底生效：30 轮抽卡每轮都有稀有以上品质');

// J6 存档持久化与洗点
neon.metaSave();
const raw = sandbox.localStorage.getItem('entropyTideMeta');
assert(raw && raw.indexOf('unlocked') >= 0, '天赋存档未写入 localStorage');
const parsed = JSON.parse(raw);
assert(parsed.unlocked.A0 === true, '存档未记录已解锁节点');
META.points = 10; META.totalEarned = 50;
const beforeReset = META.points;
const refundable = Object.keys(META.unlocked).reduce(function (s, id) {
  const t = TALENTS.find(function (x) { return x.id === id; });
  return s + (t ? t.cost : 0);
}, 0);
assert(neon.metaReset() === true, '洗点应成功');
assert(META.points === beforeReset + refundable - 3, '洗点退还未正确（' + META.points + '）');
assert(Object.keys(META.unlocked).length === 0, '洗点后仍存在已解锁节点');
console.log('J6段 OK 存档持久化 + 洗点：退还 ' + refundable + ' 点、扣除 3 点费用、解锁清空');

// ============================================================
//  K 段：波次词缀「熵潮变异」
// ============================================================
const spawnEnemyRef = neon.spawnEnemy;
const AFFIXES = neon.AFFIXES;
assert(AFFIXES.length === 12, '词缀应为 12 个，实际 ' + AFFIXES.length);
const affTones = new Set(['red', 'purple', 'green']);
for (const a of AFFIXES) {
  if (!a.nm || !a.ds || !a.lore) { console.error('FAIL: 词缀 ' + a.id + ' 缺字段'); process.exit(1); }
  if (!affTones.has(a.tone)) { console.error('FAIL: 词缀 ' + a.id + ' 色调非法'); process.exit(1); }
}
// 冲突表必须成对且词缀存在
for (const pair of neon.AFFIX_CONFLICTS) {
  for (const id of pair) {
    if (!AFFIXES.some(a => a.id === id)) { console.error('FAIL: 冲突表引用了不存在的词缀 ' + id); process.exit(1); }
  }
}
console.log('K1段 OK 词缀 ' + AFFIXES.length + ' 个 · 冲突对 ' + neon.AFFIX_CONFLICTS.length + ' 组 · 字段完整');

// K2 抽取规则：第 3 波之前无词缀；首领波无词缀；第 4 波起必有 1 个
G.mode = 'endless';
neon.rollWaveAffixes(2);
assert(G.affixes.list.length === 0, '第 2 波不应有词缀');
neon.rollWaveAffixes(3);
assert(G.affixes.list.length === 0, '第 3 波不应有词缀');
neon.rollWaveAffixes(5);   // 无尽模式第 5 波是首领波
assert(G.affixes.list.length === 0, '首领波不应有词缀（实际 ' + G.affixes.list.length + '）');
let oneEachWave = true, sawTwo = false;
for (let w = 4; w <= 40; w++) {
  if (w % 5 === 0) continue;
  neon.rollWaveAffixes(w);
  const n = G.affixes.list.length;
  if (n < 1) { oneEachWave = false; console.error('FAIL: 第 ' + w + ' 波没有词缀'); break; }
  if (n > 2) { oneEachWave = false; console.error('FAIL: 第 ' + w + ' 波词缀超过 2 个'); break; }
  if (n === 2) { sawTwo = true; if (w < 8) { oneEachWave = false; console.error('FAIL: 第 ' + w + ' 波出现了副词缀（应第 8 波起）'); break; } }
}
assert(oneEachWave, '词缀数量规则不满足');
assert(sawTwo, '第 8 波起应有概率出现 2 个词缀，但从未观测到');
console.log('K2段 OK 抽取规则：第 4 波起生效 · 首领波无词缀 · 第 8 波起可出现副词缀');

// K3 冲突词缀不得同时出现
let conflictOk = true;
for (let i = 0; i < 400; i++) {
  neon.rollWaveAffixes(20);
  for (const pair of neon.AFFIX_CONFLICTS) {
    if (neon.hasAffix(pair[0]) && neon.hasAffix(pair[1])) {
      conflictOk = false;
      console.error('FAIL: 冲突词缀同时出现 ' + pair.join(' + '));
      break;
    }
  }
  if (!conflictOk) break;
}
assert(conflictOk, '冲突词缀规则被破坏');
console.log('K3段 OK 冲突词缀 400 轮抽取均未同时出现');

// K4 词缀效果：敌人属性修正 / 狂乱过滤远程 / 护盾化 / 衰减不掉落
G.mode = 'endless'; G.wave = 10;
neon.affixClear();
neon.startGame();
// 熵增：移速 +30%、血量 -20%
G.wave = 10;
G.affixes = { list: ['entropy_up'], primary: 'entropy_up', secondary: null };
G.enemies.length = 0;
let te = neon.spawnEnemy ? null : null;
const eUp = spawnEnemyRef('chaser', 500, 500);
assert(eUp, '词缀下敌人生成失败');
const baseCh = neon.ETYPES.chaser;
assert(Math.abs(eUp.spd - baseCh.spd * (1 + (10 - 1) * 0.012) * 1.30) < 0.01, '熵增：移速 +30% 未生效');
assert(Math.abs(eUp.maxHp - baseCh.hp * (1 + (10 - 1) * 0.17) * 0.80) < 0.01, '熵增：血量 -20% 未生效');
// 凝滞
G.affixes = { list: ['entropy_down'], primary: 'entropy_down', secondary: null };
G.enemies.length = 0;
const eDown = spawnEnemyRef('chaser', 500, 500);
assert(Math.abs(eDown.spd - baseCh.spd * (1 + 9 * 0.012) * 0.65) < 0.01, '凝滞：移速 -35% 未生效');
// 狂乱：远程被过滤
G.affixes = { list: ['frenzy'], primary: 'frenzy', secondary: null };
G.enemies.length = 0;
const eRanged = spawnEnemyRef('shooter', 500, 500);
assert(eRanged === null, '狂乱：远程单位应被过滤（实际仍生成）');
const eMelee = spawnEnemyRef('chaser', 500, 500);
assert(eMelee && Math.abs(eMelee.dmg - baseCh.dmg * (1 + 9 * 0.05) * 1.20) < 0.01, '狂乱：近战伤害 +20% 未生效');
// 护盾化
G.affixes = { list: ['shielded'], primary: 'shielded', secondary: null };
G.enemies.length = 0;
const eSh = spawnEnemyRef('chaser', 500, 500);
assert(eSh && eSh.maxShield > 0 && Math.abs(eSh.maxShield - Math.round(eSh.maxHp * 0.20)) <= 1,
  '护盾化：敌人护盾未按最大生命 20% 生成');
// 衰减：不掉落
G.affixes = { list: ['decay'], primary: 'decay', secondary: null };
G.enemies.length = 0;
const eDec = spawnEnemyRef('chaser', 500, 500);
assert(eDec && eDec.noDrop === true, '衰减：未标记不掉落拾取物');
console.log('K4段 OK 词缀效果：熵增/凝滞/狂乱(过滤远程)/护盾化/衰减 全部生效');

// K5 收缩：战场边界向内收 15%
neon.affixClear();
const fbFull = neon.getFieldBounds();
assert(fbFull.x0 === 0 && fbFull.x1 === neon.W, '无收缩时边界应等于战场尺寸');
G.affixes = { list: ['shrink'], primary: 'shrink', secondary: null };
const fbShrunk = neon.getFieldBounds();
const expectInset = Math.min(neon.W, neon.H) * 0.15;
assert(Math.abs(fbShrunk.x0 - expectInset) < 0.01 && Math.abs(fbShrunk.x1 - (neon.W - expectInset)) < 0.01,
  '收缩：边界未按 15% 内收（' + fbShrunk.x0 + ' ~ ' + fbShrunk.x1 + '）');
console.log('K5段 OK 收缩：边界内收 ' + Math.round(expectInset) + 'px（15%）');

// K6 开局词缀会写入 G.affixes 并进入 HUD 数据源
neon.affixClear();
G.mode = 'endless';
G.wave = 7;
neon.startWave(8);
assert(G.affixes.list.length >= 1, 'startWave 未抽取词缀（list=' + G.affixes.list.length + '）');
assert(G.affixState && Array.isArray(G.affixState.erosionZones), '词缀运行时状态未初始化');
const affList = G.affixes.list.slice();
neon.affixClear();
assert(G.affixes.list.length === 0, 'affixClear 未清空词缀');
console.log('K6段 OK startWave 抽取词缀（本波 ' + affList.join('+') + '）· 运行时状态就绪 · affixClear 可用');

// ============================================================
//  L 段：精英怪系统（v1.6）
// ============================================================
const ELITE_AFFIXES = neon.ELITE_AFFIXES;
const ELITE_CONFIG = neon.ELITE_CONFIG;
assert(ELITE_AFFIXES.length === 8, '精英词缀应为 8 个，实际 ' + ELITE_AFFIXES.length);
const eTones = new Set(['red', 'green', 'purple', 'cyan']);
for (const a of ELITE_AFFIXES) {
  if (!a.nm || !a.ds || !a.ico) { console.error('FAIL: 精英词缀 ' + a.id + ' 缺字段'); process.exit(1); }
  if (!eTones.has(a.tone)) { console.error('FAIL: 精英词缀 ' + a.id + ' 色调非法'); process.exit(1); }
  if (['behavior', 'defense'].indexOf(a.cat) < 0) { console.error('FAIL: 精英词缀 ' + a.id + ' 分类非法'); process.exit(1); }
}
for (const pair of neon.ELITE_CONFLICTS) {
  for (const id of pair) {
    if (!ELITE_AFFIXES.some(a => a.id === id)) { console.error('FAIL: 精英冲突表引用不存在的词缀 ' + id); process.exit(1); }
  }
}
// 倾向表里的词缀必须都存在
for (const type of Object.keys(neon.ELITE_TENDENCY)) {
  for (const id of neon.ELITE_TENDENCY[type]) {
    if (!ELITE_AFFIXES.some(a => a.id === id)) {
      console.error('FAIL: 倾向表 ' + type + ' 引用了不存在的词缀 ' + id); process.exit(1);
    }
  }
}
console.log('L1段 OK 精英 ' + ELITE_AFFIXES.length + ' 个词缀 · 冲突对 ' + neon.ELITE_CONFLICTS.length +
  ' 组 · 倾向表覆盖 ' + Object.keys(neon.ELITE_TENDENCY).length + ' 种敌人');

// L2 出现概率曲线与波次门槛
assert(ELITE_CONFIG.chance(2) === 0, '第 2 波不应刷精英');
assert(ELITE_CONFIG.chance(3) === 0.20, '第 3-5 波概率应为 20%');
assert(ELITE_CONFIG.chance(5) === 0.20, '第 5 波概率应为 20%');
assert(ELITE_CONFIG.chance(6) === 0.35, '第 6-10 波概率应为 35%');
assert(ELITE_CONFIG.chance(11) === 0.50, '第 11 波起概率应为 50%');
assert(ELITE_CONFIG.maxPerWave === 2, '每波精英上限应为 2');
assert(ELITE_CONFIG.maxBonusPicks === 3, '额外强化机会上限应为 3');
console.log('L2段 OK 概率曲线：第2波0% / 第3-5波20% / 第6-10波35% / 第11波起50% · 每波上限 2');

// L3 精英基础强化（体型 1.5 / 血量 3 / 伤害 1.5 / 分数 5）
G.mode = 'endless';
G.cls = 'vanguard';
neon.startGame();
G.wave = 8;
G.enemies.length = 0;
var baseEnemy = neon.spawnEnemy('chaser', 600, 600);
var baseStats = { r: baseEnemy.r, hp: baseEnemy.maxHp, dmg: baseEnemy.dmg, score: baseEnemy.score };
G.enemies.length = 0;
var eliteEnemy = neon.spawnEnemy('chaser', 600, 600);
neon.makeElite(eliteEnemy, 'swift');
assert(eliteEnemy.elite === true, 'makeElite 未标记精英');
assert(Math.abs(eliteEnemy.r / baseStats.r - 1.5) < 0.01, '体型应为 1.5 倍（实际 ' + (eliteEnemy.r / baseStats.r).toFixed(2) + '）');
assert(Math.abs(eliteEnemy.maxHp / baseStats.hp - 3.0) < 0.01, '血量应为 3 倍');
assert(Math.abs(eliteEnemy.dmg / baseStats.dmg - 1.5) < 0.01, '伤害应为 1.5 倍');
assert(Math.abs(eliteEnemy.score / baseStats.score - 5.0) < 0.01, '分数应为 5 倍');
console.log('L3段 OK 精英基础强化：体型×1.5 · 血量×3 · 伤害×1.5 · 分数×5');

// L4 每个词缀的实际效果
function freshElite(affixId, type) {
  G.enemies.length = 0;
  var e = neon.spawnEnemy(type || 'chaser', 700, 700);
  neon.makeElite(e, affixId);
  return e;
}
// 迅捷
var eSwift = freshElite('swift');
G.enemies.length = 0;
var plain = neon.spawnEnemy('chaser', 700, 700);
var plainSpd = plain.spd;
assert(Math.abs(eSwift.spd / (plainSpd * 1.5 * 3.0 / 3.0) - 1.6) < 0.02 || eSwift.spd > plainSpd * 1.4,
  '迅捷：移速应 +60%（实际 ' + (eSwift.spd / plainSpd).toFixed(2) + '）');
assert(eSwift.eliteDartMul === 2.0, '迅捷：突进频率应翻倍');
assert(eSwift.eliteFireMul === 0.75, '迅捷：攻击间隔应 -25%');
// 分裂
var eSplit = freshElite('split');
assert(eSplit.eliteSplit === true, '分裂：未标记 eliteSplit');
// 吸血
var eLeech = freshElite('leech');
assert(eLeech.eliteLeech === true && eLeech.eliteLeechT === 2.0, '吸血：未初始化');
// 荆棘
var eThorns = freshElite('thorns');
assert(eThorns.eliteThorns === 0.60, '荆棘：反弹比例应为 0.60');
// 护盾
var eShield = freshElite('shield');
assert(eShield.maxShield > 0 && Math.abs(eShield.shield / eShield.maxHp - 0.50) < 0.01,
  '护盾：护盾值应为最大生命 50%');
assert(eShield.eliteShieldRegen === 4.0, '护盾：脱战 4 秒回满');
// 相位
var ePhase = freshElite('phase');
assert(ePhase.elitePhase === true && ePhase.elitePhaseDur === 1.0 && ePhase.elitePhaseInt === 3.0,
  '相位：1 秒相位 / 3 秒间隔 未正确设置');
// 硬化
var eHarden = freshElite('harden');
assert(Math.abs(eHarden.spd / plainSpd - 0.70) < 0.02, '硬化：移速应 -30%');
// 再生
var eRegen = freshElite('regen');
assert(Math.abs(eRegen.eliteRegen - 0.025) < 0.0001, '再生：每秒应回 2.5%');
console.log('L4段 OK 8 个精英词缀效果全部落地（迅捷/分裂/吸血/荆棘/护盾/相位/硬化/再生）');

// L5 相位免疫 + 漂移
var ePh = freshElite('phase');
ePh.invuln = true;
var hpBeforePhase = ePh.hp;
G.bullets.length = 0;
G.bullets.push({ x: ePh.x, y: ePh.y, vx: 0, vy: 0, r: 6, dmg: 99999, pierce: 0, life: 1, hit: [], col: '#fff', homing: 0, trail: [] });
var phX0 = ePh.x, phY0 = ePh.y;
for (let i = 0; i < 6; i++) tickFrame();
assert(Math.abs(ePh.hp - hpBeforePhase) < 0.01, '相位：免疫期间不应掉血（' + hpBeforePhase.toFixed(0) + ' -> ' + ePh.hp.toFixed(0) + '）');
assert(!ePh.dead, '相位：免疫期间不应死亡');
const drifted = Math.hypot(ePh.x - phX0, ePh.y - phY0);
assert(drifted > 1.5, '相位：应有缓慢漂移（实际位移 ' + drifted.toFixed(1) + 'px）');
console.log('L5段 OK 相位：免疫致命伤害 · 同时保持缓慢漂移（' + drifted.toFixed(1) + 'px）');

// L6 吸血 / 再生 实际回血
var eHeal = freshElite('leech');
eHeal.hp = eHeal.maxHp * 0.4;
var hpLow = eHeal.hp;
G.p.hp = G.p.maxHp;
for (let i = 0; i < 200; i++) tickFrame();      // 约 3.3 秒，应触发至少一次吸血
assert(eHeal.hp > hpLow + 1, '吸血：3.3 秒内应有可见回血（' + hpLow.toFixed(0) + ' -> ' + eHeal.hp.toFixed(0) + '）');
var eRg = freshElite('regen');
eRg.hp = eRg.maxHp * 0.4;
eRg.eliteRegenPause = 0;
var hpLow2 = eRg.hp;
for (let i = 0; i < 60; i++) tickFrame();       // 1 秒应回 2.5%
const healed = eRg.hp - hpLow2;
assert(healed > eRg.maxHp * 0.015, '再生：1 秒应回约 2.5%（实际 ' + (healed / eRg.maxHp * 100).toFixed(1) + '%）');
console.log('L6段 OK 吸血与再生回血生效（吸血 +' + (eHeal.hp - hpLow).toFixed(0) +
  ' · 再生 +' + (healed / eRg.maxHp * 100).toFixed(1) + '%/s）');

// L7 同波词缀不重复且不冲突
G.wave = 21;                                   // 非首领波（21 % 5 != 0），50% 概率便于观测双精英
let dupFound = false, conflictFound = false, pairsSeen = 0;
for (let round = 0; round < 600; round++) {
  neon.eliteResetWave();
  neon.eliteRollWave();
  G.enemies.length = 0;
  const picked = [];
  // 只有本波掷出名额时才会有精英；反复尝试直到名额用尽
  for (let t = 0; t < 200 && picked.length < 2; t++) {
    const e = neon.trySpawnElite('chaser', 500, 500);
    if (e) picked.push(e.eliteAffix);
  }
  if (picked.length === 2) {
    pairsSeen++;
    if (picked[0] === picked[1]) dupFound = true;
    for (const pair of neon.ELITE_CONFLICTS) {
      if (picked.indexOf(pair[0]) >= 0 && picked.indexOf(pair[1]) >= 0) conflictFound = true;
    }
  }
  if (dupFound || conflictFound) break;
}
assert(!dupFound, '同波两只精英出现了相同词缀');
assert(!conflictFound, '同波两只精英出现了冲突词缀');
// 双精英波的理论出现率 = p² = 25%，600 轮期望约 150 个；留足余量避免偶发误判
assert(pairsSeen >= 80, '应观测到足够多的双精英波（实际 ' + pairsSeen + '）');
console.log('L7段 OK 同波精英词缀不重复、不冲突（观测 ' + pairsSeen + ' 个双精英波）');

// L8 每波名额（0/1/2）+ 首领波不刷
// 每波只掷一次骰子，所以要跨多轮重置来消除"这一轮恰好没掷中"的随机性
G.mode = 'endless';
G.wave = 21;                                   // 21 % 5 != 0，非首领波
let maxInOneWave = 0, wavesWithElite = 0, rounds = 300;
for (let r = 0; r < rounds; r++) {
  neon.eliteResetWave();
  let n = 0;
  for (let t = 0; t < 40; t++) {
    if (neon.trySpawnElite('chaser', 500, 500)) n++;
  }
  if (n > 0) wavesWithElite++;
  maxInOneWave = Math.max(maxInOneWave, n);
}
assert(maxInOneWave <= 2, '每波精英数量应 ≤ 2（实际 ' + maxInOneWave + '）');
assert(maxInOneWave >= 1, '多轮重置后应观测到至少一只精英');
// 首领波：无论重置多少次都不应刷出
G.wave = 20;                                   // 无尽模式第 20 波是首领波
let bossWaveElite = 0;
for (let r = 0; r < 40; r++) {
  neon.eliteResetWave();
  for (let t = 0; t < 40; t++) if (neon.trySpawnElite('chaser', 500, 500)) bossWaveElite++;
}
assert(bossWaveElite === 0, '首领波不应刷精英（实际 ' + bossWaveElite + '）');
console.log('L8段 OK 每波上限 2 只（' + rounds + ' 轮中 ' + wavesWithElite +
  ' 轮出现精英，单波最多 ' + maxInOneWave + '）· 首领波 40 轮均不刷');

// L8b 出现率必须匹配规格的波次分层（每波只掷一次骰子）
// 若按"每次生成尝试都掷骰"，实际出现率会被放大到接近 100%，分层失效。
function measureEliteRate(wave, trials) {
  G.mode = 'endless';
  G.wave = wave;
  let hit = 0, totalElites = 0;
  for (let i = 0; i < trials; i++) {
    neon.eliteResetWave();
    neon.eliteRollWave();
    G.enemies.length = 0;
    let n = 0;
    for (let t = 0; t < 40; t++) if (neon.trySpawnElite('chaser', 500, 500)) n++;
    if (n > 0) hit++;
    totalElites += n;
  }
  return { wave: wave, rate: hit / trials, avg: totalElites / trials };
}
const rateLow = measureEliteRate(4, 4000);     // 目标 20%
const rateMid = measureEliteRate(8, 4000);     // 目标 35%
const rateHigh = measureEliteRate(12, 4000);   // 目标 50%
assert(Math.abs(rateLow.rate - 0.20) < 0.035,
  '第 3-5 波出现率应约 20%（实际 ' + (rateLow.rate * 100).toFixed(1) + '%）');
assert(Math.abs(rateMid.rate - 0.35) < 0.04,
  '第 6-10 波出现率应约 35%（实际 ' + (rateMid.rate * 100).toFixed(1) + '%）');
assert(Math.abs(rateHigh.rate - 0.50) < 0.04,
  '第 11 波起出现率应约 50%（实际 ' + (rateHigh.rate * 100).toFixed(1) + '%）');
// 单波均量：命中后必出 1 只、再以 p 追加第二只，所以期望值 = p × (1 + p)
const expectAvg = 0.50 * (1 + 0.50);
assert(rateHigh.avg <= expectAvg + 0.06 && rateHigh.avg >= 1.0 * 0.50 - 0.03,
  '单波平均精英数应约 ' + expectAvg.toFixed(2) + '（实际 ' + rateHigh.avg.toFixed(2) + '）');
console.log('L8b段 OK 出现率分层正确：第4波 ' + (rateLow.rate * 100).toFixed(1) + '%（目标20%）· 第8波 ' +
  (rateMid.rate * 100).toFixed(1) + '%（目标35%）· 第12波 ' + (rateHigh.rate * 100).toFixed(1) +
  '%（目标50%）· 单波均量 ' + rateHigh.avg.toFixed(2));

// L9 精英掉落：必定生命 + 额外强化机会上限 3
G.mode = 'endless'; G.wave = 12;
neon.eliteResetRun();
neon.startGame();
neon.eliteResetRun();
let bonusTotal = 0, dropTotal = 0;
for (let i = 0; i < 40; i++) {
  const e = freshElite('swift');
  G.pickups.length = 0;
  neon.killEnemy(e);
  dropTotal += G.pickups.length;
  if (G.p.pendingExtra > 0) { bonusTotal = G.eliteState.bonusPicksGiven; G.p.pendingExtra = 0; }
}
assert(dropTotal >= 40, '精英应必定掉落生命拾取物（40 只仅掉 ' + dropTotal + ' 个）');
assert(G.eliteState.bonusPicksGiven <= 3, '额外强化机会不应超过 3 次（实际 ' + G.eliteState.bonusPicksGiven + '）');
console.log('L9段 OK 精英掉落：40 只全部掉落生命 · 额外强化机会累计 ' +
  G.eliteState.bonusPicksGiven + '/' + ELITE_CONFIG.maxBonusPicks + '（受上限约束）');

// L10 分裂精英死亡后生成 4 个子体
const eS = freshElite('split');
G.enemies.length = 0;
G.enemies.push(eS);
const beforeKids = G.enemies.length;
neon.killEnemy(eS);
const kids = G.enemies.filter(function (x) { return x.eliteSplitChild; }).length;
assert(kids === 4, '分裂精英应生成 4 个子体（实际 ' + kids + '）');
for (const k of G.enemies) if (k.eliteSplitChild) {
  assert(k.hp <= k.maxHp + 0.01, '子体血量异常');
}
console.log('L10段 OK 分裂精英死亡生成 4 个子体，且子体被标记避免无限分裂');

// ============================================================
//  M 段：局内事件房「数据裂隙」（v1.6）
// ============================================================
const EVENTS = neon.EVENTS;
assert(EVENTS.length === 9, '事件应为 9 个，实际 ' + EVENTS.length);
const evIds = {};
for (const ev of EVENTS) {
  if (evIds[ev.id]) { console.error('FAIL: 事件 ID 重复 ' + ev.id); process.exit(1); }
  evIds[ev.id] = true;
  if (!ev.nm || !ev.lore) { console.error('FAIL: 事件 ' + ev.id + ' 缺名称或世界观'); process.exit(1); }
  if (!ev.options || ev.options.length !== 3) {
    console.error('FAIL: 事件 ' + ev.id + ' 选项数应为 3，实际 ' + (ev.options ? ev.options.length : 0)); process.exit(1);
  }
  for (const o of ev.options) {
    if (!o.nm || !o.ds || o.cost === undefined) { console.error('FAIL: 事件 ' + ev.id + ' 选项缺字段'); process.exit(1); }
    if (typeof o.fn !== 'function') { console.error('FAIL: 事件 ' + ev.id + ' 选项 ' + o.nm + ' 缺少效果函数'); process.exit(1); }
  }
}
console.log('M1段 OK 事件 ' + EVENTS.length + ' 个 · 每个 3 选项 · 均有世界观文案与代价标注');

// M2 触发规则：每 5 波一次，首领波顺延
G.mode = 'endless';
neon.startGame();
G.eventState = { usedEvents: [], current: null, pendingAfterBoss: false };
function triggerAt(wave) {
  G.wave = wave;
  return neon.shouldOpenEventRoom();
}
// 无尽模式首领波为 5 的倍数
assert(triggerAt(4) === false, '第 4 波不应触发事件房');
// 注意：shouldOpenEventRoom() 会消费顺延标记，所以每波只能调用一次
assert(triggerAt(5) === false, '第 5 波是首领波，不应触发（应顺延）');
assert(G.eventState.pendingAfterBoss === true, '首领波后应标记顺延');
assert(triggerAt(6) === true, '顺延后第 6 波应触发事件房');
assert(G.eventState.pendingAfterBoss === false, '触发后应清除顺延标记');
assert(triggerAt(7) === false, '第 7 波不应触发');
assert(triggerAt(8) === false, '第 8 波不应触发');
assert(triggerAt(9) === false, '第 9 波不应触发');
assert(triggerAt(10) === false, '第 10 波是首领波，不应触发');
assert(triggerAt(11) === true, '第 11 波应补上事件房');
assert(triggerAt(12) === false, '第 12 波不应触发');
assert(triggerAt(13) === false, '第 13 波不应触发');
assert(triggerAt(14) === false, '第 14 波不应触发');
assert(triggerAt(15) === false, '第 15 波是首领波，不应触发');
assert(triggerAt(16) === true, '第 16 波应补上事件房');
console.log('M2段 OK 触发规则：每 5 波一次 · 首领波自动顺延到下一波');

// M3 事件不重复：池耗尽后返回 null
G.eventState = { usedEvents: [], current: null, pendingAfterBoss: false };
const seen = [];
for (let i = 0; i < 9; i++) {
  const ev = neon.pickEvent();
  assert(ev, '第 ' + (i + 1) + ' 次抽取不应为空');
  if (seen.indexOf(ev.id) >= 0) { console.error('FAIL: 事件 ' + ev.id + ' 重复出现'); process.exit(1); }
  seen.push(ev.id);
  G.eventState.usedEvents.push(ev.id);
}
assert(seen.length === 9, '应能抽满 9 个不重复事件');
assert(neon.pickEvent() === null, '事件池耗尽后应返回 null（改为直接进入升级）');
console.log('M3段 OK 同一局内事件不重复，池耗尽后返回 null');

// M4 事件效果全部可执行且生效
G.mode = 'endless'; G.wave = 12;
neon.startGame();
const testResults = [];
function tryEvent(evId, optIdx) {
  neon.startGame();                 // 每个事件独立验证
  G.wave = 12;
  const p = G.p;
  p.pendingExtra = 0; p.taken = [];
  let before = { extra: p.pendingExtra, hp: p.hp, maxHp: p.maxHp, score: G.score, taken: p.taken.length };
  const ev = EVENTS.find(function (x) { return x.id === evId; });
  ev.options[optIdx].fn(p);
  return {
    ev: evId, opt: ev.options[optIdx].nm,
    dExtra: p.pendingExtra - before.extra,
    dHp: p.hp - before.hp,
    dMaxHp: p.maxHp - before.maxHp,
    dScore: G.score - before.score,
    dTaken: p.taken.length - before.taken
  };
}
// 逐个事件逐一验证（每个选项都要无异常）
let optCount = 0;
for (const ev of EVENTS) {
  for (let k = 0; k < ev.options.length; k++) {
    let r;
    try { r = tryEvent(ev.id, k); }
    catch (err) {
      console.error('FAIL: 事件 ' + ev.id + ' 选项 ' + ev.options[k].nm + ' 抛错 -> ' + err.message);
      process.exit(1);
    }
    optCount++;
    testResults.push(r);
  }
}
assert(optCount === 27, '应验证 27 个选项（9 事件 × 3）');
// 抽查几个有明确数值的效果
const qDebris = testResults.find(function (r) { return r.ev === 'debris' && r.dTaken >= 0 && /提取/.test(r.opt); });
assert(qDebris && qDebris.dExtra === 1, '「数据残骸·提取算力」应 +1 强化机会');
const qCache = testResults.find(function (r) { return r.ev === 'cache' && /清理/.test(r.opt); });
assert(qCache && qCache.dExtra === 2 && qCache.dMaxHp < 0, '「废弃缓存·清理」应 +2 强化机会并扣最大生命');
const qComp = testResults.find(function (r) { return r.ev === 'compress' && /压缩发育/.test(r.opt); });
assert(qComp && qComp.dExtra === 3, '「极限压缩·压缩发育」应 +3 强化机会');
const qTerm = testResults.find(function (r) { return r.ev === 'terminal' && /读取/.test(r.opt); });
assert(qTerm && qTerm.dTaken === 1, '「故障终端·读取」应获得 1 张卡');
const qRew = testResults.find(function (r) { return r.ev === 'rewrite' && /重写/.test(r.opt); });
assert(qRew && qRew.dExtra === 2, '「协议重写·重写」在空卡池时应 +2 强化机会（0 张 + 2）');
console.log('M4段 OK 27 个选项全部执行无异常，关键数值抽查通过');

// M5 玩家字段接入：真实伤害 / 下一波倍率 / 分数倍率 / 自损
neon.startGame();
G.wave = 12;
const p5 = G.p;
const erosion = EVENTS.find(function (e) { return e.id === 'erosion_test'; });
erosion.options[0].fn(p5);              // 熵蚀试验·进入
assert(p5.trueDamage === 3, '熵蚀试验：应设置 3 点真实伤害（实际 ' + p5.trueDamage + '）');
assert(p5.erosionDrain > 0, '熵蚀试验：应设置自损比例');
// 真实伤害绕过护盾：给敌人加护盾再打
G.enemies.length = 0;
const shielded = neon.spawnEnemy('chaser', 800, 800);
shielded.shield = 500; shielded.maxShield = 500;
const hpBefore = shielded.hp;
const fakeBullet = { x: 0, y: 0, dmg: 10 };
// 用真实路径：through G.p 作为 from 才会带真实伤害
const dmgCall = { x: 0, y: 0 };
G.p.slowHit = 0;
neon.damageEnemyRef(shielded, 10, false, p5);
assert(shielded.shield < 500, '护盾应被普通伤害削减');
assert(shielded.hp < hpBefore, '真实伤害应绕过护盾打到本体（' + hpBefore.toFixed(0) + ' -> ' + shielded.hp.toFixed(0) + '）');
// 下一波倍率
const rift = EVENTS.find(function (e) { return e.id === 'rift'; });
rift.options[0].fn(p5);                 // 封堵：敌人 -30% / 分数 -50%
assert(Math.abs(p5.nextWaveEnemyMul - 0.70) < 0.001, '封堵：敌人数量应 -30%');
assert(Math.abs(p5.nextWaveScoreMul - 0.50) < 0.001, '封堵：分数应 -50%');
const silence = EVENTS.find(function (e) { return e.id === 'silence_proto'; });
silence.options[0].fn(p5);              // 接受静默：射速 -25% / 分数 +150%
assert(Math.abs(p5.nextWaveRateMul - 1.25) < 0.001, '接受静默：射速应 -25%');
// 下一波开始后倍率应被消费（敌人数量倍率用掉即恢复）
G.enemies.length = 0; G.spawnQ.length = 0;
neon.startWave(13);
assert(Math.abs(G.p.nextWaveEnemyMul - 1) < 0.001, '下一波敌人数量倍率应在起波时消费掉');
console.log('M5段 OK 事件→玩家字段接入生效（真实伤害绕盾 / 下一波倍率消费 / 自损）');

// M6 辅助函数：随机获取卡 / 共鸣 / 清空重写
neon.startGame();
G.wave = 12;
const p6 = G.p;
p6.taken = [];
neon.grantRandomCard(p6, 3);
assert(p6.taken.length === 1, 'grantRandomCard 应写入 1 张卡（实际 ' + p6.taken.length + '）');
const gotId = p6.taken[0];
const gotCard = neon.UPG.find(function (u) { return u.id === gotId; });
assert(gotCard && gotCard.tier >= 3, 'grantRandomCard(minTier=3) 应给出史诗以上（实际 tier=' + (gotCard ? gotCard.tier : '?') + '）');
// 共鸣：应改变玩家数值
p6.taken = ['dmg', 'rate'];
const dmgBefore = p6.dmg, rateBefore = p6.rate;
neon.resonateCards(p6, 2);
assert(p6.dmg !== dmgBefore || p6.rate !== rateBefore, '共鸣应至少改变一项数值');
// 重写：清空记录并给等量+2
p6.taken = ['dmg', 'rate', 'crit'];
p6.pendingExtra = 0;
neon.rewriteAll(p6);
assert(p6.taken.length === 0, '重写应清空已选卡');
assert(p6.pendingExtra === 5, '重写应给 3 + 2 = 5 次强化机会（实际 ' + p6.pendingExtra + '）');
// 移除随机卡
p6.taken = ['dmg', 'rate'];
neon.removeRandomTaken(p6);
assert(p6.taken.length === 1, 'removeRandomTaken 应移除 1 张（实际 ' + p6.taken.length + '）');
console.log('M6段 OK 辅助函数：随机获取（限定品质）/ 共鸣 / 重写（等量+2）/ 随机移除');

// M6b 卡牌回退：每张卡都要能被精确撤销（本轮新增的核心能力）
const NUM_STATS = ['dmg', 'rate', 'bspeed', 'crit', 'critMul', 'pierce', 'proj', 'spread', 'homing',
  'boom', 'orbs', 'maxHp', 'dashCd', 'dashInv', 'thorns', 'lifesteal',
  'aegis', 'speed', 'regen', 'magnet', 'dropBonus', 'bounty', 'cardSlots', 'extraPicks'];
function snapshotStats(p) {
  const s = {};
  for (const k of NUM_STATS) s[k] = p[k];
  return s;
}
let undoBad = [];
for (const u of neon.UPG) {
  neon.startGame();
  const p = G.p;
  p.taken = []; p.takenDelta = [];
  p.maxHp = 200; p.hp = 120;             // 固定初始值，避免职业差异影响对比
  const before = snapshotStats(p);
  neon.applyUpgrade(p, u);
  if (p.taken.length !== 1) { undoBad.push(u.id + ':未被记录'); continue; }
  neon.removeTakenById(p, u.id);
  if (p.taken.length !== 0) { undoBad.push(u.id + ':未从 taken 移除'); continue; }
  if (p.takenDelta.length !== 0) { undoBad.push(u.id + ':增量记录未清理'); continue; }
  const after = snapshotStats(p);
  for (const k of NUM_STATS) {
    const b = before[k], a = after[k];
    if (typeof b !== 'number') continue;
    const tol = Math.max(1e-6, Math.abs(b) * 1e-6);
    if (Math.abs(a - b) > tol) undoBad.push(u.id + ': ' + k + ' ' + b + ' -> ' + a);
  }
  if (p.hp > p.maxHp + 1e-6) undoBad.push(u.id + ': 生命超过上限 ' + p.hp + '/' + p.maxHp);
  if (p.hp <= 0) undoBad.push(u.id + ': 生命被回退到 0');
}
if (undoBad.length) {
  console.error('FAIL: 卡牌回退不精确 -> ' + undoBad.slice(0, 6).join(' | '));
  process.exit(1);
}
console.log('M6b段 OK 卡池 ' + neon.UPG.length + ' 张卡逐张「应用 → 回退」后数值全部精确还原');

// M6c 同一张卡叠加两次后回退一张：只撤销一次的量
const stackCards = neon.UPG.filter(u => u.max >= 2 && u.rep !== 0);
let stackBad = [];
for (const u of stackCards) {
  neon.startGame();
  const p = G.p;
  p.taken = []; p.takenDelta = [];
  p.maxHp = 200; p.hp = 200;
  neon.applyUpgrade(p, u);
  const once = snapshotStats(p);
  neon.applyUpgrade(p, u);
  neon.removeTakenById(p, u.id);
  const after = snapshotStats(p);
  for (const k of NUM_STATS) {
    const o = once[k], a = after[k];
    if (typeof o !== 'number') continue;
    const tol = Math.max(1e-6, Math.abs(o) * 1e-6);
    if (Math.abs(a - o) > tol) stackBad.push(u.id + ': ' + k + ' 期望 ' + o + ' 实际 ' + a);
  }
  if (p.hp > p.maxHp + 1e-6) stackBad.push(u.id + ': 生命超上限');
}
if (stackBad.length) {
  console.error('FAIL: 叠加回退不正确 -> ' + stackBad.slice(0, 6).join(' | '));
  process.exit(1);
}
console.log('M6c段 OK 可叠加卡（' + stackCards.length + ' 张）叠两次后回退一张：只撤销一次的量');

// M6d 「重写」应把全部已选卡的效果一并回退
neon.startGame();
const pr = G.p;
pr.taken = []; pr.takenDelta = [];
pr.maxHp = 300; pr.hp = 300;
const randBase = snapshotStats(pr);
const pickedCards = ['dmg', 'rate', 'crit', 'vital', 'hpup', 'speed'].map(function (id) {
  return neon.UPG.find(function (u) { return u.id === id; });
});
for (const u of pickedCards) neon.applyUpgrade(pr, u);
const afterAll = snapshotStats(pr);
assert(Math.abs(afterAll.dmg - randBase.dmg) > 1e-6, '前置条件失败：应用后伤害应已改变');
pr.pendingExtra = 0;
const refunded = neon.rewriteAll(pr);
const afterRewrite = snapshotStats(pr);
assert(refunded.length === pickedCards.length, '重写应回退 ' + pickedCards.length + ' 张（实际 ' + refunded.length + '）');
assert(pr.taken.length === 0, '重写后已选卡应为空');
assert(pr.takenDelta.length === 0, '重写后增量记录应清空');
let rewriteBad = [];
for (const k of NUM_STATS) {
  const b = randBase[k], a = afterRewrite[k];
  if (typeof b !== 'number') continue;
  const tol = Math.max(1e-6, Math.abs(b) * 1e-6);
  if (Math.abs(a - b) > tol) rewriteBad.push(k + ' ' + b + ' -> ' + a);
}
if (rewriteBad.length) {
  console.error('FAIL: 重写未把 6 张卡的效果完全回退 -> ' + rewriteBad.join(', '));
  process.exit(1);
}
assert(pr.pendingExtra === pickedCards.length + 2,
  '重写应给 ' + (pickedCards.length + 2) + ' 次强化机会（实际 ' + pr.pendingExtra + '）');
console.log('M6d段 OK 协议重写：6 张卡效果全部回退到初始值，并发放 ' + pr.pendingExtra + ' 次强化机会');

// M6e 回退时生命值必须被正确夹到新上限内
neon.startGame();
const ph = G.p;
ph.taken = []; ph.takenDelta = [];
ph.maxHp = 200; ph.hp = 100;
const vitalCard = neon.UPG.find(function (u) { return u.id === 'vital'; });
neon.applyUpgrade(ph, vitalCard);
assert(Math.abs(ph.maxHp - 225) < 1e-6, '强化装甲应 +25 最大生命（实际 ' + ph.maxHp + '）');
neon.removeTakenById(ph, 'vital');
assert(Math.abs(ph.maxHp - 200) < 1e-6, '回退后最大生命应回到 200（实际 ' + ph.maxHp + '）');
assert(ph.hp <= ph.maxHp + 1e-6 && ph.hp > 0, '回退后生命应在 (0, 上限] 内（实际 ' + ph.hp + '/' + ph.maxHp + '）');
ph.maxHp = 200; ph.hp = 200;
const hpupCard = neon.UPG.find(function (u) { return u.id === 'hpup'; });
neon.applyUpgrade(ph, hpupCard);
neon.removeTakenById(ph, 'hpup');
assert(ph.maxHp <= 200 + 1e-6, '回退后最大生命不应超过 200（实际 ' + ph.maxHp.toFixed(1) + '）');
assert(ph.hp <= ph.maxHp + 1e-6, '回退后生命不应超过上限（' + ph.hp.toFixed(1) + '/' + ph.maxHp.toFixed(1) + '）');
console.log('M6e段 OK 回退后生命值正确夹在上限内（' + ph.hp.toFixed(0) + '/' + ph.maxHp.toFixed(0) + '）');

// M6f 贪婪核心回退：立刻兑现的强化机会与每波额外次数都要收回
neon.startGame();
const pg = G.p;
pg.taken = []; pg.takenDelta = [];
pg.pendingExtra = 0; pg.extraPicks = 0;
const greedCard = neon.UPG.find(function (u) { return u.id === 'greed'; });
neon.applyUpgrade(pg, greedCard);
assert(pg.extraPicks === 1 && pg.pendingExtra === 1, '贪婪核心应 +1 每波额外次数与 1 次机会');
neon.removeTakenById(pg, 'greed');
assert(pg.extraPicks === 0, '回退贪婪核心应收回每波额外次数（实际 ' + pg.extraPicks + '）');
assert(pg.pendingExtra === 0, '回退贪婪核心应收回已兑现的机会（实际 ' + pg.pendingExtra + '）');
console.log('M6f段 OK 贪婪核心回退：每波额外次数与已兑现机会均已收回');

// M6g 事件房「覆写」走真实入口时，数值也必须回退
neon.startGame();
const pE = G.p;
pE.taken = []; pE.takenDelta = [];
pE.maxHp = 200; pE.hp = 200;
const eBase = snapshotStats(pE);
for (const u of ['dmg', 'crit', 'vital']) {
  neon.applyUpgrade(pE, neon.UPG.find(function (x) { return x.id === u; }));
}
const evTerminal = EVENTS.find(function (e) { return e.id === 'terminal'; });
const pEBefore = snapshotStats(pE);
evTerminal.options[1].fn(pE);           // 覆写：随机回退 1 张 + 2 次机会
const pEAfter = snapshotStats(pE);
assert(pE.taken.length === 2, '覆写后应剩 2 张卡（实际 ' + pE.taken.length + '）');
assert(pE.pendingExtra === 2, '覆写应给 2 次强化机会（实际 ' + pE.pendingExtra + '）');
// 被回退的那张卡对应的数值必须下降（三张卡分别影响 dmg / crit / maxHp）
const changed = NUM_STATS.some(function (k) {
  return typeof pEBefore[k] === 'number' && Math.abs(pEAfter[k] - pEBefore[k]) > 1e-9;
});
assert(changed, '覆写应至少回退一项数值（实际数值没有任何变化，说明只删了记录）');
console.log('M6g段 OK 事件房「覆写」走真实入口：卡牌记录与数值同时回退');

// M7 事件房状态机：openEventRoom -> chooseEventOption -> 自动进入升级
G.mode = 'endless';
neon.startGame();
G.wave = 10;
G.eventState = { usedEvents: [], current: null, pendingAfterBoss: false };
neon.openEventRoom();
assert(G.state === 'event', 'openEventRoom 后状态应为 event（实际 ' + G.state + '）');
assert(G.eventState.current, '应记录当前事件 id');
assert(G.eventState.usedEvents.length === 1, '应记录已用事件');
assert(els.overlayEvent && !els.overlayEvent.classList.contains('hidden'), '事件面板应显示');
assert(els.eventBody.children.length === 3, '事件面板应有 3 个选项（实际 ' + els.eventBody.children.length + '）');
const firstEventId = G.eventState.current;
neon.chooseEventOption(0);
assert(G.state === 'upgrade', '选择选项后应直接进入升级选择（实际 ' + G.state + '）');
assert(G.eventState.current === null, '选择后应清空 current');
assert(els.overlayEvent.classList.contains('hidden'), '选择后事件面板应隐藏');
assert(G.eventState.usedEvents.indexOf(firstEventId) >= 0, '已用事件应保留在列表中');
console.log('M7段 OK 事件房状态机：开启 → 3 选项 → 选择后自动进入升级（不替代升级）');

console.log('ALL PASS (' + frames + ' 帧, 虚拟 ' + (t / 1000).toFixed(0) + ' 秒)');
process.exit(0);
