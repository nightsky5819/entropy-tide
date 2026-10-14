# 《熵潮》设计说明

本文记录实现层面的设计决策、数值体系、关键判定顺序，以及开发过程中验证发现的坑。面向想读代码或改数值的人。

---

## 1. 渲染架构

### 固定逻辑分辨率 + 单次缩放
早期版本按设备像素尺寸绘制世界再缩小（`sc ≈ 0.74`），结果是画面模糊、鼠标坐标错位、WASD 手感异常。现在的做法：

- 逻辑视口固定 `VW=1600 × VH=1000`（16:10）
- 世界先画到离屏 `world` canvas（同样的逻辑尺寸）
- `present()` 里一次性把 `world` 缩放到设备像素的 `screen` canvas

**只有一个缩放步骤**，输入坐标转换也只依赖这一个缩放比，不会再出现模糊或错位。

> 另一个坑：离屏 canvas 曾在常量声明（`var VW = ...`）**之前**创建，`var` 提升导致 `VW` 为 `undefined`，canvas 退化成 300×150。现在 canvas 创建统一放在常量块之后。

### 相机
战场 `2240 × 1560`，比视口大，所以需要相机跟随。

- 居中跟随（玩家始终居中，除非贴到战场边缘）
- 指数平滑：`k = 1 - Math.exp(-45 * dt)`
- **不做速度预判**（早期加了 `0.16` 的预判 + 平滑率 7.5，实测每帧滞后 17.75px、78.8% 的帧画面几乎冻结；调平滑率到 18 仍有 221px 偏移）
- 现在的实测：每帧滞后中位数 **0.10px**，高速移动时玩家偏离视口中心中位数 8px

相机滞后由 `dev/cam-check.js` 逐帧测量，不是靠肉眼判断。

---

## 2. 主循环

- 固定步长 `1/60`，用累加器补帧
- 空间哈希（`Grid`）做碰撞查询
- 打击感：`hitstop`（定帧）、`shake`（震屏）、`flash`（闪白）
- Bloom：提取高亮 → 模糊 → `lighter` 合成，全部在视口分辨率下进行
- 主循环整体包在 try/catch 中（`reportFrameError`），任何一帧异常都不会打断 rAF 链

> 曾经因为 `G.p` 为 `null` 时 `drawGrid` 读 `.x` 抛错，每帧都抛、循环直接死掉，但音效和粒子还在响应（它们走事件处理器）。所以**主循环必须有兜底**，且菜单态要显式处理 `G.p === null`。

---

## 3. 卡牌系统与「可回退」实现

### 卡池
23 张卡，三个类别 × 四个品质：

| 类别 | 数量 | 品质门槛（`TIER_GATE`） |
|---|---|---|
| 战斗 `atk` | 10 | 普通 0 波 / 稀有 2 波 / 史诗 4 波 / 传说 8 波 |
| 防御 `def` | 7 | 同上 |
| 发育 `eco` | 6 | 同上 |

抽卡按品质权重（`TIER_WEIGHT`：100 / 48 / 22 / 7），并保证同一轮不重复、尊重 `max` 层数与 `rep`（能否重复获取）。

### 可回退的卡牌系统
事件房的「覆写 / 重写 / 微调」需要**真正撤销**卡牌效果。直接用快照回退会出错：卡池里加法（`+25 最大生命`）和乘法（`伤害 ×1.22`）混在一起，快照回退会把之后叠加的加法一起抹掉。

实现方式是**按增量逆运算**（`applyUpgrade` / `undoUpgrade`）：

| 变化类型 | 记录 | 回退 |
|---|---|---|
| 乘法型属性（`dmg` `rate` `speed` `dashCd` `bspeed` `maxHp`） | 本次倍率 `mul[k]` | `p[k] /= mul[k]` |
| 加法型属性 | 本次差值 `add[k]` | `p[k] -= add[k]` |
| 布尔/字符串开关（`exec` `slowHit`） | 原值 `flags[k]` | 还原原值 |
| 当前生命（派生值） | 上限影响比例 `hpMul` + 固定回血 `hpAdd` | `hp /= hpMul` 再 `hp -= hpAdd`，最后夹到 `[1, maxHp]` |
| 强化机会（`pendingExtra` / `extraPicks`） | `pendingAdd` | 两者一起扣回 |

