// 验证 HTTP 服务器上运行的游戏：完整走一遍流程并截图
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
const PORT = 9339;
const GAME_URL = process.argv[2] || 'http://127.0.0.1:8080/index.html';
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
    '--user-data-dir=' + path.join(ws, '.chrome-http'),
    '--remote-debugging-port=' + PORT, '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });
  let cdp;
  const errors = [];
  const failed = [];
  try {
    cdp = new CDP(await connect());
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    cdp.ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push((d.exception && d.exception.description) || d.text);
      }
      if (m.method === 'Network.loadingFailed') failed.push(m.params.errorText + ' ' + m.params.type);
    });

    console.log('访问: ' + GAME_URL);
    await cdp.send('Page.navigate', { url: GAME_URL });
    for (let i = 0; i < 100; i++) {
      if (await cdp.eval('typeof window.__neon === "object"')) break;
      await sleep(150);
    }
    const proto = await cdp.eval('location.protocol');
    console.log('页面协议 = ' + proto + ' （应为 http:）');
    console.log('__neon 就绪 = ' + (await cdp.eval('typeof window.__neon')));

    const click = id => cdp.eval(`document.getElementById('${id}').click(); 1`);
    const hidden = id => `document.getElementById('${id}').classList.contains('hidden')`;

    console.log('标题页 = ' + (await cdp.eval(`document.querySelector('.gametitle').textContent.replace(/\\s+/g,'')`)));
    await click('btnEnter');
    await sleep(150);
    await cdp.eval(`document.querySelector('#modepick .pick[data-mode="endless"]').click(); 1`);
    await click('btnModeNext');
    await sleep(200);
    console.log('无尽模式跳过剧情、进入职业页 = ' + !(await cdp.eval(hidden('overlayCls'))));
    await click('btnStart');
    await sleep(600);

    // 真机跑一段战斗
    await cdp.eval(`
      (function(){
        var N=window.__neon,G=N.G;
        G.wave=5; N.startWave(6);
        G.p.maxHp=500; G.p.hp=500;
        for(var i=0;i<5;i++){ G.p.dmg*=1.2; }
        window.__bot=setInterval(function(){
          var G=N.G; if(G.state!=='playing'||!G.p) return;
          var e=null,bd=1e18;
          for(var k=0;k<G.enemies.length;k++){
            var q=G.enemies[k]; if(q.dead) continue;
            var d=(q.x-G.p.x)*(q.x-G.p.x)+(q.y-G.p.y)*(q.y-G.p.y);
            if(q.boss) d-=1e12;
            if(d<bd){bd=d;e=q;}
          }
          if(e){ N.mouse.x=e.x; N.mouse.y=e.y; }
          N.mouse.down=true; G.p.hp=G.p.maxHp;
          if(Math.random()<0.15) N.doDash();
        },60);
      })()
    `);
    await sleep(6000);
    const st = await cdp.eval(`(function(){var N=window.__neon,G=N.G;
      return {state:G.state,wave:G.wave,score:G.score,enemies:G.enemies.length,
      bullets:G.bullets.length,parts:G.parts.length,canvas:[N.screen.width,N.screen.height]};})()`);
    console.log('战斗 6 秒后: ' + JSON.stringify(st));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ws, 'v-http.png'), Buffer.from(shot.data, 'base64'));
    console.log('已写入 v-http.png (' + Math.round(fs.statSync(path.join(ws, 'v-http.png')).size / 1024) + ' KB)');
    console.log('资源加载失败 = ' + (failed.length ? failed.join(' | ') : '无'));
    console.log(errors.length ? ('!!! 页面异常:\n' + errors.slice(0, 3).join('\n')) : '页面无未处理异常');
  } catch (e) {
    console.error('FAIL: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    await sleep(400);
  }
})();
