// v1.6 补充验证：卡牌"真正回退"（走真实 UI / 事件入口）
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
const PORT = 9346;
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
  async shot(name) {
    const s = await this.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(ws, name);
    fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
    return Math.round(fs.statSync(p).size / 1024);
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
    '--user-data-dir=' + path.join(ws, '.chrome-r9'),
    '--remote-debugging-port=' + PORT, '--window-size=1440,900', 'about:blank'
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

    // ===== 1) 走真实升级卡 UI：点卡后数值变化，再回退，数值必须还原 =====
    await cdp.eval(`(function(){var N=window.__neon,G=N.G;
      G.mode='endless'; N.startGame();
      G.p.taken=[]; G.p.takenDelta=[]; G.p.maxHp=200; G.p.hp=200;
      G.wave=8; N.openUpgrade(); return 1;})()`);
    await sleep(200);
    const uiState = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      var cards=document.querySelectorAll('#cards .card');
      var before={dmg:G.p.dmg, maxHp:G.p.maxHp, taken:G.p.taken.length, cards:cards.length};
      cards[0].click();                       // 走真实点击入口
      var afterPick={dmg:G.p.dmg, maxHp:G.p.maxHp, taken:G.p.taken.length,
        delta:G.p.takenDelta.length};
      var pickedId=G.p.taken[0];
      N.removeTakenById(G.p, pickedId);
      var afterUndo={dmg:G.p.dmg, maxHp:G.p.maxHp, taken:G.p.taken.length,
        delta:G.p.takenDelta.length};
      return {before:before, afterPick:afterPick, afterUndo:afterUndo, pickedId:pickedId};
    })()`);
    console.log('1) 真实升级卡 UI 流程：');
    console.log('   点卡前 = ' + JSON.stringify(uiState.before));
    console.log('   点卡后 = ' + JSON.stringify(uiState.afterPick) + '（' + uiState.pickedId + '）');
    console.log('   回退后 = ' + JSON.stringify(uiState.afterUndo));
    const c = uiState;
    if (c.afterUndo.dmg !== c.before.dmg || c.afterUndo.maxHp !== c.before.maxHp ||
        c.afterUndo.taken !== 0 || c.afterUndo.delta !== 0) {
      console.error('FAIL: 真实 UI 入口的回退未完全还原');
      process.exit(1);
    }
    console.log('   ✅ 伤害/最大生命/卡牌记录全部精确还原');

    // ===== 2) 事件房「故障终端 · 覆写」：数值必须真的下降 =====
    const evTest = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      N.startGame();
      G.p.taken=[]; G.p.takenDelta=[]; G.p.maxHp=200; G.p.hp=200;
      G.wave=10;
      ['dmg','crit','vital'].forEach(function(id){
        N.applyUpgrade(G.p, N.UPG.filter(function(u){return u.id===id;})[0]);
      });
      var before={dmg:G.p.dmg, crit:G.p.crit, maxHp:G.p.maxHp, taken:G.p.taken.slice()};
      var ev=N.EVENTS.filter(function(e){return e.id==='terminal';})[0];
      ev.options[1].fn(G.p);                  // 覆写
      var after={dmg:G.p.dmg, crit:G.p.crit, maxHp:G.p.maxHp, taken:G.p.taken.slice(),
        pending:G.p.pendingExtra, delta:G.p.takenDelta.length};
      return {before:before, after:after};
    })()`);
    console.log('2) 事件房「覆写」：');
    console.log('   覆写前 = ' + JSON.stringify(evTest.before));
    console.log('   覆写后 = ' + JSON.stringify(evTest.after));
    const changed = evTest.after.dmg !== evTest.before.dmg ||
                    evTest.after.crit !== evTest.before.crit ||
                    evTest.after.maxHp !== evTest.before.maxHp;
    if (!changed) { console.error('FAIL: 覆写只删了记录，数值没有回退'); process.exit(1); }
    if (evTest.after.pending !== 2) { console.error('FAIL: 覆写应给 2 次强化机会'); process.exit(1); }
    console.log('   ✅ 数值确实随卡牌一起被撤销，并发放 2 次强化机会');

    // ===== 3) 协议重写：全部还原 + 记录清空 =====
    const rw = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      N.startGame();
      G.p.taken=[]; G.p.takenDelta=[]; G.p.maxHp=300; G.p.hp=300;
      var base={dmg:G.p.dmg, rate:G.p.rate, maxHp:G.p.maxHp, speed:G.p.speed};
      ['dmg','rate','vital','speed','crit'].forEach(function(id){
        N.applyUpgrade(G.p, N.UPG.filter(function(u){return u.id===id;})[0]);
      });
      var peak={dmg:G.p.dmg, rate:G.p.rate, maxHp:G.p.maxHp, speed:G.p.speed};
      G.p.pendingExtra=0;
      var refunded=N.rewriteAll(G.p);
      var after={dmg:G.p.dmg, rate:G.p.rate, maxHp:G.p.maxHp, speed:G.p.speed,
        pending:G.p.pendingExtra, taken:G.p.taken.length, delta:G.p.takenDelta.length};
      return {base:base, peak:peak, refunded:refunded.length, after:after};
    })()`);
    console.log('3) 协议重写：');
    console.log('   初始 = ' + JSON.stringify(rw.base));
    console.log('   5 张卡后 = ' + JSON.stringify(rw.peak));
    console.log('   重写后 = ' + JSON.stringify(rw.after) + '（回退 ' + rw.refunded + ' 张）');
    if (Math.abs(rw.after.dmg - rw.base.dmg) > 1e-6 || Math.abs(rw.after.rate - rw.base.rate) > 1e-6 ||
        Math.abs(rw.after.speed - rw.base.speed) > 1e-6 || Math.abs(rw.after.maxHp - rw.base.maxHp) > 1e-6) {
      console.error('FAIL: 重写未把数值还原到初始值');
      process.exit(1);
    }
    if (rw.after.pending !== 7) { console.error('FAIL: 重写应给 5+2=7 次机会'); process.exit(1); }
    console.log('   ✅ 5 张卡全部还原到初始值，发放 7 次强化机会，记录清空');

    // ===== 4) 相位精英 + 图片留档 =====
    await cdp.eval(`(function(){var N=window.__neon,G=N.G;
      G.mode='endless'; N.startGame(); G.wave=9;
      N.eliteResetWave(); G.eliteState.waveRolled=true; G.eliteState.waveAllowance=2;
      G.enemies.length=0;
      var a=N.spawnEnemy('tank',700,700); N.makeElite(a,'shield');
      var b=N.spawnEnemy('chaser',1000,760); N.makeElite(b,'phase');
      G.p.maxHp=5000; G.p.hp=5000;
      window.__bot=setInterval(function(){
        var G=N.G; if(G.state!=='playing'||!G.p) return;
        G.p.hp=G.p.maxHp;
        var e=null,bd=1e18;
        for(var k=0;k<G.enemies.length;k++){var q=G.enemies[k];if(q.dead)continue;
          var d=(q.x-G.p.x)*(q.x-G.p.x)+(q.y-G.p.y)*(q.y-G.p.y);
          if(q.elite)d-=1e12; if(d<bd){bd=d;e=q;}}
        if(e){N.mouse.x=e.x;N.mouse.y=e.y;} N.mouse.down=true;
      },60);
      return 1;})()`);
    await sleep(1500);
    console.log('4) 精英截图 ' + (await cdp.shot('v-elite.png')) + ' KB');

    console.log(errors.length ? ('!!! 页面异常:\n' + errors.slice(0, 4).join('\n')) : '页面无未处理异常');
  } catch (e) {
    console.error('FAIL: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    await sleep(400);
  }
})();