两个必须注意的点：

1. **`pendingExtra` / `extraPicks` 不能同时进通用 `add` 和 `pendingAdd`**，否则会被减两次（这个 bug 实际出现过，被 `M6c` 测试抓到）。
2. **当前生命要单独处理**：`+25 上限且回 25 血`这类卡，如果按「生命净增」推导会在多次叠加后算出负数。现在用 `hpMul`（上限影响比例）做对称逆运算，`hpAdd` 只记卡的固定回血部分。

验证：`smoke-test.js` 的 `M6b` 段把 **23 张卡逐张「应用 → 回退」**，比对 24 项数值是否精确还原；`M6c` 验证 20 张可叠加卡叠两次后回退一张只撤销一次的量。

---

## 4. 精英怪

### 关键设计：每波只掷一次骰子
最初的实现是**每次生成尝试**都掷一次概率骰。但一波内会生成几十个敌人，每次都掷意味着「至少出现一只」的概率被放大到 `1-(1-p)^n`，实测出现率高达 **85%–100%**，波次分层（20/35/50%）完全失去意义。

现在改成 `eliteRollWave()` 在每波开始时掷一次：

```
命中概率 p：
  不命中 → 本波 0 只
  命中   → 本波 1 只，再以 p 追加判定第二只（上限 2）
```

这样「本波至少出现一只」的概率**严格等于 p**，实测 18.6% / 34.8% / 51.7%（目标 20/35/50%）。

> 另一个相关 bug：上限检查曾写成 `spawnedThisWave >= ELITE_CONFIG.maxPerWave`（常量 2）而不是 `>= st.waveAllowance`（本波名额），导致名额掷到 1 时照样出 2 只。

### 词缀倾向与冲突
`ELITE_TENDENCY` 让不同类型的敌人倾向于合理的词缀（远程敌人不会拿到「荆棘」这种近战词缀），`ELITE_CONFLICTS` 定义 4 组互斥（如「迅捷 + 硬化」）。同波两只精英不重复、不冲突。

### 相位态
相位精英每 3 秒进入 1 秒相位态：`e.invuln = true`，`damageEnemy` 直接返回。**相位期间仍然缓慢漂移**（而不是完全静止），否则容易卡在角落。

---

## 5. 波次词缀

12 个词缀、4 组冲突。抽取规则：第 3 波之前无词缀、首领波无词缀、第 4 波起必有 1 个、第 8 波起 40% 概率出现第二个。冲突词缀不会同时出现。

词缀效果通过 `applyAffixToEnemy()` 在 `spawnEnemy()` 末尾施加属性修正；环境类词缀（熵蚀场地、碎片雨、收缩）在 `G.affixState` 里维护每帧状态。

「收缩」会把可用边界向内收 15%，通过 `getFieldBounds()` 统一提供，玩家、敌人、弹幕都从同一个函数取边界，并在 `drawGrid` 里画出洋红光墙可视化。

---

## 6. 事件房

触发时机由 `shouldOpenEventRoom()` 决定：

- 每 5 波一次
- 若那一波是首领波 → 不触发，置 `pendingAfterBoss`，**顺延到下一波**
- 同一个事件在一局内不重复；事件池抽空则直接进入升级

流程上事件房出现在升级选择**之前**：清空第 5 波 → 事件房 → 升级选卡 → 第 6 波。

> 这里踩过一个坑：`shouldOpenEventRoom` 一度被**定义了两次**（一次在插入位置、一次在原来位置），后者覆盖前者，顺延逻辑静默失效。现在回归测试里有一段「关键函数定义次数」自检。

事件效果会写入玩家字段，由各系统消费：

| 字段 | 来源事件 | 消费点 |
|---|---|---|
| `trueDamage` | 熵蚀试验 | `damageEnemy`（绕过护盾） |
| `erosionDrain` | 熵蚀试验 | 每帧自损 |
| `nextWaveEnemyMul` | 熵潮裂隙 | `startWave` 的出怪预算，消费后复位 |
| `nextWaveScoreMul` | 静默协议 / 熵潮裂隙 | `killEnemy` 计分 |
| `nextWaveRateMul` | 静默协议 | 开火间隔 |
| `nextWaveDropBonus` | 熵潮裂隙 | 掉落判定 |
| `scoreMul` | 极限压缩 | `killEnemy` 计分（本局永久） |

