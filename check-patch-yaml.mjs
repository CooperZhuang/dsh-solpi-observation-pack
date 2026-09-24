/** 校验 profile 的 cordis.patch.yml 仍是合法 YAML，并打印每行的 id/config 概要。 */
import { readFileSync } from 'node:fs'
import { parse } from 'file:///C:/Users/Cooper/AppData/Local/npm-cache/_npx/c8633a242642d858/node_modules/yaml/dist/index.js'

const path = 'C:/Users/Cooper/.dsh/profiles/web/cordis.patch.yml'
const doc = parse(readFileSync(path, 'utf8'))
if (!Array.isArray(doc)) throw new Error('顶层不是数组')
console.log(`YAML 合法：顶层 ${doc.length} 个条目`)
const ids = doc.map((e) => e?.id).filter(Boolean)
const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
console.log(`id 列表：${ids.join(', ')}`)
console.log(`重复 id：${dup.length ? [...new Set(dup)].join(', ') : '（无）'}`)
const spill = doc.find((e) => e?.id === 'spill-local')
console.log('spill-local 行：' + JSON.stringify(spill))
const solpi = doc.find((e) => e?.id === 'solpi-observation-pack')
console.log('solpi 行：' + JSON.stringify(solpi))
