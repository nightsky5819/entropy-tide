// v1.9 层背景出图工具：为 5 个层各截一张真实战斗画面，供人工审查
//   用法：node layer-shots.js
//   实现：CDP 驱动真实 Chrome —— 注入局面 → 真实等 1.2 秒 → Page.captureScreenshot
//   （不用 --virtual-time-budget：虚拟时间下偶尔会在首帧渲染前就截图，产出黑屏）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ws = __dirname;
const GAME_FILE = (function () {
  const cands = [path.join(__dirname, '..', 'index.html'), path.join(__dirname, 'index.html')];
  for (const p of cands) if (fs.existsSync(p)) return p;
  console.error('FAIL: 找不到 index.html');
  process.exit(1);
})();
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9349;
const PROFILE = path.join(ws, '.chrome-layer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rmrf = p => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {} };

class CDP {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.pending = new Map(); }
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

const SHOTS = [
  { theme: 'blue',   wave: 5,  nm: '缓存区' },
  { theme: 'purple', wave: 15, nm: '情绪池' },
  { theme: 'gold',   wave: 25, nm: '记忆库' },
  { theme: 'red',    wave: 35, nm: '核心协议' },
  { theme: 'white',  wave: 45, nm: '自毁倒计时' }
];

const setupExpr = wave => `(function () {
  var N = window.__neon, G = N.G, mouse = N.mouse, info = N.getLayerForWave(${wave});
  G.mode = 'endless';
  N.startGame();                                   // 建立真实一局（第 1 波不播过渡）
  G.wave = ${wave};
  G.p.hp = 1e6; G.p.maxHp = 1e6; G.p.inv = 1e6;
  G.layerState.currentLayer = info.layer.id;
  G.layerState.currentLayerIndex = info.index;
  G.layerState.cycle = info.cycle;
  G.layerState.collapseAmount = (info.layer.id === 'selfdestruct') ? 0.20 : 0;
  G.layerState.transitionT = 0;
  N.buildBackgroundForLayer(info.layer.theme);
  // 带上该层的代表性词缀，让截图里的词缀常驻条也真实（缓存区本来就没有层词缀）
  var demoAffix = { cache: null, emotion: 'anxiety', memory: 'fragment', core: 'throttle', selfdestruct: 'collapse' }[info.layer.id];
  if (demoAffix) {
    G.affixes = { list: [demoAffix], primary: demoAffix, secondary: null };
    G.affixState.residueZones = []; G.affixState.resonanceCount = 0;
  } else {
    N.affixClear();
  }
  G.spawnQ.length = 0; G.waveState = 'fighting';   // 冻结波次推进，画面停在战斗中
  G.enemies.length = 0;
  var kinds = info.layer.enemies;
  for (var i = 0; i < 8; i++) {
    var e = N.spawnEnemy(kinds[i % kinds.length], 420 + (i % 4) * 380, 360 + Math.floor(i / 4) * 430);
    if (e) { e.hp = 1e6; e.maxHp = 1e6; e.spawnT = 0; e.spd *= 0.25; }
  }
  G.p.x = 1120; G.p.y = 800;
  N.camUpdate(0, true);
  mouse.down = true; mouse.x = G.p.x + 520; mouse.y = G.p.y - 260;
  G.time = 4 + ${wave} * 0.37;
  return { layer: info.layer.nm, theme: G.layerState.bgTheme, enemies: G.enemies.length, state: G.state, hud: (G.p ? 'ok' : 'no-player') };
})()`;

(async () => {
  rmrf(PROFILE);
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--disable-breakpad', '--no-first-run', '--hide-scrollbars',
    '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });
  let cdp = null;
  try {
    let url = null;
    for (let i = 0; i < 80 && !url; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        const pg = list.find(t => t.type === 'page');
        if (pg && pg.webSocketDebuggerUrl) url = pg.webSocketDebuggerUrl;
      } catch (e) {}
      if (!url) await sleep(200);
    }
    if (!url) throw new Error('无法连接调试端口 ' + PORT);
    cdp = new CDP(url);
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // 固定视口 1440x900（与其他截图工具一致，避免 headless 视口抖动）
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
      });
    } catch (e) {}
    await cdp.send('Page.navigate', { url: 'file:///' + GAME_FILE.replace(/\\/g, '/') });
    for (let i = 0; i < 60; i++) {
      if (await cdp.eval('typeof window.__neon === "object" && !!window.__neon.G')) break;
      await sleep(200);
    }
    await sleep(400);

    for (const s of SHOTS) {
      const info = await cdp.eval(setupExpr(s.wave));
      await sleep(1200);                                   // 真实等待，让战斗画面稳定下来
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const png = path.join(ws, '_layer-' + s.theme + '.png');
      fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
      console.log((s.theme + ' (' + info.layer + ')').padEnd(24) +
        'wave ' + String(s.wave).padStart(3) +
        ' · 敌人 ' + info.enemies + ' · ' + info.state + ' · ' + info.hud +
        ' -> ' + Math.round(fs.statSync(png).size / 1024) + ' KB');
    }
  } catch (e) {
    console.error('FAIL: ' + ((e && e.stack) || e));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    await sleep(500);
    rmrf(PROFILE);
  }
})();
