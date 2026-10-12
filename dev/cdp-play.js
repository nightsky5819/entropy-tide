// DevTools 协议驱动的真实浏览器验证：真实按键 + 真实帧循环，并在动起来之后截图
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
const PORT = 9334;
const URL_FILE = 'file:///' + GAME_FILE.replace(/\\/g, '/');
const SHOT = path.join(ws, 'shot-final.png');

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); }
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
        } else if (m.method) { (this.handlers || []).forEach(h => h(m)); }
      };
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面抛错: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const KEYS = {
  w: { key: 'w', code: 'KeyW', vk: 87 }, a: { key: 'a', code: 'KeyA', vk: 65 },
  s: { key: 's', code: 'KeyS', vk: 83 }, d: { key: 'd', code: 'KeyD', vk: 68 },
  ' ': { key: ' ', code: 'Space', vk: 32 }
};
async function key(cdp, name, down) {
  const k = KEYS[name];
  await cdp.send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('无法连接调试端口');
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--disable-breakpad', '--no-first-run', '--user-data-dir=' + path.join(ws, '.chrome-cdp2'),
    '--remote-debugging-port=' + PORT, '--window-size=1280,880', 'about:blank'
  ], { stdio: 'ignore' });

  let cdp;
  try {
    cdp = new CDP(await connect());
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const errors = [];
    cdp.handlers = [m => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push((d.exception && d.exception.description) || d.text);
      }
    }];

    await cdp.send('Page.navigate', { url: URL_FILE });
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval('typeof window.__neon === "object"')) break;
      await sleep(150);
    }
    // 关键：等待游戏自己跑一会儿，确认帧循环活着
    await cdp.eval('document.getElementById("btnStart").click(); 1');
    await sleep(700);
    const t1 = await cdp.eval('__neon.G.time');
    await sleep(600);
    const t2 = await cdp.eval('__neon.G.time');
    console.log('帧循环存活: 0.6s 内推进 ' + (t2 - t1).toFixed(2) + 's 游戏时间');

    // 真实按键：朝右下移动 + 持续开火（鼠标按住）
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 440, button: 'left', clickCount: 1 });
    await key(cdp, 'd', true);
    await key(cdp, 's', true);
    await sleep(900);
    const mid = await cdp.eval('(function(){var p=__neon.G.p;return {x:+p.x.toFixed(0),y:+p.y.toFixed(0),vx:Math.round(p.vx),vy:Math.round(p.vy),time:+__neon.G.time.toFixed(1)};})()');
    console.log('按住 D+S 后: ' + JSON.stringify(mid));
    // 冲刺
    await key(cdp, ' ', true);
    await sleep(60);
    await key(cdp, ' ', false);
    await sleep(220);
    const afterDash = await cdp.eval('(function(){var p=__neon.G.p;return {x:+p.x.toFixed(0),y:+p.y.toFixed(0),speed:Math.round(Math.hypot(p.vx,p.vy)),time:+__neon.G.time.toFixed(1)};})()');
    console.log('冲刺 0.28s 后: ' + JSON.stringify(afterDash));
    await key(cdp, 'd', false);
    await key(cdp, 's', false);

    // 让战斗打一会儿，再截图
    await sleep(4500);
    const fin = await cdp.eval('(function(){var g=__neon.G;return {wave:g.wave,score:g.score,kills:g.kills,enemies:g.enemies.length,bullets:g.bullets.length,parts:g.parts.length,time:+g.time.toFixed(1)};})()');
    console.log('4.5s 后战斗状态: ' + JSON.stringify(fin));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('截图已写入 shot-final.png (' + Math.round(fs.statSync(SHOT).size / 1024) + ' KB)');
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
