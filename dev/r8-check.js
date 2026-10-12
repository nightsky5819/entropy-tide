// v1.6 真机验证：精英怪外观/血条/相位 + 事件房 UI 与完整流程
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
const PORT = 9342;
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
    '--user-data-dir=' + path.join(ws, '.chrome-r8'),
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

    // 版本标记
    console.log('0) 标题页版本标记 = ' + JSON.stringify(await cdp.eval(
      `document.querySelector('#overlayTitle .sub').textContent`)));

    // ===== 1) 精英怪实战：强制刷 2 只不同词缀的精英，截图看外观/血条/图标 =====
    await click('btnEnter');
    await sleep(150);
    await cdp.eval(`document.querySelector('#modepick .pick[data-mode="endless"]').click(); 1`);
    await click('btnModeNext');
    await sleep(200);
    await click('btnStart');
    await sleep(500);
    const eliteInfo = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      G.wave=9; N.startWave(10); G.wave=9;
      N.eliteResetWave(); N.eliteRollWave();
      G.enemies.length=0;
      var a=N.spawnEnemy('tank',700,700); N.makeElite(a,'shield');
      var b=N.spawnEnemy('chaser',1000,760); N.makeElite(b,'phase');
      var c=N.spawnEnemy('darter',850,1000); N.makeElite(c,'swift');
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
      return G.enemies.map(function(e){return {t:e.type,aff:e.eliteAffix,elite:!!e.elite,
        r:+e.r.toFixed(1),hp:Math.round(e.maxHp),shield:Math.round(e.shield||0)};});
    })()`);
    console.log('1) 强制造的精英 = ' + JSON.stringify(eliteInfo));
    await sleep(1200);
    const eliteLive = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      return G.enemies.map(function(e){return {aff:e.eliteAffix,invuln:!!e.invuln,
        hpFrac:+(e.hp/e.maxHp).toFixed(2),shield:Math.round(e.shield||0)};});
    })()`);
    console.log('   1.2 秒后状态 = ' + JSON.stringify(eliteLive));
    console.log('   截图 ' + (await cdp.shot('v-elite.png')) + ' KB');
    // 相位精英应进入过相位态
    await sleep(2600);
    const phaseSeen = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      var ph=G.enemies.filter(function(e){return e.elitePhase;});
      return {phaseElites:ph.length, anyInvuln:ph.some(function(e){return !!e.invuln;}),
        phaseT:ph.length?+ph[0].elitePhaseT.toFixed(2):null};
    })()`);
    console.log('   相位检查 = ' + JSON.stringify(phaseSeen));
    console.log('   截图 ' + (await cdp.shot('v-elite-phase.png')) + ' KB');

    // ===== 2) 精英出现率：每波只掷一次骰子（真实流程）
    const nat = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      G.mode='endless';
      var bands={ 'low(3-5)':{trial:0,hit:0}, 'mid(6-10)':{trial:0,hit:0}, 'high(11+)':{trial:0,hit:0} };
      var affs={}, maxPerWave=0;
      for(var trial=0; trial<2000; trial++){
        [4,8,12].forEach(function(w){
          G.wave=w; N.eliteResetWave(); N.eliteRollWave(); G.enemies.length=0;
          var n=0;
          for(var t=0;t<40;t++){
            var q=N.trySpawnElite('chaser',600,600);
            if(q){ n++; affs[q.eliteAffix]=(affs[q.eliteAffix]||0)+1; }
          }
          var key = w<=5 ? 'low(3-5)' : (w<=10 ? 'mid(6-10)' : 'high(11+)');
          bands[key].trial++; if(n>0) bands[key].hit++;
          maxPerWave=Math.max(maxPerWave,n);
        });
      }
      var rate={};
      Object.keys(bands).forEach(function(k){
        rate[k]=bands[k].trial? (bands[k].hit/bands[k].trial*100).toFixed(1)+'%' : 'n/a';
      });
      return {observedRate:rate, targetRate:{'low(3-5)':'20%','mid(6-10)':'35%','high(11+)':'50%'},
        maxPerWaveObserved:maxPerWave, affixDist:affs};
    })()`);
    console.log('2) 精英出现率（每波掷一次骰） =');
    console.log('   实测 ' + JSON.stringify(nat.observedRate) + ' · 目标 ' + JSON.stringify(nat.targetRate));
    console.log('   单波最多出现 ' + nat.maxPerWaveObserved + ' 只 · 词缀分布 ' + JSON.stringify(nat.affixDist));
    if (nat.maxPerWaveObserved > 2) { console.error('FAIL: 单波精英超过 2 只'); process.exit(1); }
    const bad2 = Object.keys(nat.targetRate).filter(function (k) {
      return Math.abs(parseFloat(nat.observedRate[k]) - parseFloat(nat.targetRate[k])) > 4;
    });
    if (bad2.length) { console.error('FAIL: 出现率偏离目标 ' + bad2.join(',')); process.exit(1); }
    console.log('   ✅ 三档出现率均在目标 ±4% 内');

    // ===== 3) 事件房：真实 DOM 与流程 =====
    await cdp.eval(`(function(){var N=window.__neon,G=N.G;
      clearInterval(window.__bot);
      G.mode='endless'; N.startGame(); G.wave=10;
      G.eventState={usedEvents:[],current:null,pendingAfterBoss:false};
      N.openEventRoom(); return 1;})()`);
    await sleep(350);
    const evDom = await cdp.eval(`(function(){
      var ov=document.getElementById('overlayEvent');
      var opts=document.querySelectorAll('#eventBody .event-opt');
      var o0=opts[0];
      return {state:window.__neon.G.state, visible:!ov.classList.contains('hidden'),
        title:document.getElementById('eventTitle').textContent,
        lore:document.getElementById('eventLore').textContent.slice(0,28)+'…',
        optCount:opts.length,
        optFonts:getComputedStyle(o0.querySelector('.eo-nm')).fontSize,
        loreFont:getComputedStyle(document.getElementById('eventLore')).fontSize};
    })()`);
    console.log('3) 事件房 DOM = ' + JSON.stringify(evDom));
    console.log('   截图 ' + (await cdp.shot('v-event-room.png')) + ' KB');
    // 选第 1 项，应进入升级面板
    const flow = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      document.querySelectorAll('#eventBody .event-opt')[0].click();
      return {state:G.state, eventHidden:document.getElementById('overlayEvent').classList.contains('hidden'),
        upgradeVisible:!document.getElementById('overlayUp').classList.contains('hidden'),
        cards:document.getElementById('cards').children.length,
        usedEvents:G.eventState.usedEvents.length};
    })()`);
    console.log('4) 选择选项后流程 = ' + JSON.stringify(flow));
    console.log('   截图 ' + (await cdp.shot('v-event-after.png')) + ' KB');

    // ===== 4) 完整链路：清空第 5 波(首领) -> 第 6 波起 -> 事件房 -> 升级 =====
    const chain = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G;
      G.mode='endless'; N.startGame();
      G.eventState={usedEvents:[],current:null,pendingAfterBoss:false};
      // 模拟"清空第 5 波"这件事对触发判定的影响
      G.wave=5; var at5=N.shouldOpenEventRoom();
      var pending=G.eventState.pendingAfterBoss;
      G.wave=6; var at6=N.shouldOpenEventRoom();
      return {at5:at5, pendingAfter5:pending, at6:at6};
    })()`);
    console.log('5) 触发链路 = ' + JSON.stringify(chain) +
      ' （第5波首领波不开→标记顺延，第6波开）');

    // ===== 5) 每个事件都能真实渲染出 3 个选项（按真实流程逐个抽取） =====
    const allEv = await cdp.eval(`(function(){
      var N=window.__neon,G=N.G, out=[];
      G.mode='endless'; N.startGame(); G.wave=10;
      G.eventState={usedEvents:[],current:null,pendingAfterBoss:false};
      for(var i=0;i<N.EVENTS.length;i++){
        N.openEventRoom();                       // 内部会记录 usedEvents 并挑选未重复事件
        var opts=document.querySelectorAll('#eventBody .event-opt');
        out.push({nm:G.eventState.current, opts:opts.length,
          title:document.getElementById('eventTitle').textContent,
          lore:document.getElementById('eventLore').textContent.length});
      }
      return {list:out, unique:Object.keys(G.eventState.usedEvents).length};
    })()`);
    console.log('6) 连续开 9 次事件房的渲染检查：');
    allEv.list.forEach(function (e) { console.log('     ' + e.title + ' → ' + e.opts + ' 个选项'); });
    const badEv = allEv.list.filter(function (e) { return e.opts !== 3; });
    if (badEv.length) { console.error('FAIL: 有事件选项数不是 3'); process.exit(1); }
    const uniqIds = {};
    allEv.list.forEach(function (e) { uniqIds[e.nm] = (uniqIds[e.nm] || 0) + 1; });
    const dup = Object.keys(uniqIds).filter(function (k) { return uniqIds[k] > 1; });
    if (dup.length) { console.error('FAIL: 同一局内事件重复出现 ' + dup.join(',')); process.exit(1); }
    console.log('   ✅ 9 次全部不重复（共 ' + allEv.unique + ' 个不同事件）· 每次 3 选项');

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