---

## 7. 提示系统（分道）

早期所有提示都画在同一个 y 位置，结果「波次提示」「首领降临」「写入算力点数」会叠在一起，两边都看不清。现在按类别分到 5 条纵向轨道：

| 轨道 | 内容 | 基准 y |
|---|---|---|
| `minor` | 跳过剧情等临时提示 | 112 |
| `center` | 波次 / 首领降临 / 词缀名 | 172 |
| `lore` | 词缀世界观文案（带底板） | 322 |
| `sub` | 词缀副词缀 / 精英降临 | 470 |
| `reward` | 算力点数 / 护盾 / 额外强化 | 580 |

同轨道多条会向下堆叠（`POPUP_STACK = 58`）。另外做了**波次提示去重**：0.6 秒内只保留一条（开局瞬间会连起两次波，否则会堆出两条「第 N 波」）。

---

## 8. 平衡数值参考

用 `dev/balance-probe.js`（带接近-索敌-开火的机器人）实测：

| 目标 | 实测（有噪声，±3× 波动） |
|---|---|
| 普通波清空 | 约 13–87 秒 |
| 首领 · 熵核 | 约 23 秒 |
| 首领 · 熵壁（含破盾） | 约 37 秒（其中护盾阶段约 7.5 秒） |
| 首领 · 熵刃 | 约 15 秒 |

首领血量走指数曲线（`hpBase * hpExp^(wave-1)`，`hpExp = 1.22`），用来匹配玩家靠升级叠加产生的指数级 DPS 成长。线性血量会让第 15 波首领 10 秒暴毙。

---

## 9. 存档系统与版本迁移（v1.7）

### 为什么合并成一个 key
v1.6 及以前，最高分与天赋树是两个独立的 localStorage key（`neonArenaBest` / `entropyTideMeta`），会出现「最高分写进去了、天赋点没写」这类不一致。v1.7 起统一成一个对象：

```js
localStorage['entropyTideSave'] = {
  version: 1,                 // 存档格式版本（与游戏版本号解耦，当前游戏 v1.7 / 存档 v1）
  best: 0,                    // 历史最高分
  meta: { points, totalEarned, endlessWavesCleared, unlocked, initialModule },
  stats: { totalKills, totalRuns, totalPlayTime }
}
```

`meta` 与代码里的 `META` 是**同一个对象**（保存时直接序列化它，读档时就地改写其字段），因此全代码上百处 `META.xxx` 引用一行都不用改。统计量的**真值口径是 `SAVE.stats`**；`G` 侧只有本局的增量 `G.kills` 与 `G.runTime`，不再另存一份总数。

### 兼容旧档（玩家零感知）
首次加载若没有新 key、但存在旧的 `neonArenaBest` / `entropyTideMeta`：把两者合并成 v1 结构 → 写入新 key → 删除旧 key。

### 迁移链
```js
var MIGRATIONS = { n: function (data) { /* v(n-1) -> v(n) */ data.version = n; return data; } };

function migrateSave(data) {
  if (typeof data.version !== 'number') data.version = 1;   // 没有版本号 = 最早的 v1
  if (data.version > SAVE_VERSION) return null;             // 拒绝用更新的存档覆盖旧游戏
  while (data.version < SAVE_VERSION) {
    var next = data.version + 1;
    var fn = MIGRATIONS[next];
    if (typeof fn !== 'function') return null;              // 缺迁移函数：不猜、不硬升
    try { data = fn(data); } catch (e) { return null; }     // 迁移失败宁可视为无档也不崩游戏
    if (data.version !== next) data.version = next;         // 迁移函数漏写版本号时兜底，防死循环
  }
  return data;
}
```

四条保护：**版本过高拒绝 / 缺函数拒绝 / 抛错拒绝 / 漏写版本号兜底**。迁移或解析失败时**不清理本地原档**（下次启动仍会重试），而不是把玩家数据销毁。

