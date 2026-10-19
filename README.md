# dsh-solpi-observation-pack

把**被反复回放的大工具结果**替换成一个稳定的 handle，原文归档保存、需要时按页召回。

灵感来自 NVIDIA [SoL-Pi](https://github.com/NVlabs/SoL-Pi) 的 **ObservationPack** 机制，但**不是机械移植**——SoL-Pi 依赖的 Pi 扩展契约与 DSH 不同，因此按 DSH 的**可重放表面替换**重写。

> **范围说明**：SoL-Pi 上游总共包含四个机制：`action-fusion`、`observation-pack`、`evidence-preserving-reducer`、`online-context-compact`。本仓库只对应其中的 `observation-pack`；四机制的可行性取舍见 `C:\Users\Cooper\.dsh\sol-pi-research\sol-pi-dsh-feasibility.md` 和 `最终结论报告.md`。DSH 侧另有独立的 `dsh-solpi-action-fusion` 端口；EPR 与 OCC 暂未部署，2026-09-24 的复评及验证门槛见下文，不能把旧报告的样本数当作当前结论。

---

## 四个机制与 DSH 侧状态

| SoL-Pi 扩展 | 作用 | DSH 侧状态 |
|---|---|---|
| Action Fusion | 把编辑及紧随的校验命令融合为一次工具调用 | 独立插件 `C:\CodeRepository\dsh-solpi-action-fusion`；web profile 通过 `cordis.patch.yml` 插入，工具名 `edit_and_run`。路径校验由 DSH 内置编辑工具承担，并未移植上游的 file-queue。 |
| ObservationPack | 大结果多次回放后换成可召回的 handle | **本插件**；web profile 已启用。 |
| Evidence-Preserving Reducer | 把长诊断结果转成逐字回验的摘要 | 尚未移植；先做只读影子观测，验证真实长日志机会、成本与敏感数据边界。 |
| Online Context Compact | 在计划步骤完成时择机触发压缩 | 尚未移植；完成边界值得做只读经济评估，但不直接移植上游的整套续接与压缩逻辑。 |

`dsh-context-window` 是另一条 Codex 风格的上下文管理实现，**不是** SoL-Pi Online Context Compact 的移植，当前 web profile 也未挂载它。以上状态是 DSH 的部署决策，不等于上游机制不存在。

### EPR / OCC 复评（2026-09-24）

| 机制 | 近期真实语料（只读、非 A/B） | 当前判定与下一步 |
|---|---|---|
| EPR | 最近 60 份日志约 8.9k 个工具结果：按上游严格命令正则及 ≥4 KiB 门槛为 **0**；按文件 mtime 取近 7 天 138 份日志，同口径为 **10 条、54,585 B**，扩展诊断命令口径为 **12 条、66,527 B**。窗口不同、活跃日志持续写入，不能直接相减得出增长率。 | **暂不直接移植**。先观测真实输出的完整字节数、退出状态和敏感信号，明确模型外发策略；然后再用离线固定样本及获批的小流量 A/B 测净收益。 |
| OCC | 抽取约 60 份会话、约 8.4k 条 `assistant/message`（并非精确 provider 请求数）；宽松候选中有 **25 个**“完成待办、尚有待办、之前累计 usage.totalTokens >100k、后续至少 10 条 assistant/message”的边界，分布在 14 个会话。该数只是潜在触发机会的上界；仅见约 3 个真实 `compaction/summary`，`compaction/prune` 很多是影子定价，不能混算。 | **值得先做影子经济评估，不直接移植完整机制**。记录计划边界、窗口余量、后续真实请求与 cache 读写、ObservationPack 替换/原生压缩的重叠，回算净成本；确认收益与续接安全后再考虑有条件接入现有 `compactRegion`。 |

EPR 的正确性差异先于成本：上游用 `isError` 推断测试失败；DSH `pwsh` 把非零退出放在结果文本 `[exit code: N]`，通常 `isError=false`。而且上游的 `bash`/Pi 临时日志路径与 DSH 的 `pwsh`/spill 路径不同。直接搬运会错报成功或错取被截断的原文。任何 reducer 必须先证明退出状态和完整内容提取准确，并保证逐字 quote/hash 校验不通过时原文回退；上游 secret 正则不是生产/客户日志外发的充分许可。

OCC 的 DSH 原生 `compactRegion` 可做 durable surface replace，不能再说架构禁止压缩；但上游依赖自定义、带稳定 step id 与 progress 的 `update_plan`，DSH 的 `todo_write` 只有 content/status。它还在 turn 完成后中断、等待 idle 压缩并恢复模型续接；移植时须重做事件关联、事务顺序、恢复及中断测试。当前 ObservationPack 已会替换长工具结果，必须扣除前缀 cache 重算和与已有压缩的重叠；历史文本字节数不是净 token/费用收益。

上述均为**只读日志扫描**，没有 EPR/OCC 真机端到端测试，也没有调用 reducer 模型。不得把扫描得到的候选数写成已节省的 token。旧《最终结论报告》§4.3/§4.4 的 2026-09-13 样本是历史基线，以上复评覆盖当前部署决策；影子观测、固定样本、获批 A/B 的顺序不可省略。

建议的推进门槛：

1. **离线冻结语料**：逐边界记录可用的 balanced compaction range、保留窗口、重复计算后的可替换字节、距压力阈值的请求数、历史 compaction 与 ObservationPack 重叠，以及真实 `input/cacheRead/cacheWrite/output` 用量；按实际路由价格计算净成本和零/负收益比例。
2. **生产影子**：只记录 EPR 候选、退出状态、完整日志可取得性、敏感信号和 OCC 经济决策，不调用 reducer、不改 session surface。冷启动、手工 compact、目标结束、纠正流程和 cache 不可测时一律跳过。
3. **隔离灰度**：只有净收益稳定为正后，才测试 durable `start → summary → replace → end`、取消、重启、并发 todo、摘要失败、工具配对悬空，以及与 ObservationPack 的先后顺序；续接必须证明最多启动一次，并保留原生 pressure/overflow 兜底。

OCC 不能在 `todo_write` 回调内直接压缩：DSH 的 region 需要工具配对平衡和 durable compaction 锁；应在正确的 pre-step/turn 生命周期调用现有 `compactRegion`，或在已确认 idle 且没有等待唤醒工作时调用 `compactNow`。否则即使经济判断正确，也可能造成摘要、替换或续接顺序错误。

### 检查上游更新

在本仓库运行 `node check-upstream.mjs` 会从 GitHub 更新本地 SoL-Pi 克隆的 `origin/main`，把四个扩展目录分别与研究时的基线提交 `d7ecfc0` 比较，并单独列出共享代码、依赖和测试的变动。它**不会切换本地工作树 HEAD，也不会自动修改本插件**。无法联网时用 `node check-upstream.mjs --offline` 检查上次抓取的远端引用；可通过 `SOL_PI_REPO` 指向另一份克隆。目录未变也不保证共享依赖不变，需核查脚本的 shared/integration 部分。

2026-09-24 核对：`origin/main` 为 `1559b5c`；只有 `action-fusion/file-queue.ts` 变化（Unicode 空格、Windows shell 路径处理），另外三个扩展目录与基线一致。这些路径修复不对应本仓库，也不对应 DSH Action Fusion 的实现路径（后者直接派发内置编辑工具）。

## 它解决什么问题

长会话里，一个 26 KB 的工具结果会出现在**之后每一次** provider 请求里。本次调研的会话里就有一个 `web_fetch` 结果被回放了 **114 次**——它同时消耗 context 和 KV cache，而模型早就不需要全文了。

`dsh-spill-policy` 已经在结果产生时做过一次「大结果 → 预览 + 落盘路径」。但它是**一次性**的，而且**明确跳过 `read` 工具**（`exec.name === 'read'`），所以「同一个大文件被反复读取」这条重复回放路径没有被覆盖。本插件补的就是这一段。

## 它做什么

在**每个 step 边界**（`agent/pre-step`）检查当前 surface 上的工具结果：

- 纯文本、非错误、UTF-8 字节数 > `thresholdBytes`（默认 10 KiB）
- 且已经参与过 **≥ `fullSends` 次 provider 请求**（默认 2，即前两次发全文）

满足条件的，就：

1. 用 `ctx.spillStore.saveText()` 把**逐字节原文**归档；
2. 追加一个 `compaction/prune` 影子定价事件（log-only，不进模型上下文）；
3. 追加一个带 `surfaceOp: { op: 'replace' }` 的 `tool/result` **表面替换**。

模型从此看到的是确定性 handle：

```
[large tool result replaced after its first 2 provider requests]
id: obs_da37cc5add355bae523a63a5
tool: web_fetch
original_bytes: 26373
original_lines: 209
estimated_tokens: 6590
stored_at: C:\Users\...\dsh-spill-f7SDng\session-016b4cf7e4d8\4506a9932e46-web_fetch.txt
retrieve: use the read tool with offset/limit on stored_at to page through the original
[first complete lines]
Fetched https://nvlabs.github.io/SoL-Pi/ (HTTP 200)
...
[middle omitted; last complete lines]
...
[23185 original bytes omitted]
```

26 KB → 1.4 KB（本例降幅 94.6%）。

## 为什么不能用 SoL-Pi 的做法

SoL-Pi 挂在 Pi 的 `context` 事件上，**只改投影给 provider 的消息、不动持久化历史**。

DSH 做不到，而且是刻意的：`dsh-agent-loop` 的 `buildRequest()` 对请求对象、`messages` 数组和**每条消息**做无条件 `deepFreeze`，并（在挂载 `dsh-invariants` 的 profile 下）断言 `options.messages` 逐字节等于 `session.deriveMessages()`，违反即报 *log-reconstruction desync*。

DSH 的等价语义是 **durable surface replacement**：替换本身记进 durable log，于是

- **模型**看到替换副本；
- **人类记录**由 append-origin 事件保留原文（`dsh-session/surface.ts`：*"replacement copies stay model-only"*）；
- **replay** 能逐字节还原任意历史请求看到的内容。

该契约由 `assertToolResultRewrite` 强制执行：**除内层 `content` 外逐字段必须与原文相同**，且一次只能替换一个节点。所以实现里必须写 `{ ...originalBlock, content: [...] }` 展开，不能重建 block。

## 为什么不需要 SoL-Pi 的 `obs_recall` 工具

`SpillStore` 是**只写**的（*"owns NO retrieval or search API"*），而 SoL-Pi 提供自定义分页召回工具。

在 DSH 里这是多余的：内置的 `read` 工具本来就有 `offset` / `limit`，handle 直接告诉模型归档路径和用法即可。少一个工具 = 少一份 schema 开销。

## 安装

**正式安装**（推荐，会出现在 DSH 的「插件列表」里）：把包加进 profile 的 `package.json`。

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-solpi-observation-pack": "link:C:/CodeRepository/dsh-solpi-observation-pack"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …其它插件…
        "dsh-solpi-observation-pack"   // ← 加到这里
      ]
    }
  }
}
```

然后在 profile 目录跑 `pnpm install`，再重启 `dsh web`。

> `dsh.profile.bundles` **不被 live reload 监听**，所以加 bundle 必须重启；只有 `cordis.patch.yml` 的改动才是热生效的。

包自身的依赖（`@deepseek-ai/schemastery`、`@deepseek-ai/cosmokit`）要装进**仓库自己的** `node_modules`——Node 按**真实路径**解析依赖，profile 的 `node_modules` 帮不上忙。仓库里已经有 `pnpm-lock.yaml`，所以：

```powershell
cd C:\CodeRepository\dsh-solpi-observation-pack
pnpm install
```

依赖下限（与 `package.json` 一致）：`@deepseek-ai/schemastery` **^3.18.5**（`.volatile()` 本身需要 ≥ 3.18.3）、`@deepseek-ai/cosmokit` **^1.8.6**（`isVolatile` 本身需要 ≥ 1.8.4）。低于这两个下限插件会在 import 期直接崩（`Schema.prototype.volatile is not a function`），别降版本。

内核侧 peer 区间是 `@deepseek-ai/dsh-llm` **>=0.2.1-rc.2 <0.3.0**（本插件只用到它的 `freezeMessage`）。2026-10-20 已按 **DSH 0.2.1-rc.2** 核对过全部用到的内核 API：`isVolatile` / `freezeMessage` / `z.object().volatile()`、`ctx.get('spillStore')` 的 `saveText({owner, source, suggestedName, content})`、`agent/pre-step` 的 waterfall 载荷、`settings.configure({ auto: false }, fiber)`、`loader/volatile-update`、`session.surface.nodes` / `deriveEventMessage` / `append` 的 `surfaceOp:{op:'replace'}` 与 `assertToolResultRewrite` 契约、浏览器侧 `configForms.get(entryId)` 与 `slots.register` 的 `plugins.bundle.config` 槽——形状均未变。本插件**不用子代理**，所以 0.2.1-rc.2 的 `startActivation({provider, request})` 与 Agent Preset 约定与它无关。

**另一种装法**（不经过 bundles，只往 `cordis.patch.yml` 插一行）：可以热加载、不用重启，但**不会出现在「插件列表」里**——DSH 的插件列表只列 bundles 里的包。两种装法二选一，别同时用。

## 配置

配置只有两层，优先级从低到高：

1. **schema 默认值**：`lib/index.js` 导出的 `Config`（各字段的 `.default()`）
2. **本插件这份 entry 配置**：profile 的 `cordis.patch.yml` 里这一行的 `config:`；设置界面写的就是它

日常调整请用界面：**设置 → 左侧导航「观测打包」**。改完**下一次读取即生效，不需要重启**：可编辑旋钮是 `Config` 里标了 `.volatile()` 的字段，Loader 以活引用（`{ get() }`）把它们交给 `apply`，写盘后原地更新引用并在本插件的 ctx 上补发一次 `loader/volatile-update`，插件据此重读。

> 0.1.6 及更早的 DSH 是另一套契约：`settings.register(namespace, schema)` + 浏览器侧 `ctx.settingsScope.bind({ namespace })` + `$DSH_HOME/settings.yaml` 用户层。0.1.7-alpha.1 起这两样都已删除，插件自己那份**声明了 `.volatile()` 的 `Config` 就是**表单来源。DSH 会把遗留的 `settings.yaml` 各段一次性搬进 profile 对应的 entry（原文件改名成 `settings.yaml.imported`）。

> **本仓库的约定**：插件的配置界面一律注册为**设置页左侧导航里的独立菜单**（槽 `settings.section`），不使用「插件 → 插件配置」里的卡片（槽 `settings.plugin.item`）；后者本来由平台按 `Config` 自动生成，本插件在 `apply` 里用 `settings.configure({ auto: false })` 关掉了它。配置只放这一处。

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关闭后不再打包任何工具结果，已落地的替换保持原样。 |
| `dryRun` | `false` | 影子模式。只估算「如果打包能省多少 token」，不真的改动上下文、不写归档。用于 A/B 对照与安全评估。 |
| `thresholdBytes` | `10240` | 触发阈值（字节）。工具结果的 UTF-8 字节数超过它才参与打包。与上游 SoL-Pi 一致。 |
| `fullSends` | `2` | 完整发送次数。前 N 次请求照发全文，第 N+1 次起替换为 handle。与上游一致；调大更保守。 |
| `excerptBytes` | `1024` | 摘录预算（字节）。handle 中头、尾各保留一半，且只取完整行。 |
| `skipTools` | `[]` | 跳过工具。列出的工具其结果永不打包。 |
| `emitShadowPrice` | `true` | 写入影子定价事件。为每个被替换节点记一条带 token 估价的 `compaction/prune` 事件，便于事后统计。 |

> 上游 SoL-Pi 的对应常量是 `THRESHOLD_BYTES=10240`、`FULL_SENDS=2`、`PLACEHOLDER_EXCERPT_BYTES=1024`；它还有 `RECALL_MAX_BYTES=16384` / `RECALL_MAX_LINES=400`，那是它自定义 `obs_recall` 工具的分页预算——本插件复用内置 `read` 工具，因此不需要这两个参数。`dryRun` 与 `emitShadowPrice` 是本插件为 A/B 探索新增的。

未知配置键会直接报错（沿用 SoL-Pi 的严格风格）。

### 配置界面

界面由 `lib/client.js`（浏览器半边）提供，注册进**设置页左侧导航**的 `settings.section` 槽：`{ name: 'settings.section', id: 'solpi-observation-pack', order: 16, label: '观测打包' }`，卡片通过 `ctx.configForms.get('solpi-observation-pack')` 拿到**本插件 entry 配置**的那份共享表单（`getSnapshot` / `subscribe` / `mutate`），读写的就是 `Config` 里那七个 volatile 字段。**不使用**「插件 → 插件配置」里的卡片（`settings.plugin.item`）；platform 自动生成的那张已被 `apply` 里的 `settings.configure({ auto: false })` 关掉。

DSH 的设置外壳把 `settings.section` 账本投影成导航；表单是按 **profile entry id** 提供的，所以槽的 `id`、`configForms.get()` 的 key、`lib/index.js` 的 `SETTINGS_NS`/插件名三处必须一致。

> 表单对象归 `configForms` 服务所有、按 entry 共享：消费者只用 `subscribe()` 返回的函数释放**自己的**订阅，**不要** `dispose()` 它（旧契约里 `settingsScope.bind()` 的返回值是调用方自己的，才有 dispose 这回事）。

改动已有的 `lib/client.js` 后刷新页面即可：客户端 HMR 会按文件内容更新模块 rev；只有**新增客户端模块**才需要重启宿主。改动 `lib/index.js`（Host 半边）仍需重启：live reload 会用 Node 的 ESM 缓存重新注册，**不会重新导入已改动的模块**。

**运行时自检**（不需要 boot token）：`node probe-live-client.mjs 3080` 会用 `~/.dsh/.credentials.yaml` 里的持久密钥自签 browser-session cookie，取回运行中实例的客户端模块清单，并确认线上 combo 里那份 `client.js` 与本仓库逐字节相同。

## 行为契约

- **fail-soft**：任何失败（无 spillStore、写盘失败、断言拒绝）都只记一条 `warn`，该结果**保持原文**发出，绝不打断 turn。
- **幂等**：已经是替换副本的节点不会被再次打包。
- **确定性 handle**：同样的输入产出逐字节相同的 handle，保护 prompt cache。
- **内容寻址**：`obs_<sha256(callId \0 sha256(text))[0:24]>`，同一 callId + 同一内容 ⇒ 同一 id，跨 resume 稳定。
- **原文不可丢**：归档在 `saveText` 返回前完成；替换失败时归档成为孤儿，但**绝不出现「原文被替换却没归档」**。

## 日志

`~/.dsh/logs/dsh-solpi-observation-pack.log`（沿用本仓库插件如 dsh-memories 的约定）。

```
[2026-09-12T15:21:03.725Z] info active (thresholdBytes=10240, fullSends=2, excerptBytes=1024, skipTools=[])
[2026-09-12T15:21:03.739Z] info packed obs_da37cc5add355bae523a63a5 (web_fetch, 26373B → 1423B, sends=114)
```

## 验证

**机制本体** —— `~/.dsh/sol-pi-research/e2e-observation-pack.mjs`，在**真实** cordis 上下文 + **真实** Session 上跑 15 项断言（只 stub `spillStore`）：

```
15/15 通过
A. 模型现在看到 handle，原文中段已消失 — 派生内容 19442 → 2416 字符（降幅 87.6%）
C. durable log 仍保留原文（人类记录不被抹掉）
E. 影子定价事件是 log-only
G. 幂等：重复触发不会再次打包
K. 小于阈值的工具结果不被打包
```

**设置契约（本仓库内，随代码走）** —— `node verify-volatile-config.mjs`，在真实 cordis 上跑 10 项断言（临时 `DSH_HOME` 隔离日志）：

```
10/10 通过
1. 宿主上确实没有 settings 服务
2. 没有 settings 服务时 apply 装得完            ← 不再依赖服务在线
4. 平台自动表单被关掉：configure({ auto: false }) 恰好一次
6. cordis 按导出的 Config 解析 entry 配置 ⇒ 七个旋钮都是 volatile 活引用
7. loader/volatile-update 之后立刻换成新值（不重挂）
9. 解包先于校验：引用里的非法值照样被拒
```

**浏览器半边（本仓库内，随代码走）** —— `node verify-client-contract.mjs`，把 `lib/client.js` 塞进假 `__ModuleLoader__` + 假 React 里真跑（假 ctx 故意不提供 `ctx.effect`，新实现若还想自己包 dispose effect 会直接炸）：

```
14/14 通过
2. inject 换成 configForms（不再依赖 settingsScope）
3. 按 entry id 取共享表单
4. 注册进 settings.section（id/order/label 不变）
7. 保存写回 set 操作，fence = 读到的 revision
8. 恢复默认写回 unset
```

**设置集成（旧契约，已过时）** —— `~/.dsh/sol-pi-research/e2e-settings.mjs` 面向的是 0.1.6 及更早那套「命名空间 + `settings.yaml` 三层」，其中的 `describe()`/命名空间断言在 0.1.7-alpha.1 上已不适用（该脚本在本仓库之外，本次未改）。新契约的对应覆盖就是上面的 `verify-volatile-config.mjs` / `verify-client-contract.mjs`。
