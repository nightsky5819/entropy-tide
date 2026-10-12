// 本轮新增内容的真机验证：天赋树 UI / 词缀 HUD / 跳过键 / 章节结算
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
const PORT = 9340;
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
const shotTo = async (cdp, name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(ws, name);
  fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
  return Math.round(fs.statSync(p).size / 1024);
};

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--disable-breakpad', '--no-first-run', '--hide-scrollbars',
    '--user-data-dir=' + path.join(ws, '.chrome-r6'),
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

    // 1) 标题页上的天赋树入口
    console.log('1) 标题页含「底层算力模块」按钮 = ' + (await cdp.eval(`!!document.getElementById('btnTalentsTitle')`)));
    // 给一些点数，便于观察 available/unlocked 三种状态
    await cdp.eval(`(function(){var M=window.__neon.META;
      M.points=24; M.totalEarned=41; M.endlessWavesCleared=18;
      M.unlocked={A0:true,A1:true,A2:true,R1:true,B1:true};
      window.__neon.metaSave(); return 1;})()`);
    await click('btnTalentsTitle');
    await sleep(400);
    const tree = await cdp.eval(`(function(){
      var nodes=document.querySelectorAll('#talentTree .talent-node');
      var unlocked=document.querySelectorAll('#talentTree .talent-node.unlocked').length;
      var avail=document.querySelectorAll('#talentTree .talent-node.available').length;
      var locked=document.querySelectorAll('#talentTree .talent-node.locked').length;
      return {total:nodes.length,unlocked:unlocked,available:avail,locked:locked,
        points:document.getElementById('talentPoints').textContent.slice(0,40),
        visible:!document.getElementById('overlayTalents').classList.contains('hidden')};
    })()`);
    console.log('2) 天赋树面板 = ' + JSON.stringify(tree));
    console.log('   截图 ' + (await shotTo(cdp, 'v-talents.png')) + ' KB');

    // 3) 点一个 available 节点应当解锁并扣点
    const before = await cdp.eval('window.__neon.META.points');
    await cdp.eval(`document.querySelector('#talentTree .talent-node.available').click(); 1`);
    await sleep(200);
    const after = await cdp.eval('window.__neon.META.points');
    const unlockedNow = await cdp.eval(`document.querySelectorAll('#talentTree .talent-node.unlocked').length`);
    console.log('3) 点击可解锁节点：点数 ' + before + ' -> ' + after + ' · 已解锁 ' + unlockedNow + ' 个');
    // 4) 洗点
    await click('btnTalentReset');
    await sleep(250);
    const resetState = await cdp.eval(`(function(){var M=window.__neon.META;
      return {points:M.points,unlocked:Object.keys(M.unlocked).length};})()`);
    console.log('4) 洗点后 = ' + JSON.stringify(resetState));
    await click('btnTalentClose');
    await sleep(200);
    console.log('   返回标题页 = ' + !(await cdp.eval(hidden('overlayTitle'))));

    // 5) 剧情模式：跳过键
    await click('btnEnter');
    await sleep(150);
    await cdp.eval(`document.querySelector('#modepick .pick[data-mode="campaign"]').click(); 1`);
    await click('btnModeNext');
    await sleep(350);
    console.log('5) 序章可见 = ' + !(await cdp.eval(hidden('overlayStory'))) +
      ' · 含跳过按钮 = ' + (await cdp.eval(`!!document.getElementById('btnStorySkip')`)));
    console.log('   截图 ' + (await shotTo(cdp, 'v-story-skip.png')) + ' KB');
    await click('btnStorySkip');
    await sleep(250);
    console.log('   跳过后：序章隐藏 = ' + (await cdp.eval(hidden('overlayStory'))) +
      ' · 职业页可见 = ' + !(await cdp.eval(hidden('overlayCls'))));

    // 6) 开战并强制造出词缀，检查 HUD 常驻词缀条
    //    注意：首领波（wave % bossEvery === 0）按规格不附加词缀，这里用第 9 波
    await click('btnStart');
    await sleep(500);
    const aff = await cdp.eval(`(function(){
      var N=window.__neon, G=N.G;
      G.wave=8; N.startWave(9);
      return {list:G.affixes.list, primary:G.affixes.primary,
        erosion:G.affixState.erosionZones.length};
    })()`);
    console.log('6) 词缀波（第 9 波，非首领） = ' + JSON.stringify(aff));
    // 跑到有敌人的时候再截图（词缀条常驻，任何时刻都可见）
    await cdp.eval(`(function(){var N=window.__neon,G=N.G;
      G.p.maxHp=600;G.p.hp=600;
      window.__bot=setInterval(function(){var G=N.G;
        if(G.state!=='playing'||!G.p) return;
        var e=null,bd=1e18;
        for(var k=0;k<G.enemies.length;k++){var q=G.enemies[k];if(q.dead)continue;
          var d=(q.x-G.p.x)*(q.x-G.p.x)+(q.y-G.p.y)*(q.y-G.p.y);
          if(q.boss)d-=1e12; if(d<bd){bd=d;e=q;}}
        if(e){N.mouse.x=e.x;N.mouse.y=e.y;}
        N.mouse.down=true; G.p.hp=G.p.maxHp;
        if(Math.random()<0.15) N.doDash();
      },60);})()`);
    await sleep(4500);
    const inGame = await cdp.eval(`(function(){var N=window.__neon,G=N.G;
      return {state:G.state,wave:G.wave,enemies:G.enemies.length,
        affixes:G.affixes.list,erosionZones:G.affixState.erosionZones.length,
        debris:G.affixState.debrisList.length,bounds:N.getFieldBounds()};})()`);
    console.log('7) 战斗状态 = ' + JSON.stringify(inGame));
    console.log('   截图 ' + (await shotTo(cdp, 'v-affix.png')) + ' KB');

    // 8) 收缩光墙 + 熵蚀场地的可视化（用剧情模式战场，1500×1000 大于视口，收 15% 后仍在视野内）
    await cdp.eval(`(function(){var N=window.__neon,G=N.G;
      G.mode='campaign'; G.wave=3; N.startWave(4);
      G.affixes={list:['shrink','erosion'],primary:'shrink',secondary:'erosion'};
      G.affixState={erosionZones:[{x:900,y:600,r:120,born:G.time},{x:1400,y:900,r:120,born:G.time}],
        erosionTick:0,echoKillCount:0,debrisTimer:0,debrisList:[],shrinkAmount:0.15};
      G.p.maxHp=800; G.p.hp=800;
      return 1;})()`);
    await sleep(1800);
    const vis = await cdp.eval(`(function(){var N=window.__neon,G=N.G;
      return {affixes:G.affixes.list,bounds:N.getFieldBounds(),
        zones:G.affixState.erosionZones.length,hp:Math.round(G.p.hp)};})()`);
    console.log('8) 收缩+熵蚀 可视化 = ' + JSON.stringify(vis));
    console.log('   截图 ' + (await shotTo(cdp, 'v-shrink-erosion.png')) + ' KB');

    // 9) 章节结算面板
    await cdp.eval(`(function(){var N=window.__neon,G=N.G;
      G.mode='campaign'; G.wave=5; G.enemies.length=0; G.spawnQ.length=0;
      G.waveState='clear'; G.waveDelay=0.05; return 1;})()`);
    await sleep(1400);
    const fin = await cdp.eval(`(function(){
      return {state:window.__neon.G.state,
        visible:!document.getElementById('overlayOver').classList.contains('hidden'),
        title:document.getElementById('finTitle').textContent,
        note:document.getElementById('finNote').textContent};})()`);
    console.log('9) 章节结算 = ' + JSON.stringify(fin));
    console.log('   截图 ' + (await shotTo(cdp, 'v-chapter.png')) + ' KB');

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
