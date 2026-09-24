/**
 * 在【真实会话日志】里找已落地的 ObservationPack handle，并核对归档文件是否还在、
 * 内容是否与 handle 声明的字节数/行数一致 —— 即"模型看到 handle 之后，
 * 内置 read 工具是否真的能把原文按页读回来"。
 *
 * 会话日志是分帧 zstd 压缩的 jsonl（session.v3.jsonl.zstd），逐帧解压后按行扫。
 *
 * 用法：node scan-real-handles.mjs [--since YYYY-MM-DD] [--limit N]
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const sinceArg = args[args.indexOf('--since') + 1]
const since = args.includes('--since') ? new Date(sinceArg).getTime() : 0
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 8

const sessionsRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.jsonl(\.zstd)?$/u.test(e.name)) out.push(p)
  }
  return out
}

function decompress(file) {
  const buf = readFileSync(file)
  if (!file.endsWith('.zstd')) return buf.toString('utf8')
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
  }
  offsets.push(buf.length)
  const parts = []
  for (let k = 0; k < offsets.length - 1; k += 1) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(offsets[k], offsets[k + 1])).toString('utf8'))
    } catch { /* 单帧解压失败不影响其它帧 */ }
  }
  return parts.join('')
}

const files = walk(sessionsRoot).filter((f) => statSync(f).mtimeMs >= since)
console.log(`扫描 ${files.length} 份会话日志（since=${since ? sinceArg : '不限'}）`)

/** 收集一棵 JSON 树里所有字符串。 */
function strings(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const v of node) strings(v, out)
  else if (node !== null && typeof node === 'object') for (const v of Object.values(node)) strings(v, out)
  return out
}

const found = []
for (const file of files) {
  let text
  try {
    text = decompress(file)
  } catch {
    continue
  }
  if (!text.includes('large tool result replaced after its first')) continue
  for (const line of text.split('\n')) {
    if (!line.includes('large tool result replaced after its first')) continue
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      continue
    }
    // 直接在【已解析的真实字符串】上抽字段：反斜杠与换行都是原始形态
    for (const s of strings(payload)) {
      if (!s.includes('large tool result replaced after its first')) continue
      const id = s.match(/^id: (obs_[0-9a-f]{24})$/mu)?.[1]
      const tool = s.match(/^tool: (.+)$/mu)?.[1]
      const declaredBytes = Number(s.match(/^original_bytes: (\d+)$/mu)?.[1])
      const declaredLines = Number(s.match(/^original_lines: (\d+)$/mu)?.[1])
      const locator = s.match(/^stored_at: (.+)$/mu)?.[1]
      if (id === undefined || locator === undefined) continue
      found.push({ file, id, tool, declaredBytes, declaredLines, locator })
    }
  }
}

// 去重（同一 id 在替换事件 + 后续派生里可能出现多次）
const seen = new Set()
const unique = found.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)))
console.log(`含 handle 的会话日志：${new Set(found.map((f) => f.file)).size} 份；唯一条目 ${unique.length} 条\n`)

let okBytes = 0
let okLines = 0
let missing = 0
for (const item of unique.slice(0, limit)) {
  let exists = existsSync(item.locator)
  let isDir = false
  try {
    isDir = exists && statSync(item.locator).isDirectory()
  } catch { /* ignore */ }
  let size = 0
  let lines = 0
  if (exists && !isDir) {
    const raw = readFileSync(item.locator, 'utf8')
    size = Buffer.byteLength(raw, 'utf8')
    lines = raw.length === 0 ? 0 : raw.split('\n').length
  } else {
    missing += 1
  }
  const bytesOk = exists && !isDir && size === item.declaredBytes
  const linesOk = exists && !isDir && lines === item.declaredLines
  if (bytesOk) okBytes += 1
  if (linesOk) okLines += 1
  console.log(`${isDir ? 'ISDIR' : exists ? 'EXISTS' : 'MISSING'}  ${item.id}  tool=${item.tool}`)
  console.log(`         声明 ${item.declaredBytes}B / ${item.declaredLines} 行`)
  console.log(`         实际 ${exists && !isDir ? `${size}B / ${lines} 行` : '（读不到）'}  bytes_match=${bytesOk} lines_match=${linesOk}`)
  console.log(`         归档 ${JSON.stringify(item.locator)}`)
  console.log(`         会话 ${item.file}`)
}

console.log(`\n抽检 ${Math.min(limit, unique.length)} 条：字节数一致 ${okBytes}，行数一致 ${okLines}，归档缺失 ${missing}`)
console.log('注意：original_lines 的算法与上游/插件不同（上游 countLines 不把结尾换行算成额外行），行数不一致不必然是缺陷。')
