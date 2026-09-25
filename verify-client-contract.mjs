/**
 * 回归测试：浏览器半边在**新设置契约**下能不能装起来、能不能改。
 *
 * 0.1.7-alpha.1 删掉了客户端服务 `settingsScope`：仍声明 `inject: ['slots','settingsScope']`
 * 的那一份永远不激活，整个 web 启动会被判失败（`web boot: N entries did not activate`）。
 * 现在配置表单来自 `ctx.configForms.get(entryId)`——按 profile entry id 提供的**共享**表单，
 * 消费者不持有它、也不该 dispose（旧的 `settingsScope.bind()` 才是调用方自己的）。
 *
 * 本脚本把 `lib/client.js` 塞进**假的** `window.__ModuleLoader__` + **假的** React 里真跑一遍：
 *
 *   1) 模块注册成功，`inject` 里是 `configForms` 而不是已删除的 `settingsScope`；
 *   2) 按 entry id 取共享表单，并注册进插件页的 `plugins.bundle.config`（2026-09-25 起）
 *      与设置页的 `settings.section`（id/order/label 不变）；
 *   3) 七个字段都渲染得出来（`React.useSyncExternalStore` 那条读路径没坏）；
 *   4) 改一个旋钮 → 保存 ⇒ 发 `{ op:'set', path, value }`；恢复默认 → 保存 ⇒ 发 `{ op:'unset', path }`，
 *      两者都带上读到的 `revision` 作为 fence。
 *
 * 假 ctx 故意**不提供** `ctx.effect`：新实现若还想包一层自己的 dispose effect，这里会直接炸。
 */
import { readFileSync } from 'node:fs'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ---- 假 React：够这个卡片用的最小实现（useState 有真实状态，可重渲染） ----
let cells = []
let cursor = 0
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useState: (init) => {
    const index = cursor
    cursor += 1
    if (!(index in cells)) cells[index] = typeof init === 'function' ? init() : init
    return [
      cells[index],
      (next) => {
        cells[index] = typeof next === 'function' ? next(cells[index]) : next
      },
    ]
  },
}

// ---- 假模块加载器 + 假浏览器 ctx（没有 effect，没有 dispose） ----
let loaded
const form = {
  snapshot: {
    status: 'ready',
    value: { enabled: true, dryRun: true, thresholdBytes: 10240, fullSends: 2, excerptBytes: 1024, skipTools: [], emitShadowPrice: true },
    base: {},
    user: { dryRun: true },
    revision: 3,
    writable: true,
    mode: 'host',
  },
  mutations: [],
  getSnapshot() {
    return this.snapshot
  },
  subscribe() {
    return () => {}
  },
  async mutate(ops, fence) {
    this.mutations.push({ ops, fence })
    return true
  },
}
const registered = []
const ctx = {
  configForms: {
    get: (entryId) => {
      ctx.requestedId = entryId
      return form
    },
  },
  slots: {
    inject: (name, callback) => (callback === undefined ? name : callback()),
    register: (spec, component) => registered.push({ spec, component }),
  },
}
globalThis.window = { __ModuleLoader__: { load: (entry) => (loaded = entry) } }

// 真跑 lib/client.js（它会调用 window.__ModuleLoader__.load）
const source = readFileSync('C:/CodeRepository/dsh-solpi-observation-pack/lib/client.js', 'utf8')
new Function('window', source)(globalThis.window)
check('1. 模块加载成功并调用了 __ModuleLoader__.load', loaded?.id === 'dsh-solpi-observation-pack', String(loaded?.id))

const runtime = loaded.factory((id) => {
  if (id !== 'react') throw new Error(`unexpected require: ${id}`)
  return React
})
check('2. inject 换成 configForms（不再依赖 settingsScope）', JSON.stringify(runtime.inject) === '["slots","configForms"]', JSON.stringify(runtime.inject))

runtime.apply(ctx)
check('3. 按 entry id 取共享表单', ctx.requestedId === 'solpi-observation-pack', String(ctx.requestedId))
check(
  '4. 只注册插件页那一处（plugins.bundle.config, key=包名）；设置页菜单已摘',
  registered.length === 1 &&
    registered[0].spec.name === 'plugins.bundle.config' &&
    registered[0].spec.key === 'dsh-solpi-observation-pack' &&
    !registered.some((entry) => entry.spec.name === 'settings.section'),
  JSON.stringify(registered.map((entry) => entry.spec)),
)
check('5. 卡片是函数组件', typeof registered[0].component === 'function')

const render = () => {
  cursor = 0
  return registered[0].component()
}
const walk = (node, fn) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, fn))
  if (node === null || typeof node !== 'object') return
  fn(node)
  walk(node.children, fn)
}
const findButton = (tree, text) => {
  let hit
  walk(tree, (node) => {
    if (hit === undefined && node.type === 'button' && JSON.stringify(node.children).includes(text)) hit = node
  })
  return hit
}
const findCheckbox = (tree) => {
  let hit
  walk(tree, (node) => {
    if (hit === undefined && node.type === 'input' && node.props.type === 'checkbox') hit = node
  })
  return hit
}

let tree = render()
for (const label of ['启用插件', '影子模式（只统计，不替换）', '触发阈值（字节）', '完整发送次数', '摘录预算（字节）', '跳过工具', '写入影子定价事件']) {
  check(`6. 渲染出「${label}」`, JSON.stringify(tree).includes(label))
}

// 改一个旋钮 → 保存 → 落到 mutate（fence 用读到的 revision）
findCheckbox(tree).props.onChange({ target: { checked: false } })
tree = render()
await findButton(tree, '保存').props.onClick()
check(
  '7. 保存写回 set 操作，fence = 读到的 revision',
  JSON.stringify(form.mutations.at(-1)) === JSON.stringify({ ops: [{ op: 'set', path: ['enabled'], value: false }], fence: 3 }),
  JSON.stringify(form.mutations.at(-1)),
)

// 「恢复默认」→ 保存 → 发 unset（让它重新继承部署层）
cells = []
tree = render()
findButton(tree, '恢复默认').props.onClick()
tree = render()
await findButton(tree, '保存').props.onClick()
check(
  '8. 恢复默认写回 unset',
  JSON.stringify(form.mutations.at(-1)) === JSON.stringify({ ops: [{ op: 'unset', path: ['dryRun'] }], fence: 3 }),
  JSON.stringify(form.mutations.at(-1)),
)

const failed = results.filter((r) => !r.ok)
console.log(`\n浏览器半边设置契约：${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