### 导入导出
- **导出**：`{version, best, meta, stats, exportedAt}` → JSON → **自实现的 Base64**（不用 `btoa`，避开 Latin1 编码坑；输出标准字母表 + padding，外部工具可用标准 `atob` 解回）。
- **导入**：解码 → `JSON.parse` → `migrateSave()` → `normalizeSave()` 补齐字段 → 覆盖写入 → 立即按当前格式回存；失败返回 `{ok:false, reason}`，**不抛错、不写坏档**。
- 粘贴容错：自动去掉换行与空格，兼容 URL-safe 字母表（`-` `_`）；`version` 非数字按 v1 处理。

### 统计口径（避免重复计数）
本局开始时的 `runBase = { kills, time }` 是快照；每次保存按 `runBase + G.kills / G.runTime` 折算，所以频繁保存不会把同一批击杀叠加两次。落盘时机：开局、清波、结算、阵亡、放弃本局、页面隐藏/关闭，以及刷新最高分时的 1.5 秒节流保存（原来是每杀一只怪就写一次 localStorage）。

### UI 与二次确认
- 入口：标题页与暂停页都有「存档管理」。
- 面板：存档概要（最高分 / 算力点数 / 历史累计 / 总击杀 / 总局数 / 总时长 / 格式版本）+ 导出框（生成 / 复制 / 下载 `.txt`）+ 导入框（粘贴导入 / 从文件导入）+ 重置。
- 二次确认（通用弹窗 `overlayConfirm`）：**导入覆盖**（本地已有存档时）与**重置存档**。确认文案展示的是**已落盘**的数值（`localSaveSummary()`），而不是内存里可能尚未保存的当前局最高分。
- 局中导入/重置成功后强制回标题页，避免局内状态与存档不一致。
- 复制：`navigator.clipboard.writeText()` 是**异步**的 —— 必须处理它返回的 Promise 被拒绝的情况，否则会「提示已复制、剪贴板其实空的」。完整回退链：Clipboard API → `execCommand('copy')`（选中可见的导出框）→ 离屏临时 textarea，**全部失败时如实提示失败**，绝不谎报成功。导出框一点即自动全选，即使脚本被禁止写剪贴板，玩家也能一键 Ctrl+C。

---

## 10. 武器 / 攻击方式变异（v1.8）

### 设计目标
改变「**怎么打**」而不是「打多少」：14 张卡全部 ≤ 史诗品质，避免挤压传说卡与普通强化池；加成型数值（伤害 / 射速）仍由原有卡片负责。变异卡与普通卡同池三选一，`cat = 'weapon'`，卡面类别标签显示紫色「变异」。

### 卡表
完整表格见 README 的「武器变异」小节。实现上分三类：
- **弹道行为**（回旋 / 分裂 / 弹射 / 滞留 / 链式 / 穿透+）：改子弹的飞行与穿透
- **命中反馈**（爆裂 / 索敌 / 冲击 / 腐蚀 / 吸血）：改命中瞬间的结算
- **机制重构**（双管 / 环绕 / 延迟）：改开火节奏与伤害结构

### 子弹管线对接点
所有弹道与命中效果都集中在 `updateBullets()` 一个循环里。子弹对象新增字段 `baseDmg`（穿透加成基准）、`maxLife`（回旋的行程判定）、`bounces`（弹射剩余次数）、`splitChild`（小弹标记），以及 `returning` / `lingering` / `chainFired` / `pierceStack` / `_uid` 等运行时状态位。

