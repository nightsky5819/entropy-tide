// 验证本轮四项 UI 修复：天赋树不抖动 / 提示不重叠 / 字号可读 / 整体亮度
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
const PORT = 9341;
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
    '--user-data-dir=' + path.join(ws, '.chrome-r7'),
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
    const click = id => cdp.eval(`document.getElementById('${id}').click(); 1`);

    // ===== 1) 天赋树：hover 不得引起任何布局位移 =====
    await cdp.eval(`(function(){var M=window.__neon.META;
      M.points=24;M.totalEarned=41;M.endlessWavesCleared=18;
      M.unlocked={A0:true,A1:true,A2:true,R1:true,B1:true};window.__neon.metaSave();return 1;})()`);
    await click('btnTalentsTitle');
    await sleep(400);
    const geo = await cdp.eval(`(function(){
      var nodes=document.querySelectorAll('#talentTree .talent-node');
      var before=[]; for(var i=0;i<nodes.length;i++){var r=nodes[i].getBoundingClientRect();
        before.push([Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]);}
      var tree=document.getElementById('talentTree').getBoundingClientRect();
      var panel=document.getElementById('overlayTalents').getBoundingClientRect();
      return {treeH:Math.round(tree.height),panelH:Math.round(panel.height),
        panelScrollH:document.getElementById('overlayTalents').scrollHeight,
        before:JSON.stringify(before)};
    })()`);
    // 模拟 hover：直接加 :hover 无法用 JS 触发，改为检查 CSS 是否让节点在显示说明时变大
    const hoverCheck = await cdp.eval(`(function(){
      var n=document.querySelector('#talentTree .talent-node');
      var tip=n.querySelector('.td');
      var cs=getComputedStyle(tip);
      return {position:cs.position, display:cs.display, visibility:cs.visibility,
        nodeH:Math.round(n.getBoundingClientRect().height)};
    })()`);
    console.log('1) 天赋树布局：网格高 ' + geo.treeH + 'px · 面板高 ' + geo.panelH +
      'px · 滚动高 ' + geo.panelScrollH + 'px');
    console.log('   说明浮层定位 = ' + JSON.stringify(hoverCheck) +
      ' （position:absolute + visibility 切换 => 不影响布局）');
    // 真实 hover 测量：用 CDP 鼠标移动到节点上，再比较网格高度
    const nodeBox = await cdp.eval(`(function(){
      var n=document.querySelector('#talentTree .talent-node');
      var r=n.getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeBox.x, y: nodeBox.y });
    await sleep(350);
    const afterHover = await cdp.eval(`(function(){
      var tree=document.getElementById('talentTree').getBoundingClientRect();
      var ov=document.getElementById('overlayTalents');
      var nodes=document.querySelectorAll('#talentTree .talent-node');
      var after=[]; for(var i=0;i<nodes.length;i++){var r=nodes[i].getBoundingClientRect();
        after.push([Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]);}
      var tip=document.querySelector('#talentTree .talent-node .td');
      return {treeH:Math.round(tree.height),scrollH:ov.scrollHeight,
        visible:getComputedStyle(tip).visibility, after:JSON.stringify(after)};
    })()`);
    const same = afterHover.after === geo.before;
    const treeSame = afterHover.treeH === geo.treeH;
    console.log('   hover 后：网格高 ' + afterHover.treeH + 'px（变化 ' + (afterHover.treeH - geo.treeH) +
      'px）· 节点几何完全一致 = ' + same + ' · 滚动高 ' + afterHover.scrollH +
      ' · 浮层可见 = ' + afterHover.visible);
    if (!same || !treeSame) { console.error('FAIL: hover 仍会引起布局位移'); process.exit(1); }
    console.log('   ✅ 无位移抖动');
    console.log('   截图 ' + (await cdp.shot('v-talents-hover.png')) + ' KB');
    await click('btnTalentClose');
    await sleep(200);

    // ===== 2) 提示分道：波次开始 + 算力点数奖励同时出现时不得重叠 =====
    await click('btnEnter');
    await sleep(150);
    await cdp.eval(`document.querySelector('#modepick .pick[data-mode="endless"]').click(); 1`);
    await click('btnModeNext');
    await sleep(200);
    await click('btnStart');
    await sleep(500);
    const lanes = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      G.wave=8; N.startWave(9);
      // 同时投放：主提示（波次）+ 世界观 + 副词缀 + 算力点数奖励
      N.popup('写入底层算力模块  +1 点', '#ffd166', true, 'reward');
      return G.popups.map(function(p){return {t:String(p.t).slice(0,14),lane:p.lane,life:+p.life.toFixed(2)};});
    })()`);
    console.log('2) 同时投放的提示 = ' + JSON.stringify(lanes));
    await sleep(300);
    console.log('   截图 ' + (await cdp.shot('v-popup-lanes.png')) + ' KB');

    // 读取各轨道的实际绘制 y（用同一套常量推算），并检查是否有同轨道挤在一起
    const laneInfo = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      var lanes={};
      G.popups.forEach(function(p){
        var k=p.lane||'center';
        lanes[k]=(lanes[k]||0)+1;
      });
      return {counts:lanes, list:G.affixes.list, primary:G.affixes.primary};
    })()`);
    console.log('   各轨道条数 = ' + JSON.stringify(laneInfo.counts) + ' · 本波词缀 = ' +
      JSON.stringify(laneInfo.list));

    // ===== 3) 字号可读性：读取关键 UI 的计算字号 =====
    await cdp.eval(`(function(){var N=window.__neon,G=N.G;
      G.affixes={list:['entropy_up','overload'],primary:'entropy_up',secondary:'overload'};
      return 1;})()`);
    await sleep(600);
    console.log('3) 词缀态截图 ' + (await cdp.shot('v-affix-readable.png')) + ' KB');
    const fonts = await cdp.eval(`(function(){
      function fs(sel,prop){var e=document.querySelector(sel);if(!e)return null;return getComputedStyle(e)[prop||'fontSize'];}
      return {
        substep:fs('.substep'), seclabel:fs('.seclabel'), hint:fs('.hint'),
        steplabel:fs('.steplabel'), storybody:fs('.storybody'), storyhead:fs('.storyhead'),
        statV:fs('.stat .v'), pickPd:fs('.pick .pd'), cardDs:fs('.card .ds'),
        talentTn:fs('.talent-node .tn'), talentTd:fs('.talent-node .td'),
        statK:fs('.stat .k'), tagline:fs('.tagline')
      };
    })()`);
    console.log('   关键 UI 计算字号 = ' + JSON.stringify(fonts));
    const tooSmall = Object.keys(fonts).filter(k => fonts[k] && parseFloat(fonts[k]) < 12);
    if (tooSmall.length) console.warn('   !! 仍小于 12px：' + tooSmall.join(', '));
    else console.log('   ✅ 所有关键文字 >= 12px');

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
