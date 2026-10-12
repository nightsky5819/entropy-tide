// 平衡测量：让一个「普通水平」机器人打普通波与首领波，量化时间/受伤/存活
// 机器人：自动瞄准最近敌人、按住开火、有冷却就冲刺、随机方向移动
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

const code = fs.readFileSync(GAME_FILE, 'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)[1];

// ---------- 最小桩 ----------
const gradient = { addColorStop() {} };
function makeCtx() {
  const c = {};
  ['save','restore','translate','rotate','scale','setTransform','beginPath','closePath','moveTo',
   'lineTo','quadraticCurveTo','bezierCurveTo','arc','rect','fill','stroke','clip','fillRect',
   'strokeRect','clearRect','drawImage','fillText','strokeText','setLineDash','createPattern',
   'measureText'].forEach(k => c[k] = () => undefined);
  ['fillStyle','strokeStyle','lineWidth','globalAlpha','globalCompositeOperation','shadowColor',
   'shadowBlur','font','textAlign','filter','imageSmoothingEnabled'].forEach(k => c[k] = '');
  c.createRadialGradient = () => gradient;
  c.createLinearGradient = () => gradient;
  return c;
}
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), id: '', children: [], style: {}, _handlers: {},
    className: '', textContent: '', _html: '', width: 0, height: 0,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (v === '') this.children.length = 0; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener() {}, dispatch(t, e) { (this._handlers[t] || []).forEach(f => f(e || {})); },
    click() { this.dispatch('click', { button: 0 }); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); this.children.splice(i, 1); return c; },
    get firstChild() { return this.children[0] || null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 960 }; },
    getAttribute() { return null; }, setAttribute() {},
    getContext() { return makeCtx(); }, focus() {}
  };
  return el;
}
const els = {};
['screen','overlayMenu','overlayUp','overlayPause','overlayOver','cards','uptitle','upsub',
 'pickhint','finStats','finTitle','modepick','clspick',
 'btnStart','btnAgain','btnMenu','btnResume','btnQuit','game'].forEach(id => {
  els[id] = makeEl(id === 'screen' ? 'canvas' : 'div'); els[id].id = id;
});
els.game.appendChild(els.screen);