| 变异 | 实现要点 |
|---|---|
| 回旋弹 | `life <= maxLife * 0.5` 视为到达最大距离：速度反向、伤害 ×0.7、**清空 `hit`** 以允许对同一敌人二次命中 |
| 分裂弹 | 命中后生成 3 颗小弹（伤害 40%、`life 0.9`）；小弹带 `splitChild`，**不再二次分裂**（规格未限制，但不加会指数增长） |
| 弹射 | `bounces > 0` 时把越界坐标夹回边界并反射速度，每次伤害 ×0.85；用尽后走原销毁逻辑 |
| 滞留 | `life <= 0` 不销毁而转入 `lingering`：静止 1 秒，每 0.25 秒对 60px 内敌人造成 7.5% 伤害 |
| 链式 | 命中后找 220px 内最近的**另一个**敌人造成 50% 伤害；电弧写入 `G.marks`（v1.7 前是死字段），由 `render()` 画成抖动折线 |
| 穿透+ | 每穿透 `pierceStack++`，`dmg = baseDmg * (1 + min(0.25, stack * 0.05 * 层数))` —— 天然实现「不衰减 + 每穿 +5% + 上限 25%」 |
| 爆裂弹 | 命中时调用既有 `explode()`（半径 70 + 10/层、伤害 60%、带距离衰减） |
| 索敌弹 | 与既有 `homing` 同构，但用固定 30 度/秒 × 层数，不用 `p.homing` 的追击系数 |
| 冲击弹 | 命中时给 `en.knock` 叠加冲量并置 `en.slow = 0.5`；**首领分支跳过** |
| 腐蚀弹 | 命中叠加 `en.corrode` 层数与 `corrodeT = 3`；`updateEnemies()` 每 0.5 秒结算一次 |
| 吸血弹 | 用子弹的 `_uid` 在敌人身上记账（`en._vampHit[uid]`），同一子弹对同一敌人只回血一次 |
| 双管齐发 | `fire()` 把整组齐射循环 `1 + 层数` 次，每发伤害 ×0.65^层数（1 层净 1.30、2 层净 1.27 倍） |
| 弹幕环绕 | `step()` 每 `2 / 层数` 秒重生一批：先清掉上一批，再生成 `4 × 层数` 颗 `pierce = 999` 子弹并逐帧贴合玩家（半径 58） |
| 延迟引爆 | 命中分支提前 `return`：不调用 `damageEnemy`，只累积 `en.delayMark += dmg * 1.2`、置 `delayT = 1`；1 秒后由 `updateEnemies()` 一次性结算并爆炸 |

### 冲突与上限（规格 6.1 / 6.3）
```js
WEAPON_CONFLICTS = [['boomerang','bounce'], ['linger','chain'], ['delay','corrode'],
                    ['homing_light','homing'], ['twin','proj']];
WEAPON_EXCLUSIVE = [{ ids:['boomerang','bounce','linger'], max:2 },   // 弹道类最多 2
                    { ids:['twin','orbit','delay'],        max:1 }];  // 机制重构类最多 1
```
- 过滤函数 `upgradeBlocked(p, u)` 必须在 `drawUpgradeOptions()` 的**两处**候选池（常规池 + A1 天赋保底池）都生效，否则保底逻辑会绕过冲突规则（v1.7 的 A1 保底就改过同一个坑）。
- 成对冲突做**双向**处理：规格只写「抽到变异卡时检查」，但 `homing` / `proj` 是普通卡，单向检查会留下「先拿索敌弹、之后又刷出制导芯片」的漏洞。
- 冲突与上限只影响**抽取**，不影响已获得的卡；事件房的「随机获取」走同一套过滤。

### 与「可回退卡牌系统」的关系
变异字段都是普通 `p.*` 数值 / 布尔字段，`applyUpgrade()` 的增量记录会自动覆盖：数值记加法增量、布尔记 flags 原值。`dev/smoke-test.js` 的 M6b / M6c 白名单已纳入这些字段（9 个数值 + 5 个布尔），因此事件房的「覆写 / 重写」能精确回退变异卡。

### 两处口径（规格留白）
1. **腐蚀伤害基数**：规格写「每秒 20% 伤害」，示例代码却是 `en.corrode * 0.1`（层数 × 0.1 的固定值，后期可忽略）。改为 **玩家当前子弹伤害的 10% × 层数 / 0.5 秒**（每秒 20% × 层数）。
2. **分裂弹小弹**不再继续分裂（见上表）。

### 性能与边界
- 环绕子弹重生前先清空上一批，稳态数量恒为 `4 × 层数`；滞留子弹到期销毁；分裂小弹限制一代。
- 链式电弧存活 0.2 秒并在 `step()` 统一衰减，不堆积。
- 新增字段都是标量，空间哈希与碰撞路径未变；`smoke-test` 的粒子/子弹无界增长断言仍然通过。

---

## 11. 无尽模式「层」系统（v1.9）

### 结构
100 波 = **2 个循环 × 5 个层**，每层 10 波。`LAYERS` 表定义 `{ id, nm, range, theme, lore, affixes, enemies, [bossEvery/eliteChance/storyEvery/isFinal] }`：

