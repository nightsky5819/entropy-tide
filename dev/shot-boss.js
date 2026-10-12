// CDP 实时验证：首领护盾循环（破盾 -> 输出窗口 -> 重铸）并截取首领战画面
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ws = __dirname;
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
const PORT = 9336;
const URL_FILE = 'file:///' + GAME_FILE.replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    if (r.exceptionDetails) throw new Error('页面抛错: ' + JSON.stringify(r.exceptionDetails.exception));
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
  throw new Error('无法连接调试端口');
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--disable-breakpad', '--no-first-run', '--hide-scrollbars',
    '--user-data-dir=' + path.join(ws, '.chrome-boss'),
    '--remote-debugging-port=' + PORT, '--window-size=1360,940', 'about:blank'
  ], { stdio: 'ignore' });
  let cdp;
  try {
    cdp = new CDP(await connect());
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: URL_FILE });
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('typeof window.__neon === "object"')) break;
      await sleep(150);
    }

    // 开局并直接摆到第 10 波首领战（无尽模式，先锋）
    await cdp.eval(`
      (function(){
        var N = window.__neon, G = N.G;
        G.mode='endless'; G.cls='vanguard';
        N.startGame();
        G.wave = 9;
        N.startWave(10);
        G.p.maxHp = 500; G.p.hp = 500;
        for (var i=0;i<7;i++){ G.p.dmg *= 1.22; G.p.rate *= 0.9; }
        window.__log = [];
        window.__lastKey = '';
        // 记录护盾状态变化（真实帧循环里采样）
        window.__watch = setInterval(function(){
          var G = N.G, b = G.boss;
          if (!b) return;
          var key = (b.shield>0?'shield':'stagger') + ':' + (b.phase);
          if (key !== window.__lastKey) {
            window.__lastKey = key;
            window.__log.push({ t:+G.time.toFixed(1), shield:Math.round(b.shield),
              stagger:+b.stagger.toFixed(2), phase:b.phase });
          }
        }, 50);
        // 机器人：集火首领 + 保持不死，便于观察整段循环
        window.__bot = setInterval(function(){
          var G = N.G;
          if (G.state!=='playing'||!G.p) return;
          var b = G.boss;
          if (b) { N.mouse.x = b.x + (Math.random()-0.5)*40; N.mouse.y = b.y + (Math.random()-0.5)*40; }
          N.mouse.down = true;
          if (Math.random()<0.2) N.doDash();
          G.p.hp = G.p.maxHp;
        }, 60);
      })()
    `);
    await sleep(14000);   // 真实 14 秒首领战

    const st = await cdp.eval(`(function(){
      var N = window.__neon, G = N.G, b = G.boss;
      return {
        wave: G.wave, state: G.state,
        boss: b ? { hp: Math.round(b.hp), maxHp: b.maxHp, shield: Math.round(b.shield),
                    maxShield: b.maxShield, stagger: +b.stagger.toFixed(2), phase: b.phase } : null,
        ebullets: G.ebullets.length, bullets: G.bullets.length,
        log: window.__log
      };
    })()`);
    console.log('首领战实时状态: ' + JSON.stringify({
      wave: st.wave, state: st.state, boss: st.boss,
      ebullets: st.ebullets, bullets: st.bullets
    }));
    console.log('护盾状态变化序列（真实帧循环采样）:');
    for (const r of st.log) {
      console.log('  t=' + r.t + 's  ' + (r.shield > 0 ? '护盾 ' + r.shield : '输出窗口 ' + r.stagger + 's') + '  相位 ' + (r.phase + 1));
    }
    const shields = st.log.filter(r => r.shield > 0).length;
    const staggers = st.log.filter(r => r.shield === 0).length;
    const ok = shields >= 1 && staggers >= 1;
    console.log(ok
      ? '护盾循环在真实浏览器中确认：出现 ' + shields + ' 次护盾态 / ' + staggers + ' 次输出窗口'
      : '!!! 未观察到完整护盾循环');

    // 重开一场满血首领战，等它进入「护盾 + 弹幕」状态再截图
    await cdp.eval(`
      (function(){
        var N = window.__neon, G = N.G;
        G.wave = 9;
        N.startWave(10);
        var b = G.boss;
        if (b) { b.spawnT = 0; }
      })()
    `);
    await sleep(2600);
    const snap = await cdp.eval(`(function(){
      var N = window.__neon, G = N.G, b = G.boss;
      return b ? { hp: Math.round(b.hp), shield: Math.round(b.shield), phase: b.phase,
                   stagger: +b.stagger.toFixed(2), ebullets: G.ebullets.length } : null;
    })()`);
    console.log('截图时首领状态: ' + JSON.stringify(snap));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ws, 'v-boss.png'), Buffer.from(shot.data, 'base64'));
    console.log('首领战截图已写入 v-boss.png (' +
      Math.round(fs.statSync(path.join(ws, 'v-boss.png')).size / 1024) + ' KB)');
  } catch (e) {
    console.error('FAIL: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    await sleep(400);
  }
})();