const document = {
  getElementById: id => els[id] || makeEl('div'),
  createElement: t => makeEl(t),
  querySelectorAll: () => [],
  addEventListener() {}, body: makeEl('body')
};
const timers = new Map(); let seq = 1;
const sandbox = {
  console, document, navigator: { maxTouchPoints: 0 }, location: { hash: '' },
  localStorage: { getItem: () => null, setItem() {} },
  requestAnimationFrame(fn) { sandbox.__raf = fn; return 1; }, cancelAnimationFrame() {},
  setTimeout(fn, ms) { const id = seq++; timers.set(id, { fn, ms, t: ms }); return id; },
  setInterval(fn, ms) { const id = seq++; timers.set(id, { fn, ms, t: ms }); return id; },
  clearTimeout(id) { timers.delete(id); }, clearInterval(id) { timers.delete(id); },
  Math, Date, JSON, Object, Array, String, Number, Boolean, Error, isNaN, parseInt, parseFloat,
  Set, Map, Uint8ClampedArray, Symbol, RegExp, Promise, TypeError
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const winKeys = {};
sandbox.addEventListener = () => {};
sandbox.window.addEventListener = (t, fn) => { (winKeys[t] = winKeys[t] || []).push(fn); };
sandbox.window.removeEventListener = () => {};
sandbox.window.dispatchEvent = e => (winKeys[e.type] || []).forEach(f => f(e));

const ctx = vm.createContext(sandbox);
vm.runInContext(code, ctx, { filename: 'game.js' });
const neon = sandbox.__neon;
const G = neon.G;
const key = (type, k) => sandbox.window.dispatchEvent({ type, key: k, preventDefault() {} });

let t = 0;
function tick() {
  t += 16.7;
  timers.forEach(tm => { tm.t -= 16.7; if (tm.t <= 0) { tm.t = tm.ms; if (tm.ms <= 120) tm.fn(); } });
  sandbox.__raf(t);
}
// ---------- 机器人：首领优先，其次最近敌人 ----------
function aimTarget() {
  const p = G.p; if (!p) return;
  let best = null, bd = Infinity;
  for (const e of G.enemies) {
    if (e.dead) continue;
    const bossBonus = e.boss ? -1e9 : 0;          // 首领优先集火
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2 + bossBonus;
    if (d < bd) { bd = d; best = e; }
  }
  if (best) {
    els.screen.dispatch('mousemove', { clientX: best.x - neon.cam.x, clientY: best.y - neon.cam.y });
  }
}
// 机器人输入：接近目标到射程内 + 按住开火 + 走位 + 冲刺
// （子弹射程约 500px，站桩不打接近的敌人会严重低估清场速度）
let strafe = 1;
function botInput(i) {
  aimTarget();
  const p = G.p;
  if (!p) return;
  // 找最近敌人，决定是接近还是走位
  let best = null, bd = Infinity;
  for (const e of G.enemies) {
    if (e.dead) continue;
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  const dist = best ? Math.sqrt(bd) : 0;
  if (best && dist > 380) {
    // 接近：朝目标移动
    const dx = best.x - p.x, dy = best.y - p.y;
    key('keydown', dx > 20 ? 'd' : (dx < -20 ? 'a' : (strafe > 0 ? 'd' : 'a')));
    key('keyup', dx > 20 ? 'a' : (dx < -20 ? 'd' : (strafe > 0 ? 'a' : 'd')));
    if (dy > 20) { key('keydown', 's'); key('keyup', 'w'); }
    else if (dy < -20) { key('keydown', 'w'); key('keyup', 's'); }
    else { key('keyup', 'w'); key('keyup', 's'); }
  } else {
    // 交火：横向走位
    if (i % 90 === 0) strafe = -strafe;
    key('keydown', strafe > 0 ? 'd' : 'a');
    key('keyup', strafe > 0 ? 'a' : 'd');
    if (i % 50 === 0) { key('keydown', 's'); } else if (i % 50 === 25) { key('keyup', 's'); }
  }
  els.screen.dispatch('mousedown', { button: 0 });
  if (i % 150 === 0 && G.p && G.p.dashCd <= 0) key('keydown', ' ');
}

// ---------- 场景 1：普通波（第 3 / 8 / 14 波）----------
function measureWave(waveNo, seconds) {
  neon.startGame();
  G.wave = waveNo - 1;
  neon.startWave(waveNo);
  // 测量清场耗时为主，给足血量避免机器人暴毙导致 gameOver 中断模拟
  G.p.maxHp = 1e6; G.p.hp = 1e6;
  let frames = 0;
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    if (G.p) G.p.hp = G.p.maxHp;             // 不死
    if (G.state !== 'playing') G.state = 'playing';   // 防止 gameOver 冻结波次
    botInput(i);
    tick();
    frames++;
    const alive = G.enemies.filter(e => !e.dead).length;
    if (alive === 0 && G.spawnQ.length === 0 && G.waveState === 'clear') break;
  }
  return { frames, seconds: frames / 60 };
}

// ---------- 场景 2：首领波 ----------
// upgradeCount: 模拟玩家在该波次前大约已获得的升级数，还原真实成长曲线
// bossKind: 指定首领类型（不传则按波次自动选择）
function measureBoss(waveNo, upgradeCount, bossKind) {
  neon.startGame();
  G.wave = waveNo - 1;
  neon.startWave(waveNo);
  if (bossKind) {
    // 清掉自动生成的首领，换成指定类型
    G.enemies.length = 0; G.boss = null; G.bossEnt = null; G.ebullets.length = 0;
    G.spawnQ.length = 0;
    neon.spawnBoss(bossKind);
  }
  G.p.maxHp = 1e6; G.p.hp = 1e6;   // 首领战只看输出节奏，避免中途暴毙打断测量
  if (upgradeCount > 0) {
    // 按真实玩家会选的方向加点：以输出为主
    const order = ['dmg', 'rate', 'dmg', 'proj', 'rate', 'crit', 'dmg', 'pierce', 'rate', 'crit', 'homing', 'dmg'];
    const vals = {};
    for (let i = 0; i < upgradeCount; i++) {
      const id = order[i % order.length];
      const u = neon.UPG.find(x => x.id === id);
      if (u) { vals[id] = (vals[id] || 0) + 1; if (vals[id] <= u.max) u.fn(G.p); }
    }
  }
  const boss = G.boss;
  const stats = {
    wave: waveNo, upgrades: upgradeCount,
    bossHp: boss.maxHp, shield: boss.maxShield,
    tShield: null, tKill: null, phasesSeen: {}, maxEBullets: 0, dmgDealt: 0
  };
  let frames = 0;
  for (let i = 0; i < 60 * 180; i++) {
    if (G.p) G.p.hp = G.p.maxHp;
    const hpBefore = G.boss ? G.boss.hp + G.boss.shield : 0;
    botInput(i);
    tick();
    frames++;
    const b = G.boss;
    if (b) {
      const hpNow = b.hp + b.shield;
      if (hpBefore - hpNow > 0) stats.dmgDealt += (hpBefore - hpNow);
      const eb = G.ebullets.length;
      if (eb > stats.maxEBullets) stats.maxEBullets = eb;
    }
    if (!b) { stats.tKill = frames / 60; break; }
    if (stats.tShield === null && b.shield <= 0) stats.tShield = frames / 60;
    stats.phasesSeen[b.phase] = (stats.phasesSeen[b.phase] || 0) + 1;
  }
  const secs = stats.tKill === null ? frames / 60 : stats.tKill;
  stats.dps = stats.dmgDealt / secs;
  stats.theoryDps = Math.round(G.p.dmg * G.p.proj / G.p.rate);
  return stats;
}

console.log('=== 普通波耗时（机器人清场）===');
for (const w of [3, 8, 14]) {
  const r = measureWave(w, 90);
  console.log('  第 ' + String(w).padStart(2) + ' 波: ' + r.seconds.toFixed(1) + 's 清场');
}

console.log('=== 三型首领（同一玩家水平、第 10 波）===');
for (const k of Object.keys(neon.BOSS_TYPES)) {
  const s = measureBoss(10, 7, k);
  const def = neon.BOSS_TYPES[k];
  console.log('  ' + (def.nm + '(' + k + ')').padEnd(14) +
    ' 血 ' + String(Math.round(s.bossHp)).padStart(6) +
    ' 盾 ' + String(Math.round(s.shield)).padStart(5) +
    ' | 破盾 ' + (s.tShield === null ? '  -  ' : s.tShield.toFixed(1) + 's') +
    ' | 击杀 ' + (s.tKill === null ? '超时>180s' : (s.tKill.toFixed(1) + 's').padStart(7)) +
    ' | 峰值敌弹 ' + String(s.maxEBullets).padStart(3) +
    ' | 定位: ' + (def.hasShield ? '护盾血牛' : (def.spd > 180 ? '高速刺客' : '标准')));
}

console.log('=== 首领波（按波次自动出怪）===');
for (const [w, up] of [[5, 3], [10, 7], [15, 11]]) {
  const s = measureBoss(w, up);
  console.log('  第 ' + String(w).padStart(2) + ' 波: 首领 ' + Math.round(s.bossHp) +
    ' + 护盾 ' + Math.round(s.shield) +
    ' | 已升级 ' + up + ' 次(理论 DPS ' + s.theoryDps + ')' +
    ' | 破盾 ' + (s.tShield === null ? '未破' : s.tShield.toFixed(1) + 's') +
    ' | 击杀 ' + (s.tKill === null ? '超时>180s' : s.tKill.toFixed(1) + 's') +
    ' | 实测 DPS ' + s.dps.toFixed(0) +
    ' | 峰值敌弹 ' + s.maxEBullets);
}
console.log('=== 设计目标：首领战 30-60s（普通波 10-50s）===');