| 层 | 波次 | 主题 | 敌人构成 | 专属词缀 |
|---|---|---|---|---|
| 缓存区 cache | 1-10 | blue | chaser/darter/shooter | 无 |
| 情绪池 emotion | 11-20 | purple | +tank/splitter | anxiety/anger/numbness/resonance |
| 记忆库 memory | 21-30 | gold | +orb（`eliteChance: 0.15`） | fragment/backtrack/residue/archive |
| 核心协议 core | 31-40 | red | 全部（`bossEvery: 4`、`storyEvery: 5`） | interfere/throttle/echo_dmg |
| 自毁倒计时 selfdestruct | 41-50 | white | 全部（`eliteChance: 1.0`、`isFinal`） | disintegrate/countdown/collapse/finality |

`getLayerForWave(wave)` 返回 `{layer, index, cycle, waveInCycle}`：第 51-100 波为循环 2，`waveInCycle = wave - 50`，因此第二循环自动复用同一套层定义。

### 层切换与过渡（不新增 G.state）
`startWave()` 开头先判定层，若与 `layerState.currentLayer` 不同则：更新层索引与循环、重置 `collapseAmount`（自毁层置 0.20）、`transitionT = 1.5`、`buildBackgroundForLayer(theme)`；循环 2 的开场额外回满血并给 2 秒无敌。

过渡动画画在**视口层**（`drawLayerTransition()`，在 `render()` 末尾）：0-0.4s 渐暗 → 0.4-1.1s 层名 + 世界观 + 波次范围 → 1.1-1.5s 渐亮。**规格建议新增 `G.state='layerTransition'`，这里没有采用**：改为在帧循环里判断 `layerState.transitionT > 0` 就跳过 `step()`、只推进 `G.time` 与相机。好处是完全不碰既有状态机（`pause/dead/over/event/upgrade` 的转换断言保持有效），代价是过渡期间 `G.state` 仍是 `playing`（做 UI 判断时要注意）。第 1 波不播过渡：否则点「开始战斗」后会先冻结 1.5 秒，像没反应。

### 背景系统
- **静态底图**：`buildBackgroundForLayer(theme)` 重建 2240×1560 的 `bgCanvas` —— 主题径向渐变 + 2 处柔光团 + 确定性伪随机颗粒（金色层额外用"碎片"形状）。5 套配色存于 `LAYER_BG`（含网格线、边框、四角装饰与柔光颜色）。
- **动态层**：`drawLayerEffects()` 接在 `drawGrid()` 末尾（世界坐标）：蓝=极缓慢数据流细线、紫=3 层扩散波纹 + 2 处涡流、金=46 片飘落碎片、红=双心跳脉冲环 + 四周告警带、白=间歇白闪 + 滚动扫描线。只用一个 `wctx.save/restore`，无每帧分配。
- **网格与边框跟随主题**（`LAYER_BG[theme]`），层与层之间一眼可辨；回到标题页时 `showTitle()` 会把背景复位为蓝色。

### 层词缀与全局词缀共存
`rollWaveAffixes()` 重写为三步：① 无尽模式下 **60%** 概率从**当前层**的 `affixes` 池抽 1 个层词缀；② 必抽 1 个全局波次词缀（排除已抽层词缀及其冲突项）；③ 第 8 波起 40% 概率第二个全局词缀。首领波与第 3 波之前仍然清空。因此**每波最多 1 个层词缀 + 1 个全局词缀 + 1 个附加全局词缀**。

`getAffix()` 同时搜索 `AFFIXES` 与 `LAYER_AFFIXES`，所以词缀常驻条（`drawAffixBar`）与波次开幕词（`showAffixIntro`）自动兼容层词缀；层词缀的 `lore` 是规格缺失、这里补齐的（开幕词要用）。

