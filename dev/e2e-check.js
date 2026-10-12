// 端到端真机验证：标题 -> 模式 -> 序章 -> 职业 -> 战斗 -> 首领，并截最终画面
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
const PORT = 9338;
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
const hidden = id => `document.getElementById('${id}').classList.contains('hidden')`;

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--disable-breakpad', '--no-first-run', '--hide-scrollbars',
    '--user-data-dir=' + path.join(ws, '.chrome-e2e'),
    '--remote-debugging-port=' + PORT, '--window-size=1360,860', 'about:blank'
  ], { stdio: 'ignore' });
  let cdp;
  const errors = [];
  try {
    cdp = new CDP(await connect());
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push((d.exception && d.exception.description) || d.text);
      }
    });
    await cdp.send('Page.navigate', { url: URL_FILE });
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('typeof window.__neon === "object"')) break;
      await sleep(150);
    }
    const click = id => cdp.eval(`document.getElementById('${id}').click(); 1`);

    console.log('1) 标题页可见 = ' + !(await cdp.eval(hidden('overlayTitle'))));
    console.log('   游戏标题 = ' + (await cdp.eval(`document.querySelector('.gametitle').textContent.replace(/\\s+/g,'')`)));
    await click('btnEnter');
    await sleep(120);
    console.log('2) 模式页可见 = ' + !(await cdp.eval(hidden('overlayMode'))) +
      ' · 模式数 = ' + (await cdp.eval(`document.querySelectorAll('#modepick .pick').length`)));

    // 显式选剧情模式（按 data-mode 定位，不依赖顺序），进入序章
    await cdp.eval(`document.querySelector('#modepick .pick[data-mode="campaign"]').click(); 1`);
    await click('btnModeNext');
    await sleep(400);
    console.log('3) 序章可见 = ' + !(await cdp.eval(hidden('overlayStory'))) +
      ' · 标题 = ' + (await cdp.eval(`document.getElementById('storyHead').textContent`)));
    let steps = 0;
    while (!(await cdp.eval(hidden('overlayStory'))) && steps < 20) {
      await click('btnStoryNext');
      await sleep(120);
      steps++;
    }
    console.log('   序章推进段数 = ' + steps + ' · 之后职业页可见 = ' + !(await cdp.eval(hidden('overlayCls'))));
    console.log('4) 职业数 = ' + (await cdp.eval(`document.querySelectorAll('#clspick .pick').length`)));

    // 选枪炮师（第 3 个）并开战
    await cdp.eval(`document.querySelectorAll("#clspick .pick")[2].click(); 1`);
    await click('btnStart');
    await sleep(400);
    const s1 = await cdp.eval(`(function(){var N=window.__neon,G=N.G;return {state:G.state,mode:G.mode,cls:G.cls,
      panelsHidden:['overlayTitle','overlayMode','overlayCls','overlayStory'].every(function(i){return document.getElementById(i).classList.contains('hidden');}),
      canvas:[N.screen.width,N.screen.height]};})()`);
    console.log('5) 开战: ' + JSON.stringify(s1));

    // 跳到首领战：显式召唤第 10 波对应的血牛型首领
    await cdp.eval(`
      (function(){
        var N=window.__neon,G=N.G;
        G.wave=10;
        G.enemies.length=0; G.boss=null; G.bossEnt=null; G.ebullets.length=0; G.spawnQ.length=0;
        N.spawnBoss('brute');
        G.p.maxHp=600; G.p.hp=600;
        for(var i=0;i<7;i++){ G.p.dmg*=1.2; G.p.rate*=0.92; }
        window.__bot=setInterval(function(){
          var G=N.G; if(G.state!=='playing'||!G.p) return;
          var b=G.boss, t=b||null;
          if(!t){ for(var k=0;k<G.enemies.length;k++){ if(!G.enemies[k].dead){t=G.enemies[k];break;} } }
          if(t){ N.mouse.x=t.x+(Math.random()-0.5)*30; N.mouse.y=t.y+(Math.random()-0.5)*30; }
          N.mouse.down=true; G.p.hp=G.p.maxHp;
          if(Math.random()<0.12) N.doDash();
        },60);
      })()
    `);
    await sleep(3500);
    const s2 = await cdp.eval(`(function(){var N=window.__neon,G=N.G,b=G.boss;
      return {wave:G.wave,bossKind:b?b.bossKind:null,bossName:b?b.def.nm:null,
      bossHp:b?Math.round(b.hp):0,bossShield:b?Math.round(b.shield):0,
      ebullets:G.ebullets.length,bullets:G.bullets.length,kills:G.kills};})()`);
    console.log('6) 首领战: ' + JSON.stringify(s2));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ws, 'v-e2e.png'), Buffer.from(shot.data, 'base64'));
    console.log('   已写入 v-e2e.png (' +
      Math.round(fs.statSync(path.join(ws, 'v-e2e.png')).size / 1024) + ' KB)');
    console.log(errors.length ? ('!!! 页面异常 ' + errors.length + ' 个:\n' + errors.slice(0, 3).join('\n')) : '页面无未处理异常');
  } catch (e) {
    console.error('FAIL: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    await sleep(400);
  }
})();
