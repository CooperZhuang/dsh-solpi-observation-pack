/**
 * 回归测试：可编辑旋钮 = 本插件 entry 配置里标了 `.volatile()` 的字段。
 *
 * dsh 0.1.7-alpha.1 起，插件设置不再是「注册命名空间 + settings.yaml」，而是插件
 * **自己的 entry 配置**：`Config` 里标了 `.volatile()` 的字段由 cordis/Loader 以
 * **活引用**（`{ get() }`）交给 `apply`，写盘后原地更新引用并补发
 * `loader/volatile-update`。本脚本钉住四条：
 *
 *   1) 宿主上完全没有 settings 服务时，`apply` 照样装得完（不再依赖服务在线）；
 *   2) 有 settings 服务时，关掉平台自动生成的表单（`configure({ auto: false })`）；
 *   3) 导出的 `Config` 就是运行时用的那份 schema，七个旋钮全是 volatile；
 *   4) 活引用与普通配置对象都读得出，且 `loader/volatile-update` 之后立刻换新值。
 *
 * 用临时 DSH_HOME 隔离日志，不碰真实日志。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'solpi-volatile-home-'))
process.env.DSH_HOME = home

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 装 cordis 的 `@deepseek-ai` 安装位（npx 缓存里的各个版本 + 全局安装）。 */
function dshRoots() {
  const roots = []
  const npx = join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx')
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) roots.push(join(npx, entry, 'node_modules', '@deepseek-ai'))
  }
  roots.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  return roots
}

/**
 * 挑一个可用安装位：需要 `cordis`，并优先 dsh 版本最新的那个
 * （新契约只存在于 >= 0.1.7-alpha.1）。
 */
