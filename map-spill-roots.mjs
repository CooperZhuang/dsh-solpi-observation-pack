/** 把会话 id 映射到 spill root 里的 session-<hash> 目录，看清"哪些归档还在"。 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 占位 id（脱敏自真机会话）：只为演示 id → spill 目录名的映射关系
const ids = [
  'session-11111111-2222-4333-8444-555555555555',
  'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
]
for (const id of ids) {
  console.log(id, '->', 'session-' + createHash('sha256').update(id).digest('hex').slice(0, 12))
}

console.log('\n--- 现存 spill roots ---')
const roots = readdirSync(tmpdir()).filter((n) => /^dsh-spill-[A-Za-z0-9]{6}$/u.test(n))
for (const r of roots) {
  const p = join(tmpdir(), r)
  for (const s of readdirSync(p)) {
    if (!/^session-[0-9a-f]{12}$/u.test(s)) continue
    const files = readdirSync(join(p, s))
    const sizes = files.map((f) => {
      try {
        return readFileSync(join(p, s, f)).length
      } catch {
        return -1
      }
    })
    console.log(`${r.padEnd(20)} ${s}  ${files.length} 个文件, ${sizes.reduce((a, b) => a + b, 0)}B`)
    for (let i = 0; i < Math.min(3, files.length); i += 1) console.log(`    ${files[i]}  ${sizes[i]}B`)
  }
}