### 15 个层词缀的对接点
| 词缀 | 生效位置 |
|---|---|
| 焦虑 / 愤怒 / 麻木 / 终末 | `applyAffixToEnemy()`（生成时改 spd/dmg/hp/fireRate）、`killEnemy()`（麻木分数 ×0.6） |
| 共鸣 | `killEnemy()` 计数，每 10 杀给随机存活敌人 30% 最大生命护盾 |
| 碎片化 | `killEnemy()` 直接 +50 分（本版不做记忆碎片拾取物，规格亦如此建议） |
| 回溯 | `damageEnemy()` 开头：记录上次位置/血量，15% 概率回退并抵消本次伤害（首领免疫） |
| 残留 | `killEnemy()` 推入 `affixState.residueZones`；`step()` 里结算（半径 60、3 秒、每秒 2% 最大生命） |
| 档案 | `eliteRollWave()` 名额 +1、`trySpawnElite()` 上限 +1 |
| 干扰 | `doDash()`：`dashCd = dashCdMax × 1.40` |
| 限流 | `fire()`：子弹初速 ×0.75 |
| 回响 | `damageEnemy()`：`damagePlayer(amount × 0.10)`（走正常受击流程，护盾/无敌帧照常生效） |
| 崩解 | `killEnemy()`：`explode(80, dmg×0.6)` 并波及玩家 |
| 倒计时 | `startWave()` 置 60 秒；`step()` 超时后全员 `spd ×1.5`（不硬性失败） |
| 崩溃 | `rollWaveAffixes()` 递增 `layerState.collapseAmount`；`getFieldBounds()` 与「收缩」取 max |

### 第二循环与终局
`CYCLE_BONUS[2] = { hp:1.8, dmg:1.4, spd:1.15, eliteChance:0.20, scoreMul:1.5 }`：血量/伤害/移速在 `spawnEnemy()` 末尾叠加，精英率在 `eliteRollWave()` 叠加，分数在 `killEnemy()` 叠加。第 100 波清空后 `updateWaves()` 调用 `endlessComplete()` → 复用胜利结算（`showResult(true)`，无尽模式显示「通 关」）。

**`bossEveryForWave(wave)` 必须被三处共用**：`startWave()` 判首领、`rollWaveAffixes()` 首领波清空、`eliteRollWave()` 首领波不刷。核心协议层改成每 4 波后，若漏改任何一处就会出现「第 34 波既出首领又刷精英」或「首领波却带词缀」。

### 与规格的三处偏差（都有明确理由）
1. **崩溃进场 20%、上限 30%**（规格：每波 5%、最多 20%）。几何原因：视口 1600×1000 只覆盖 2240×1560 战场的中央，墙面内缩必须超过约 18%（≈280px）才会进入画面——按规格的 5%→20% 递增，墙面几乎永远在视野之外，玩家看不到"墙"。
2. **层 3 精英率 +15%**：规格正文写「记忆库精英怪出现概率提升」，但 `LAYERS` 数据里只有层 5 的 `eliteChance`；按正文补上 `eliteChance: 0.15`。
3. **第 1 波不播过渡**、**不新增 `G.state`**（见上）。

---

## 12. 验证工具

`dev/` 下的脚本不需要任何第三方依赖：

- **`smoke-test.js`**：桩化 DOM 与 Canvas（`vm` 模块），模拟真实帧推进，100+ 项断言、42000+ 帧。覆盖 UI 流程、状态机、位移积分、相机精度、卡池门槛、首领机制、天赋树、词缀、精英怪、事件房、卡牌回退，v1.7 存档系统（N1–N11），v1.8 的 14 张武器变异（R1–R16），以及 v1.9 的层系统（S1–S12）。
- **CDP 脚本**（`r6`–`r12` 等）：用 Chrome DevTools Protocol 在**真实浏览器**里操作，包括模拟鼠标 hover、读取计算字号、逐帧测量出现率、像素级比对背景、跨页面刷新验证持久化。比 Playwright 更可靠（headless 的 virtual-time 与命名管道限制会干扰截图和 rAF）。
- **`r12-check.js`**（v1.9）：层系统真机验收（层判定 / 5 套背景的像素级切换证据 / 动态层动画 / 过渡冻结 / 层词缀实战 / 100 波通关）。
- **`r11-check.js`**（v1.8）：武器变异真机验收（卡表 / 冲突过滤 / 卡面「变异」标签 / 14 张逐张实战 / 回退兼容 / 不影响存档）。
- **`r10-check.js`**（v1.7）：存档系统真机验收，19 项独立检查。
- **`layer-shots.js`**（v1.9）：为 5 个层各截一张真实战斗画面，供人工审查背景（CDP 驱动，避免 `--virtual-time-budget` 在首帧前截图的抖动）。
- **`ui-check.js`**：在 3 种窗口尺寸下为职业页 / 剧情页 / 存档管理页 / 变异卡面 / 导入确认弹窗出图，检查矮窗口下内容不被裁切。
- **`http-check.js`**：验证 `http://` 加载方式下运行正常（需先 `node serve.js`）。

