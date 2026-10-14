// 在各窗口尺寸下检查「职业选择」与「序章剧情」两页的按钮是否可见（信息量最大的两页）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
const html = fs.readFileSync(GAME_FILE, 'utf8');
const marker = '(function devHooks() {';
if (html.indexOf(marker) < 0) throw new Error('未找到 devHooks');

const SCREENS = {
  cls: `
  (function(){ setTimeout(function(){ try{
    G.mode='endless';
    showClassScreen();
  }catch(e){ document.title='ERR '+e; } }, 200); })();`,
  story: `
  (function(){ setTimeout(function(){ try{
    G.mode='campaign';
    startStory('prologue', showClassScreen);
  }catch(e){ document.title='ERR '+e; } }, 200); })();`,
  // v1.7：存档管理面板（新增最高的一个面板，最需要检查矮窗口下的可滚动性）
  save: `
  (function(){ setTimeout(function(){ try{
    localStorage.setItem('entropyTideSave', JSON.stringify({
      version:1, best:12345,
      meta:{points:7,totalEarned:21,endlessWavesCleared:9,unlocked:{A0:true},initialModule:null},
      stats:{totalKills:99,totalRuns:12,totalPlayTime:3600}
    }));
    loadGame();
    showSaveScreen('title');
    var box=document.getElementById('saveExportBox'); if(box) box.value=exportSave();
  }catch(e){ document.title='ERR '+e; } }, 200); })();`,
  // v1.8：升级面板中的「变异」卡（检查紫色标签与卡面排版）
  mutations: `
  (function(){ setTimeout(function(){ try{
    G.mode='endless';
    G.wave=6;
    if(!G.p) G.p = newPlayer();          // 标题页时还没有玩家对象
    G.p.taken=[]; G.p.takenDelta=[];
    G.options = WEAPON_MUTATIONS.filter(function(u){
      return u.id==='boomerang'||u.id==='burst'||u.id==='orbit';
    });
    uptitleEl.textContent='强化选择 · 第 7 波之前';
    renderUpgradeCards();
    showOverlay(overlayUp);
    canvas.parentNode.classList.add('stopped');
  }catch(e){ document.title='ERR '+e; } }, 300); })();`,
  // v1.7：导入覆盖二次确认弹窗
  saveConfirm: `
  (function(){ setTimeout(function(){ try{
    localStorage.setItem('entropyTideSave', JSON.stringify({
      version:1, best:777,
      meta:{points:3,totalEarned:5,endlessWavesCleared:3,unlocked:{},initialModule:null},
      stats:{totalKills:10,totalRuns:2,totalPlayTime:600}
    }));
    loadGame();
    G.best = 24680;
    showSaveScreen('title');
    var box=document.getElementById('saveImportBox'); if(box) box.value=exportSave();
    document.getElementById('btnSaveImport').click();
  }catch(e){ document.title='ERR '+e; } }, 200); })();`
};

const SIZES = [
  { w: 1280, h: 620, tag: 'short' },
  { w: 1024, h: 560, tag: 'tiny' },
  { w: 1440, h: 900, tag: 'normal' }
];

for (const name of Object.keys(SCREENS)) {
  for (const s of SIZES) {
    const file = path.join(ws, '_ui_' + name + '.html');
    fs.writeFileSync(file, html.replace(marker, SCREENS[name] + '\n  ' + marker), 'utf8');
    const png = path.join(ws, '_ui-' + name + '-' + s.tag + '.png');
    if (fs.existsSync(png)) fs.unlinkSync(png);
    execFileSync(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
      '--disable-breakpad', '--no-first-run', '--hide-scrollbars',
      '--user-data-dir=' + path.join(ws, '.chrome-fit'),
      '--window-size=' + s.w + ',' + s.h,
      '--virtual-time-budget=2500',
      '--screenshot=' + png,
      'file:///' + file.replace(/\\/g, '/')
    ], { stdio: 'ignore', timeout: 120000 });
    console.log((name + '/' + s.tag).padEnd(14) + s.w + 'x' + s.h + ' -> ' +
      (fs.existsSync(png) ? 'ok' : 'FAIL'));
    fs.unlinkSync(file);
  }
}
