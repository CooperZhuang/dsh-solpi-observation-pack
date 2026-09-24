/**
 * dsh-solpi-observation-pack
 *
 * ObservationPack 机制的 DSH 原生实现。
 *
 * 灵感来自 NVIDIA SoL-Pi (https://github.com/NVlabs/SoL-Pi) 的 ObservationPack：
 * 重复出现在后续每个 provider 请求里的大工具结果，替换为一个稳定的 handle，
 * 原始字节归档保存，需要时按页精确召回。
 *
 * 与 SoL-Pi 的关键差异（架构性，非选择）：
 *   SoL-Pi 在 Pi 的 `context` 事件上做「只改投影、不动历史」。
 *   DSH 在 `dsh-agent-loop` 的 buildRequest() 里对请求对象、messages 数组和每条
 *   消息无条件 deepFreeze，并断言 messages === session.deriveMessages()，因此
 *   投影式改写被禁止。
 *   DSH 的正确落点是 **durable surface replacement**：追加一个带
 *   surfaceOp:{op:'replace'} 的 tool/result 事件。模型看到替换副本，人类记录由
 *   append-origin 事件保留原文，replay 可逐字节还原（dsh-session/surface.ts）。
 *   该契约由 assertToolResultRewrite 强制执行：除内层 content 外逐字段必须相同。
 *
 * 触发点：`agent/pre-step`（每个 step 边界的 async waterfall，带该 turn 的
 * AbortSignal）。这与 dsh-compaction-basic 调用 toolResultPruner.pruneSession()
 * 的位置相同，已验证在 turn 活跃时追加表面替换是合法的。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名。 */
export const name = 'solpi-observation-pack'

/**
 * 本插件在 profile 里的 entry id。
 *
 * 它同时是浏览器半边取配置表单的 key（`ctx.configForms.get(entryId)`）与
 * `settings.section` 槽的 `id`；三处必须完全一致——表单是按 entry id 提供的，
 * 任何一处对不上，界面就什么都读不到。
 */
export const SETTINGS_NS = 'solpi-observation-pack'

/**
 * 尽力而为的日志：既走宿主 logger，也追加到 `$DSH_HOME/logs/<plugin>.log`
 * （沿用本仓库其他插件如 dsh-memories 的约定，便于在宿主 stdout 不可见时排障）。
 * 任何失败都被吞掉——日志绝不能影响机制本身。
 */
function makeFileLogger(ctx) {
  let path
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const dir = join(home, 'logs')
    mkdirSync(dir, { recursive: true })
    path = join(dir, 'dsh-solpi-observation-pack.log')
  } catch {
    path = undefined
  }
  return (level, message) => {
    ctx?.logger?.[level]?.(message)
    if (path === undefined) return
    try {
      appendFileSync(path, `[${new Date().toISOString()}] ${level} ${message}\n`, 'utf8')
    } catch {
      /* 日志失败不影响机制 */
    }
  }
}

/**
 * 影子模式的机器可读产出。
 *
 * 影子模式不改会话，所以收益无法从会话日志里读出来——单独落一份 JSONL，
 * 让 A/B 执行器能直接算「机制理论上能省多少」，与「真的替换后实际省多少」对照。
 * @param record - 一条估算记录。
 */
function appendDryRunRecord(record) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const dir = join(home, 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'dsh-solpi-observation-pack-dryrun.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    /* 度量失败不影响机制 */
  }
}

/** 默认配置（对齐 SoL-Pi 的取值，另加两个为 A/B 探索新增的开关）。 */
const DEFAULTS = Object.freeze({
  /** 总开关。 */
  enabled: true,
  /** 影子模式：只统计潜在收益，不真的替换。 */
  dryRun: false,
  /** 参与打包的最小 UTF-8 字节数（SoL-Pi: 10 KiB）。 */
  thresholdBytes: 10 * 1024,
  /** 前 N 次请求发全文，之后替换（SoL-Pi: 2）。 */
  fullSends: 2,
  /** handle 中头/尾各保留的完整行字节预算（SoL-Pi: 各 512）。 */
  excerptBytes: 1024,
  /** 不参与打包的工具名。 */
  skipTools: [],
  /** 是否为被替换节点写一条 log-only 的影子定价事件。 */
  emitShadowPrice: true,
})

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS))