Chrome flags 用这组比较稳：
```
--headless=new --no-sandbox --disable-gpu --disable-crash-reporter
--disable-breakpad --no-first-run --hide-scrollbars --user-data-dir=<临时目录>
```

---

## 13. 开发过程中修掉的问题（摘要）

| 问题 | 根因 | 修复 |
|---|---|---|
| 画面模糊 + WASD 手感异常 | 世界按设备像素绘制后再缩放 | 固定逻辑分辨率 + 单次缩放 |
| 菜单态每帧抛错、循环死掉 | `G.p` 为 null 时读 `.x` | 空值保护 + 主循环 try/catch |
| 玩家无法移动 | 位置积分语句被误删 | 恢复并加源码级断言（`D3` 段） |
| Canvas 变成 300×150 | 离屏 canvas 在常量声明前创建 | 创建移到常量块之后 |
| 冲刺距离等于走路 | 冲刺冲量被常速上限截断 | `dashT` 窗口内放宽上限到 2.4× |
| 相机橡皮筋 + 晕动感 | 速度预判 + 低平滑率 | 改居中跟随、去掉预判、平滑率 45 |
| 模式选择泄漏 | `G.mode` 跨局残留 | `showTitle()` 里复位 |
| 天赋树 hover 抖动 | 说明文字用 `display:block` 撑大网格 | 改绝对定位浮层，hover 零位移 |
| 提示互相压盖 | 所有提示同一 y 坐标 | 五条分道轨道 + 波次去重 |
| 界面文字过小过暗 | 无统一排版尺度 | CSS 变量 + 可读性下限 |
| 精英出现率 85–100% | 每次生成都掷骰 | 改为每波只掷一次 |
| 精英超出名额 | 上限用了常量而非本波名额 | 改用 `waveAllowance` |
| 卡牌剥离但数值不撤 | 只删记录 | 增量逆运算（见第 3 节） |
| `greed` 回退扣两次 | 字段同时进 `add` 和 `pendingAdd` | 这两项只由 `pendingAdd` 处理 |
| 事件房顺延失效 | 函数被定义两次，后者覆盖 | 删除重复定义 + 定义次数自检 |
| 「复制」提示成功但剪贴板为空 | `clipboard.writeText()` 的 Promise 被拒绝时未处理，直接返回成功 | 改为异步等待 + 拒绝后回退 `execCommand` / 离屏 textarea，失败如实提示；导出框点击自动全选 |
| 点「从文件导入」后整页卡死（自动化里） | 原生文件选择框是模态的，会阻塞渲染进程 | CDP 侧 `Page.setInterceptFileChooserDialog` 拦截（`dev/r10-check.js`） |
| 变异卡在无头测试里「打不中」 | 直接调 `updateBullets()` 时空间哈希 `G.grid` 为空（只有 `step()` 会填充） | 测试脚手架自行重建网格（非产品缺陷，见 `smoke-test.js` 的 R 段） |
| 核心协议层「第 32 波没有词缀」 | 层 4 的首领间隔是 4 波，而旧断言/旧代码按 5 波判断 | 抽出 `bossEveryForWave()`，`startWave`/`rollWaveAffixes`/`eliteRollWave` 三处统一（见第 11 节） |
| 自毁层看不到「崩溃」的墙 | 20% 以内缩量都落在相机视野之外（视口 1600×1000 vs 战场 2240×1560） | 进场即 20%、上限放开到 30%，墙面立刻进画面 |
| 背景出图偶发黑屏 | `--virtual-time-budget` 有时在首帧渲染前就截图 | `layer-shots.js` 改用 CDP：注入局面 → 真实等待 1.2s → `Page.captureScreenshot` |
