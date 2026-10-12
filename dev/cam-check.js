// CDP 实测：相机跟随的滞后与回弹（对比幻影高速场景），并抽取实战截图
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
const PORT = 9337;
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
    '--user-data-dir=' + path.join(ws, '.chrome-cam'),
    '--remote-debugging-port=' + PORT, '--window-size=1360,860', 'about:blank'
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

    // 幻影 + 满移速：最容易暴露相机问题的组合
    await cdp.eval(`
      (function(){
        var N = window.__neon, G = N.G;
        G.mode='endless'; G.cls='phantom';
        N.startGame();
        G.wave = 7;
        N.startWave(8);
        G.p.maxHp = 400; G.p.hp = 400;
        for (var i=0;i<4;i++){ G.p.speed *= 1.12; }
        // 采样：每帧记录玩家速度、相机速度、相机相对玩家的偏移
        window.__cam = [];
        window.__lastCam = null;
        window.__lastP = null;
        (function loop(){
          requestAnimationFrame(loop);
          var c = N.cam, p = N.G.p;
          if (!p) return;
          var offx = (p.x - c.x - N.VW/2), offy = (p.y - c.y - N.VH/2);
          var cdx = window.__lastCam ? (c.x - window.__lastCam.x) : 0;
          var cdy = window.__lastCam ? (c.y - window.__lastCam.y) : 0;
          var pdx = window.__lastP ? (p.x - window.__lastP.x) : 0;
          var pdy = window.__lastP ? (p.y - window.__lastP.y) : 0;
          window.__cam.push({
            t:+N.G.time.toFixed(2), sp:Math.round(Math.hypot(p.vx,p.vy)),
            off:Math.round(Math.hypot(offx,offy)),
            camStep:+Math.hypot(cdx,cdy).toFixed(2),
            pStep:+Math.hypot(pdx,pdy).toFixed(2)
          });
          if (window.__cam.length > 3000) window.__cam.shift();
          window.__lastCam = { x:c.x, y:c.y };
          window.__lastP = { x:p.x, y:p.y };
        })();
        // 每帧驱动：直接给一个高速环绕速度（避开输入系统，专测相机）
        var n = 0;
        (function drive(){
          requestAnimationFrame(drive);
          var G = N.G;
          if (G.state !== 'playing' || !G.p) return;
          n++;
          var ang = n * 0.05;
          var sp = G.p.speed * 0.95;
          G.p.vx = Math.cos(ang) * sp;
          G.p.vy = Math.sin(ang) * sp;
          G.p.hp = G.p.maxHp;
          var e=null,bd=1e18;
          for (var k=0;k<G.enemies.length;k++){
            var q=G.enemies[k]; if(q.dead) continue;
            var dd=(q.x-G.p.x)*(q.x-G.p.x)+(q.y-G.p.y)*(q.y-G.p.y);
            if(dd<bd){bd=dd;e=q;}
          }
          if(e){ N.mouse.x=e.x; N.mouse.y=e.y; }
          N.mouse.down = true;
          if(n % 40 === 0) N.doDash();
        })();
      })()
    `);
    await sleep(8000);

    const st = await cdp.eval(`(function(){
      var N = window.__neon, G = N.G, c = N.cam, p = G.p;
      var arr = window.__cam;
      var maxOff = 0, sumOff = 0, n = 0, maxSp = 0;
      var lagSteps = [], camSteps = [], frozenFast = 0, movingFast = 0;
      arr.forEach(function(r){
        maxOff = Math.max(maxOff, r.off); sumOff += r.off; n++;
        maxSp = Math.max(maxSp, r.sp);
        var rel = r.pStep - r.camStep;      // 同帧内相机比角色少走的距离 = 滞后
        if (r.pStep > 6) {                  // 只统计角色确实在快速移动的帧
          movingFast++;
          if (r.camStep < 0.5) frozenFast++;   // 相机几乎不动
          lagSteps.push(rel);
          camSteps.push(r.camStep);
        }
      });
      lagSteps.sort(function(a,b){ return a-b; });
      var med = lagSteps.length ? lagSteps[Math.floor(lagSteps.length/2)] : 0;
      var p95 = lagSteps.length ? lagSteps[Math.floor(lagSteps.length*0.95)] : 0;
      return {
        samples: n,
        playerMaxSpeed: maxSp,
        movingFrames: movingFast,
        frozenWhileFast: frozenFast,
        medianLagPerFrame: +med.toFixed(2),
        p95LagPerFrame: +p95.toFixed(2),
        avgOffset: n ? Math.round(sumOff / n) : 0,
        maxOffset: Math.round(maxOff),
        cls: G.cls, speedStat: Math.round(p.speed)
      };
    })()`);
    console.log('幻影高速相机实测: ' + JSON.stringify(st));
    console.log('  玩家峰值速度 ' + st.playerMaxSpeed + 'px/s（常速上限 ' + st.speedStat + '）');
    console.log('  快速移动帧 ' + st.movingFrames + ' 中，相机几乎静止的帧 ' + st.frozenWhileFast +
      '（占比 ' + (st.movingFrames ? (st.frozenWhileFast / st.movingFrames * 100).toFixed(1) : '0') + '%）');
    console.log('  每帧相对滞后：中位数 ' + st.medianLagPerFrame + 'px · P95 ' + st.p95LagPerFrame + 'px');
    console.log('  相机相对视口中心偏移：平均 ' + st.avgOffset + 'px · 最大 ' + st.maxOffset + 'px（含场地边缘钳制）');

    // 抽一张实战图（幻影 + 脉冲/霰弹职业无关，这里就是幻影）
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ws, 'v-phantom.png'), Buffer.from(shot.data, 'base64'));
    console.log('已写入 v-phantom.png (' +
      Math.round(fs.statSync(path.join(ws, 'v-phantom.png')).size / 1024) + ' KB)');
  } catch (e) {
    console.error('FAIL: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    await sleep(400);
  }
})();