/**
 * 插件配置。可编辑的旋钮就是这七个字段。
 *
 * 这就是本插件**自己的 entry 配置**：profile 的 Cordis patch 写的是这些字段，
 * 浏览器半边的配置菜单写的也是这些字段。标了 `.volatile()` 的字段由 Loader 以
 * **活引用**（`{ get(): T }`）交给 `apply`，写盘后原地更新引用并补发一次
 * `loader/volatile-update`——所以每一次读取都拿到最新已提交的值，不需要重启，
 * 也不需要重挂。只有 volatile 字段会进入平台自动生成的表单（本插件自带界面，
 * 那份表单已被关掉），其余字段是普通的组合配置。
 *
 * 这些 description 随 `schema.toJSON()` 进入表单描述，是界面展示的权威来源。
 * 文案统一中文。
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled)
    .description('总开关。关闭后不再打包任何工具结果，已落地的替换保持原样。')
    .volatile(),
  dryRun: z.boolean().default(DEFAULTS.dryRun)
    .description('影子模式。只统计"如果打包能省多少 token"，不真的替换上下文。用于 A/B 对照与安全评估。')
    .volatile(),
  thresholdBytes: z.number().default(DEFAULTS.thresholdBytes)
    .description('触发阈值（字节）。工具结果的 UTF-8 字节数超过它才参与打包。默认 10240（10 KiB），与上游 SoL-Pi 一致。')
    .volatile(),
  fullSends: z.number().default(DEFAULTS.fullSends)
    .description('完整发送次数。前 N 次 provider 请求照发全文，第 N+1 次起替换为 handle。默认 2，与上游一致。设大更保守。')
    .volatile(),
  excerptBytes: z.number().default(DEFAULTS.excerptBytes)
    .description('摘录预算（字节）。handle 中头、尾各保留一半，且只取完整行、不切开任何一行。默认 1024。')
    .volatile(),
  skipTools: z.array(z.string()).default([...DEFAULTS.skipTools])
    .description('跳过工具。列出的工具，其结果永不打包（例如 read）。')
    .volatile(),
  emitShadowPrice: z.boolean().default(DEFAULTS.emitShadowPrice)
    .description('写入影子定价事件。在会话日志里为每个被替换的节点记一条携带 token 估价的 compaction/prune 事件，便于事后统计收益。')
    .volatile(),
})

/**
 * 解包 entry 配置里的 volatile 引用。
 *
 * `.volatile()` 字段交给 `apply` 的是活引用（`{ get() }`），值只在 Loader 写盘后
 * 原地更新，所以每次都要重新 `get()`；而且必须在校验之前解包——下面那些严格类型
 * 检查看到的必须是普通布尔/数字/数组。普通配置对象（未走 Loader 的挂载、仓库脚本
 * 里的调用）原样通过。
 * @param config - entry 配置或普通配置对象。
 * @returns 值已解包的浅拷贝。
 */
function plainConfig(config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const plain = {}
  for (const [key, value] of Object.entries(source)) plain[key] = isVolatile(value) ? value.get() : value
  return plain
}