function pickDshRoot() {
  const usable = dshRoots().filter((dir) => existsSync(join(dir, 'cordis/lib/index.js')))
  if (usable.length === 0) throw new Error('找不到可用的 dsh 安装位（需要 cordis）')
  const versionOf = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, 'dsh/package.json'), 'utf8')).version
    } catch {
      return '0'
    }
  }
  return usable
    .map((dir) => ({ dir, version: versionOf(dir) }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const { dir: DSH, version: dshVersion } = pickDshRoot()
console.log(`dsh 安装位：${DSH}（dsh ${dshVersion}）`)

const plugin = await import(pathToFileURL('C:/CodeRepository/dsh-solpi-observation-pack/lib/index.js').href)
const { Context } = await import(pathToFileURL(join(DSH, 'cordis/lib/index.js')).href)

const LOG = join(home, 'logs', 'dsh-solpi-observation-pack.log')

/** 插件日志里最后一条含 `marker` 的一行。 */
function logLine(marker) {
  if (!existsSync(LOG)) return undefined
  return readFileSync(LOG, 'utf8').split('\n').filter((line) => line.includes(marker)).at(-1)
}

/** 把 `active (enabled=…, dryRun=…, …, skipTools=[…])` 摘要解析成对象。 */
function summaryOf(marker) {
  const line = logLine(marker)
  const hit = line?.match(
    /\(enabled=(true|false), dryRun=(true|false), thresholdBytes=(\d+), fullSends=(\d+), excerptBytes=(\d+), emitShadowPrice=(true|false), skipTools=\[([^\]]*)\]\)/u,
  )
  if (hit === undefined) return undefined
  return {
    enabled: hit[1] === 'true',
    dryRun: hit[2] === 'true',
    thresholdBytes: Number(hit[3]),
    fullSends: Number(hit[4]),
    excerptBytes: Number(hit[5]),
    emitShadowPrice: hit[6] === 'true',
    skipTools: hit[7].split(',').filter(Boolean),
  }
}

/** volatile 引用的形状判定（与 cosmokit 的 isVolatile 同协议，跨副本可用）。 */
const isRef = (value) =>
  typeof value === 'object' && value !== null && typeof value.get === 'function' && VOLATILE_WRITE in value

/** 该 root 上本插件 fiber 那份**已解析**的 entry 配置（volatile 字段就是活引用）。 */
function pluginConfig(root) {
  const fibers = [...root.registry.values()].flatMap((runtime) => [...runtime.fibers])
  return fibers.find((fiber) => fiber.runtime?.name === plugin.name)?.config
}

// ---- 没有 settings 服务 ---------------------------------------------------------
const bare = new Context()
let bareError
try {
  await bare.plugin(plugin, { dryRun: true, thresholdBytes: 4096 })
} catch (error) {
  bareError = error
}
const settingsService = (() => {
  try {
    return bare.get('settings')
  } catch {
    return undefined
  }
})()
check('1. 宿主上确实没有 settings 服务', settingsService === undefined)
check('2. 没有 settings 服务时 apply 装得完', bareError === undefined, bareError?.message ?? '')
const bareSummary = summaryOf('info active (')
check(
  '3. 普通配置对象读出来的就是那些普通值',
  bareSummary?.enabled === true && bareSummary?.dryRun === true && bareSummary?.thresholdBytes === 4096,
  JSON.stringify(bareSummary),
)

// ---- 有 settings 服务：关掉平台自动表单 -------------------------------------------
const withSettings = new Context()
const configureCalls = []
withSettings.provide('settings', {
  configure: (presentation, owner) => {
    configureCalls.push({ presentation, owner })
    return () => {}
  },
})
await withSettings.plugin(plugin, {})
check(
  '4. 平台自动表单被关掉：configure({ auto: false }) 恰好一次',
  configureCalls.length === 1 && configureCalls[0].presentation?.auto === false,
  JSON.stringify(configureCalls.map((call) => call.presentation)),
)
check(
  '5. 归属的是本插件自己的 fiber，不是 settings 提供方',
  configureCalls[0]?.owner?.runtime?.name === plugin.name,
  String(configureCalls[0]?.owner?.runtime?.name),
)

// ---- 活引用：cordis 按导出的 Config 解析，apply 读到的就是引用 ----------------------
const root = new Context()
await root.plugin(plugin, { dryRun: true, thresholdBytes: 4096 })
const config = pluginConfig(root)
const tunables = { enabled: true, dryRun: true, thresholdBytes: 4096, fullSends: 2, excerptBytes: 1024, skipTools: [], emitShadowPrice: true }
check(
  '6. cordis 按导出的 Config 解析 entry 配置 ⇒ 七个旋钮都是 volatile 活引用',
  config !== undefined &&
    Object.keys(tunables).every((key) => isRef(config[key]) && JSON.stringify(config[key].get()) === JSON.stringify(tunables[key])),
  config === undefined ? '没找到本插件的 fiber' : Object.entries(config).map(([k, v]) => `${k}=${isRef(v) ? 'ref' : 'plain'}`).join(' '),
)
// 模拟 Loader 写盘：原地更新引用，再补发事件（真 Loader 的 _commitVolatile 做的就是这两步）
config.thresholdBytes[VOLATILE_WRITE](2048)
config.skipTools[VOLATILE_WRITE](['read'])
root.emit('loader/volatile-update', [['thresholdBytes'], ['skipTools']])
const updated = summaryOf('settings updated: (')
check(
  '7. loader/volatile-update 之后立刻换成新值（不重挂）',
  updated?.thresholdBytes === 2048 && updated?.skipTools.join(',') === 'read',
  JSON.stringify(updated),
)

// ---- 纯函数：解包先于校验 ---------------------------------------------------------
const json = plugin.Config.toJSON()
const schemaOf = (ref) => (typeof ref === 'number' ? json.refs[ref] : ref)
const fields = Object.entries(json.refs[json.uid].dict).map(([key, ref]) => [key, schemaOf(ref)])
check(
  '8. Config：七个旋钮齐全且都标了 volatile，别的字段一个都没有',
  fields.map(([key]) => key).join(',') === Object.keys(tunables).join(',') &&
    fields.every(([, schema]) => schema.meta?.volatile === true) &&
    Object.values(json.refs).filter((schema) => schema?.meta?.volatile === true).length === 7,
)
let rejection
try {
  // 谎报类型的引用：解包之后必须被严格检查拒掉（说明校验看到的是普通值，不是引用对象）
  plugin.resolveConfig({ dryRun: { get: () => 1, [VOLATILE_WRITE]() {} } })
} catch (error) {
  rejection = error.message
}
check('9. 解包先于校验：引用里的非法值照样被拒', /dryRun must be a boolean/u.test(String(rejection)), String(rejection))
const fromRefs = plugin.normalizeSettings(plugin.Config({ dryRun: true, skipTools: ['read', 'web_fetch'] }))
check(
  '10. 活引用配置（含整个数组包在引用里的 skipTools）也能收敛成普通值',
  fromRefs.dryRun === true && fromRefs.skipTools.join(',') === 'read,web_fetch',
  JSON.stringify({ dryRun: fromRefs.dryRun, skipTools: fromRefs.skipTools }),
)

const failed = results.filter((r) => !r.ok)
console.log(`\nvolatile 配置契约：${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
