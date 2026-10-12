// 适配性验证：在多种窗口尺寸下截图，确认画面完整、开始按钮可见
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
const URL = 'file:///' + GAME_FILE.replace(/\\/g, '/');

// 覆盖常见与极端场景：矮窗口（嵌入式/侧边栏）、常规、超宽、窄高、极小
const SIZES = [
  { w: 1280, h: 620, tag: 'short' },     // 矮窗口：最容易被裁切的情形
  { w: 1024, h: 560, tag: 'tiny' },      // 很小的窗口
  { w: 800, h: 450, tag: 'micro' },      // 极小窗口（下限）
  { w: 1440, h: 900, tag: 'normal' },
  { w: 1920, h: 1080, tag: 'wide' },
  { w: 2560, h: 900, tag: 'ultrawide' }, // 超宽但不高
  { w: 760, h: 1000, tag: 'narrow' },    // 窄而高（侧边栏全屏）
  { w: 500, h: 900, tag: 'phone' }       // 手机竖屏
];

for (const s of SIZES) {
  const png = path.join(ws, '_fit-' + s.tag + '.png');
  if (fs.existsSync(png)) fs.unlinkSync(png);
  execFileSync(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--disable-breakpad', '--no-first-run', '--hide-scrollbars',
    '--user-data-dir=' + path.join(ws, '.chrome-fit'),
    '--window-size=' + s.w + ',' + s.h,
    '--virtual-time-budget=2000',
    '--screenshot=' + png,
    URL
  ], { stdio: 'ignore', timeout: 120000 });
  console.log(s.tag.padEnd(7) + s.w + 'x' + s.h + ' -> ' + (fs.existsSync(png) ? 'ok' : 'FAIL'));
}
