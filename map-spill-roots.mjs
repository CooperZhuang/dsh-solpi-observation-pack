/** 把会话 id 映射到 spill root 里的 session-<hash> 目录，看清"哪些归档还在"。 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ids = [
  'session-217fe16a-5beb-494c-8ea3-e6c147b4c0d0',
  'session-b4475b97-15b5-49e4-a975-4f8b5f76d03b',
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
