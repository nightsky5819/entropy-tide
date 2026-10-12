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