/** 校验并冻结配置；未知键直接报错（沿用 SoL-Pi 的严格风格）。 */
export function resolveConfig(config = {}) {
  const plain = plainConfig(config)
  for (const key of Object.keys(plain)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`solpi-observation-pack: unknown config key "${key}" (allowed: ${[...CONFIG_KEYS].join(', ')})`)
    }
  }
  const resolved = { ...DEFAULTS, ...plain }
  for (const key of ['enabled', 'dryRun', 'emitShadowPrice']) {
    if (typeof resolved[key] !== 'boolean') {
      throw new Error(`solpi-observation-pack: ${key} must be a boolean (got ${String(resolved[key])})`)
    }
  }
  for (const key of ['thresholdBytes', 'fullSends', 'excerptBytes']) {
    if (!Number.isInteger(resolved[key]) || resolved[key] < 0) {
      throw new Error(`solpi-observation-pack: ${key} must be a non-negative integer (got ${resolved[key]})`)
    }
  }
  if (resolved.fullSends < 1) throw new Error('solpi-observation-pack: fullSends must be at least 1')
  if (!Array.isArray(resolved.skipTools) || resolved.skipTools.some((t) => typeof t !== 'string')) {
    throw new Error('solpi-observation-pack: skipTools must be an array of tool names')
  }
  return Object.freeze({ ...resolved, skipTools: Object.freeze([...resolved.skipTools]) })
}

/**
 * 把 entry 配置的解析值收敛成运行时配置。
 *
 * `Config` 已经校验过，这里只做形状兜底：某个字段可能被手工改坏成 undefined，
 * 而运行时不该因此崩掉。volatile 引用要在兜底之前解包——`skipTools` 整个数组
 * 包在一个引用里，不解包就看不到用户填的值。
 * @param value - entry 配置的解析值（普通值或 volatile 引用）。
 * @returns 冻结的运行时配置。
 */
export function normalizeSettings(value) {
  const source = plainConfig(value)
  return resolveConfig({
    ...source,
    skipTools: Array.isArray(source.skipTools) ? source.skipTools.filter((t) => typeof t === 'string') : [],
  })
}

// ---------------------------------------------------------------------------
// 纯函数（可独立测试）
// ---------------------------------------------------------------------------

/** 统计 Unicode 码点，不切开代理对。 */
export function codePointLength(text) {
  return Array.from(text).length
}

/** 估算 token（SoL-Pi 用 ceil(chars/4)）。 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}

/** 把所有 text block 拍平；出现任何非 text block 则返回 undefined（不参与打包）。 */
export function flattenText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined
  let text = ''
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') return undefined
    text += block.text
  }
  return text
}

/** 稳定内容寻址 id：同一 callId + 同一内容 → 同一 id（跨 resume 稳定）。 */
export function observationId(callId, text) {
  const contentHash = createHash('sha256').update(text, 'utf8').digest('hex')
  const id = createHash('sha256').update(`${callId}\0${contentHash}`, 'utf8').digest('hex').slice(0, 24)
  return { id: `obs_${id}`, contentHash }
}

/** 取头/尾各若干【完整行】，不切开任何一行。 */
export function completeLineExcerpt(text, headBudget, tailBudget) {
  const lines = text.split(/(?<=\n)/)
  const head = takeLines(lines, headBudget)
  const tailReversed = takeLines([...lines].reverse(), tailBudget)
  const tail = tailReversed.split(/(?<=\n)/).filter(Boolean).reverse().join('')
  return { head, tail }
}

/** 从头累加完整行直到超出字节预算。 */
function takeLines(lines, budget) {
  let out = ''
  for (const line of lines) {
    if (Buffer.byteLength(out, 'utf8') + Buffer.byteLength(line, 'utf8') > budget) break
    out += line
  }
  return out
}

