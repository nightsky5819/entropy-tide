// 用 CDP 实时驱动真实浏览器：跑一段真实战斗再截图（虚拟时间下 rAF 不推进，不能用截图法）
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
const PORT = 9335;
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
    '--user-data-dir=' + path.join(ws, '.chrome-cdp-shot'),
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

    // 以「闯关模式 · 守望者」开局，并布景到第 8 波附近的中期战斗
    await cdp.eval(`
      (function(){
        var N = window.__neon, G = N.G;
        G.mode = 'campaign'; G.cls = 'warden';
        N.startGame();               // 用选好的模式/职业开局
        G.wave = 7;
        N.startWave(8);              // 直接摆到第 8 波的战斗
        G.p.maxHp = 400; G.p.hp = 400;
        for (var i=0;i<7;i++){ G.p.dmg *= 1.2; }
        G.score = 18420; G.kills = 96; G.combo = 3.4; G.comboT = 2.2;
        window.__bot = setInterval(function(){
          var G = N.G;
          if (G.state!=='playing'||!G.p) return;
          var e=null,bd=1e18;
          for (var k=0;k<G.enemies.length;k++){
            var q=G.enemies[k]; if(q.dead) continue;
            var dd=(q.x-G.p.x)*(q.x-G.p.x)+(q.y-G.p.y)*(q.y-G.p.y);
            if(q.boss) dd-=1e12;
            if(dd<bd){bd=dd;e=q;}
          }
          if(e){ N.mouse.x=e.x; N.mouse.y=e.y; }
          N.mouse.down = true;
          N.mouse.x += (Math.random()-0.5)*30; N.mouse.y += (Math.random()-0.5)*30;
          if(Math.random()<0.25) N.doDash();
          G.p.hp = G.p.maxHp;   // 保持不死，便于观察战斗画面
        }, 60);
      })()
    `);
    await sleep(7000);   // 真实 7 秒战斗

    const st = await cdp.eval(`(function(){
      var N = window.__neon, G = N.G, cam = N.cam;
      var vis=0;
      for (var k=0;k<G.enemies.length;k++){
        var q=G.enemies[k];
        if(!q.dead && q.x>cam.x-60 && q.x<cam.x+N.VW+60 && q.y>cam.y-60 && q.y<cam.y+N.VH+60) vis++;
      }
      return { wave:G.wave, state:G.state, cls:G.cls, mode:G.mode,
        enemies:G.enemies.length, visible:vis, bullets:G.bullets.length,
        ebullets:G.ebullets.length, score:G.score, kills:G.kills,
        omni:G.p.omni, dps:Math.round(G.p.dmg*G.p.proj/G.p.rate) };
    })()`);
    console.log('实时战斗状态: ' + JSON.stringify(st));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ws, 'v-play.png'), Buffer.from(shot.data, 'base64'));
    console.log('实战截图已更新 (' + Math.round(fs.statSync(path.join(ws, 'v-play.png')).size / 1024) + ' KB)');
  } catch (e) {
    console.error('FAIL: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    await sleep(400);
  }
})();
