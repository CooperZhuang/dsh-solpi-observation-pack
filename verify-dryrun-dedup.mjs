/**
 * 回归测试：影子模式的日志 / JSONL **不得**随 step 数线性增长。
 *
 * 修复前：去重发生在 packSession（写盘之后），同一节点每个 step 各写一行，
 *         8 天实测 82,032 条记录 / 11.3 MB 日志 / 17.8 MB JSONL 只对应 424 个唯一条目。
 * 修复后：去重在 packOne 的 dryRun 分支、写盘之前完成 → 同一 (会话, 观测 id) 只留一条。
 *
 * 用临时 DSH_HOME 隔离，不碰真实日志。
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'solpi-dedup-home-'))
process.env.DSH_HOME = home

const DSH = 'file:///C:/Users/Cooper/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
const { Context } = await import(DSH + 'cordis/lib/index.js')
const { Session } = await import(DSH + 'dsh-session/lib/index.js')
const { createUserMessage, createAssistantMessage, createToolResultMessage } = await import(DSH + 'dsh-llm/lib/index.js')
const plugin = await import('file:///C:/CodeRepository/dsh-solpi-observation-pack/lib/index.js')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const root = new Context()
// dryRun 分支不需要 spillStore；这里故意不注册，顺便证明影子模式真的不落盘。
await root.plugin(plugin, { thresholdBytes: 1024, fullSends: 2, dryRun: true })

const BIG = Array.from({ length: 300 }, (_, i) => `line ${i}: ${'y'.repeat(50)}`).join('\n')
const CALL_ID = 'call_dedup_1'
const session = Session.create('dedup-check')

session.append(
  'user/message',
  createUserMessage({ content: [{ type: 'text', text: 'build' }], source: { kind: 'user' } }),
  { surfaceOp: 'append' },
)
const assistant = (text) => ({
  turn: 1,
  step: 1,
  message: createAssistantMessage({
    content: text === undefined
      ? [{ type: 'tool-call', id: CALL_ID, name: 'bash', arguments: '{}' }]
      : [{ type: 'text', text }],
    source: { kind: 'model', provider: 'verify', model: 'verify' },
  }),
})
session.append('assistant/message', assistant(), { surfaceOp: 'append' })
const callSeq = session.append('tool/call', { turn: 1, step: 1, callId: CALL_ID, name: 'bash', arguments: '{}' }).seq
session.append(
  'tool/result',
  { turn: 1, step: 1, message: createToolResultMessage({ callId: CALL_ID, content: [{ type: 'text', text: BIG }], isError: false }) },
  { surfaceOp: 'append', sourceEventSeqs: [callSeq] },
)
// 两条后续 assistant 消息 ⇒ 该结果已参与 2 次请求（= fullSends）
session.append('assistant/message', assistant('a'), { surfaceOp: 'append' })
session.append('assistant/message', assistant('b'), { surfaceOp: 'append' })

const STEPS = 5
for (let i = 0; i < STEPS; i += 1) {
  await root.waterfall(
    root,
    'agent/pre-step',
    { messages: [], signal: new AbortController().signal, agent: { session } },
    () => Promise.resolve({ kind: 'enter' }),
  )
}

const jsonlPath = join(home, 'logs', 'dsh-solpi-observation-pack-dryrun.jsonl')
const logPath = join(home, 'logs', 'dsh-solpi-observation-pack.log')
const jsonlLines = existsSync(jsonlPath) ? readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean) : []
const logLines = existsSync(logPath)
  ? readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('dry-run would pack'))
  : []

console.log(`触发 ${STEPS} 次 agent/pre-step`)
check('1. 影子模式确实跑了（JSONL 有记录）', jsonlLines.length > 0, `${jsonlLines.length} 条`)
check('2. JSONL 只写 1 条（修复前会是 ' + STEPS + ' 条）', jsonlLines.length === 1, `实际 ${jsonlLines.length} 条`)
check('3. 日志的 dry-run 行只写 1 条', logLines.length === 1, `实际 ${logLines.length} 条`)
check('4. 影子模式仍然没碰会话（无表面替换事件）', session.snapshotEvents().every((e) => e.surfaceOp === undefined || e.surfaceOp === 'append'), `事件 ${session.snapshotEvents().length} 条`)
check('5. 模型仍能看到完整原文', JSON.stringify(session.deriveMessages()).includes('line 299:'))

const failed = results.filter((r) => !r.ok)
console.log(`\n影子模式去重：${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