/** 构造确定性的 handle 文本（相邻两次必须逐字节相同，以保护 prompt cache）。 */
export function buildHandle({ id, tool, bytes, lines, tokens, head, tail, locator, hint, fullSends }) {
  const omitted = Math.max(
    0,
    bytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8'),
  )
  return [
    `[large tool result replaced after its first ${fullSends} provider requests]`,
    `id: ${id}`,
    `tool: ${tool}`,
    `original_bytes: ${bytes}`,
    `original_lines: ${lines}`,
    `estimated_tokens: ${tokens}`,
    `stored_at: ${locator}`,
    'retrieve: use the read tool with offset/limit on stored_at to page through the original',
    hint ? `hint: ${hint}` : undefined,
    '[first complete lines]',
    head,
    '[middle omitted; last complete lines]',
    tail,
    `[${omitted} original bytes omitted]`,
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

// ---------------------------------------------------------------------------
// 会话扫描
// ---------------------------------------------------------------------------

/** 当前 surface 上每个节点的 seq → 事件。 */
function surfaceEntries(session) {
  const out = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event !== undefined) out.push({ seq, event })
  }
  return out
}

/** 找出可打包的 tool/result 节点，并算出它已经参与过多少次请求。 */
export function planObservations(session, config) {
  const entries = surfaceEntries(session)
  const assistantSeqs = entries.filter((e) => e.event.type === 'assistant/message').map((e) => e.seq)

  const planned = []
  for (const { seq, event } of entries) {
    if (event.type !== 'tool/result') continue
    // 已经是替换副本的节点不再处理（幂等）
    if (event.surfaceOp !== undefined && event.surfaceOp?.op === 'replace') continue

    // 消息形状走平台自己的取值口：0.1.7 起 tool/result 的 content 直接是一组
    // block（不再是「一个 `tool-result` block，里面再嵌 content」），callId 也从
    // block 搬到 message.source 上。写死旧形状只会在升级后静默地什么都不打包。
    const message = session.deriveEventMessage(event)
    if (message === null || message === undefined) continue
    if (message.isError === true) continue

    const text = flattenText(message.content)
    if (text === undefined) continue
    if (Buffer.byteLength(text, 'utf8') <= config.thresholdBytes) continue

    // 解析工具名：result 的 sourceEventSeqs 指向配对的 tool/call
    let tool = 'unknown'
    const callSeq = event.sourceEventSeqs?.[0]
    if (callSeq !== undefined) {
      const call = session.eventAt(callSeq)
      if (call?.type === 'tool/call' && typeof call.data?.name === 'string') tool = call.data.name
    }
    if (config.skipTools.includes(tool)) continue

    // 该结果之后有多少条 assistant 消息 = 它已经参与过多少次请求
    const sendsAfter = assistantSeqs.filter((s) => s > seq).length
    if (sendsAfter < config.fullSends) continue

    planned.push({ seq, event, message, tool, text, sendsAfter, callId: message.source?.callId })
  }
  return planned
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

/**
 * 安装 ObservationPack。
 *
 * 配置只有两层，优先级从低到高：`Config` 里的 schema 默认值 → 本插件这份 entry
 * 配置（profile 的 Cordis patch；设置界面写的也是它）。可编辑旋钮是 `Config` 里
 * 标了 `.volatile()` 的字段：Loader 写盘后原地更新这些引用，再在本插件的 ctx 上
 * 补发 `loader/volatile-update`，所以每个旋钮都在下一次读取时生效，不需要重启。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} rawConfig entry 配置（volatile 字段是活引用；普通配置对象也接受）。
 */
export function apply(ctx, rawConfig = {}) {
  const log = makeFileLogger(ctx)

  /** 当前生效的运行时配置；由 loader/volatile-update 持续刷新。 */
  let current = normalizeSettings(rawConfig)
  const read = () => current

  const stats = { packed: 0, dryRun: 0, bytesRemoved: 0, tokensRemoved: 0, skipped: 0 }

  // 本插件自带设置界面（浏览器半边的 `settings.section` 菜单），所以关掉平台按
  // `Config` 自动生成的那份表单：同一组旋钮只留一个入口。
  // 必须走 ctx.inject 而不是 ctx.get('settings')：服务只有在提供它的 fiber 变为
  // active 之后才可读，插件加载时直接 ctx.get 会**静默拿到 undefined**。
  // （这不是猜测——本仓库的 dsh-auto-thinking-effort 源码里明确记了这个坑。）
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // 旋钮改动落在本插件自己的 entry 配置上：Loader 原地更新 volatile 引用之后再发
  // 这个事件。重读引用就能拿到最新已提交的值——不重启，也不重挂。
  ctx.on('loader/volatile-update', () => {
    current = normalizeSettings(rawConfig)
    log('info', `settings updated: ${describeConfig(current)}`)
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (signal?.aborted) return next()
    const config = read()
    if (config.enabled !== true) return next()
    try {
      await packSession(ctx, agent.session, config, stats, log)
    } catch (error) {
      // fail-soft：打包失败绝不能让 agent 失去它的观测
      log('warn', `fail-open (${String(error?.message ?? error)})`)
    }
    return next()
  })

  log('info', `active ${describeConfig(current)}`)
  pluginStats.set(ctx, stats)
}

/** 一行摘要，用于日志。 */
function describeConfig(config) {
  return `(enabled=${config.enabled}, dryRun=${config.dryRun}, thresholdBytes=${config.thresholdBytes}, fullSends=${config.fullSends}, excerptBytes=${config.excerptBytes}, emitShadowPrice=${config.emitShadowPrice}, skipTools=[${config.skipTools.join(',')}])`
}

/** 每个 ctx 的运行统计，供测试与诊断读取。 */
const pluginStats = new WeakMap()

/** 读取某个 ctx 上的运行统计。 */
export function getStats(ctx) {
  return pluginStats.get(ctx)
}

/** 影子模式下已报告过的 (会话, 观测 id)，避免每个 step 重复刷同一行日志。 */
const dryRunReported = new WeakMap()

/** 对一条会话执行一轮打包。返回本轮落地的替换（影子模式下是估算记录）。 */
export async function packSession(ctx, session, config, stats, log) {
  const planned = planObservations(session, config)
  const landed = []
  for (const item of planned) {
    const replaced = await packOne(ctx, session, config, item, log)
    if (replaced === null) {
      if (stats) stats.skipped += 1
      continue
    }
    if (replaced.dryRun === true) {
      // 影子模式不改变会话，同一节点会在每个 step 反复出现。
      // 去重必须在【写盘之前】完成（见 packOne）：否则同一节点每个 step 都会各写一行
      // 日志与 dryrun.jsonl——实测 82,032 条记录只对应 424 个唯一条目，
      // 8 天堆到 11.3 MB 日志 + 17.8 MB JSONL。
      if (replaced.duplicate === true) continue
      if (stats) {
        stats.dryRun += 1
        stats.tokensRemoved += estimateTokens(item.text) - estimateTokensOfHandle(replaced)
      }
      landed.push(replaced)
      continue
    }
    landed.push(replaced)
    if (stats) {
      stats.packed += 1
      stats.bytesRemoved += replaced.bytesBefore - replaced.bytesAfter
      stats.tokensRemoved += estimateTokens(item.text) - estimateTokensOfHandle(replaced)
    }
  }
  return landed
}

/** 用 handle 的字节数估算其 token（与 SoL-Pi 同为 ceil(chars/4) 的量级）。 */
function estimateTokensOfHandle(replaced) {
  return Math.ceil(replaced.bytesAfter / 4)
}

async function packOne(ctx, session, config, item, log) {
  const { id, contentHash } = observationId(item.callId, item.text)
  const bytes = Buffer.byteLength(item.text, 'utf8')
  const lines = item.text.split('\n').length
  const tokens = estimateTokens(item.text)

  const half = Math.floor(config.excerptBytes / 2)
  const { head, tail } = completeLineExcerpt(item.text, half, config.excerptBytes - half)

  // 影子模式：只估算收益，不落盘、不改会话（A/B 对照与安全评估用）。
  if (config.dryRun === true) {
    // 同一 (会话, 观测 id) 只报告一次。去重必须发生在这里——写 JSONL / 日志之前；
    // 放在 packSession 里就太晚了，同一节点每个 step 都会留痕（日志会无限增长）。
    let seen = dryRunReported.get(session)
    if (seen === undefined) {
      seen = new Set()
      dryRunReported.set(session, seen)
    }
    if (seen.has(id)) {
      return { id, originalSeq: item.seq, tool: item.tool, contentHash, bytesBefore: bytes, bytesAfter: 0, locator: null, dryRun: true, duplicate: true }
    }
    seen.add(id)

    const estimate = buildHandle({
      id,
      tool: item.tool,
      bytes,
      lines,
      tokens,
      head,
      tail,
      locator: '<spill>',
      hint: '',
      fullSends: config.fullSends,
    })
    const bytesAfter = Buffer.byteLength(estimate, 'utf8')
    const savedTokens = tokens - estimateTokens(estimate)
    appendDryRunRecord({
      at: new Date().toISOString(),
      sessionId: String(session.id),
      id,
      tool: item.tool,
      bytesBefore: bytes,
      bytesAfter,
      tokensSaved: savedTokens,
      sendsAfter: item.sendsAfter,
    })
    log?.(
      'info',
      `dry-run would pack ${id} (${item.tool}, ${bytes}B → ~${bytesAfter}B, saves ~${savedTokens} tokens, sends=${item.sendsAfter})`,
    )
    return { id, originalSeq: item.seq, tool: item.tool, contentHash, bytesBefore: bytes, bytesAfter, locator: null, dryRun: true }
  }

  const spillStore = ctx.get?.('spillStore')
  if (spillStore === undefined) return null

  const ref = await spillStore.saveText({
    owner: { sessionId: session.id },
    source: { kind: 'tool', toolName: item.tool, callId: item.callId, label: 'observation' },
    suggestedName: `${item.tool}.txt`,
    content: item.text,
  })

  const handle = buildHandle({
    id,
    tool: item.tool,
    bytes,
    lines,
    tokens,
    head,
    tail,
    locator: String(ref.locator),
    hint: ref.retrievalHint,
    fullSends: config.fullSends,
  })
  const bytesAfter = Buffer.byteLength(handle, 'utf8')

  // durable surface replacement：除 content 外逐字段与原文相同（平台用
  // assertToolResultRewrite 强制这一点），所以整条消息从平台给的那份展开、只换
  // content，`freezeMessage` 再连深拷贝一起冻结。source 随原文保留——手工拼一条
  // 新消息会丢掉生产者归属，v4 会话格式会直接拒绝这次写入。
  const message = freezeMessage({ ...item.message, content: [{ type: 'text', text: handle }] })

  // 影子定价事件：不带 surfaceOp → log-only，不进模型上下文
  if (config.emitShadowPrice === true) {
    session.append('compaction/prune', {
      shadowedRange: { start: item.seq, end: item.seq },
      shadowedSeqs: [item.seq],
      shadowedTokenCount: tokens,
    })
  }

  // durable surface replacement：除内层 content 外逐字段与原文相同
  session.append(
    'tool/result',
    { ...item.event.data, message },
    { surfaceOp: { op: 'replace', startSeq: item.seq, endSeq: item.seq }, sourceEventSeqs: [item.seq] },
  )

  log?.('info', `packed ${id} (${item.tool}, ${bytes}B → ${bytesAfter}B, sends=${item.sendsAfter})`)

  return {
    id,
    originalSeq: item.seq,
    tool: item.tool,
    contentHash,
    bytesBefore: bytes,
    bytesAfter,
    locator: String(ref.locator),
    dryRun: false,
  }
}

// The Loader takes the DEFAULT export as the plugin (`exports.default ?? exports`),
// and the settings domain reads a plugin's editable schema from it
// (`runtime.Config`): a default export that omits `Config` leaves the entry with
// no form at all, so the whole surface has to travel together.
export default { name, apply, Config }
