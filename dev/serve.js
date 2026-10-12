// 《熵潮》本地静态服务器：零依赖，只服务当前工作区
const http = require('http');
const fs = require('fs');
const path = require('path');
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

// 服务仓库根目录（index.html 与 docs/ 都从这里可达），而不是 dev/ 本身
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 8080);
const HOST = process.argv[3] || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400).end('bad request');
    return;
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // 防目录穿越：解析后必须仍在 ROOT 内
  const target = path.resolve(ROOT, '.' + urlPath);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found\n\n可用页面：/index.html');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store'          // 便于随时刷新看到最新版本
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('《熵潮》服务器已启动');
  console.log('  本机:  http://127.0.0.1:' + PORT + '/index.html');
  console.log('  根路径: http://127.0.0.1:' + PORT + '/');
  console.log('  服务目录: ' + ROOT);
});
server.on('error', e => {
  console.error('启动失败: ' + e.message);
  process.exit(1);
});
