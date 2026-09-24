/**
 * 对【正在运行】的 dsh web 实例做只读探测（自签 cookie，不需要 boot token）：
 *  1) 用 ~/.dsh/.credentials.yaml 里的 browser-session 持久密钥，按
 *     dsh-client-connection 的 encodeCookie 格式自签一个 browser-session cookie
 *  2) 取首页，解析客户端模块 manifest
 *  3) 确认 dsh-solpi-observation-pack/client.js 在 manifest 里
 *  4) 取回该 bundle，与仓库里的 lib/client.js 逐字节对比
 *  5) 顺带读 /api 上的 settings 描述，确认命名空间已注册（如果该路由可用）
 *
 * 用法：node probe-live-client.mjs [port] [authority]
 */
import { createHmac, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 3080)
const authority = process.argv[3] ?? `127.0.0.1:${port}`
const base = `http://${authority}/`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ---- 自签 cookie -------------------------------------------------------------
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const creds = readFileSync(join(home, '.credentials.yaml'), 'utf8')
const secretMatch = creds.match(/browser-session:[\s\S]*?secret:\s*(\S+)/)
if (!secretMatch) {
  console.log('FATAL  .credentials.yaml 里找不到 client-connection/browser-session 的 secret')
  process.exit(2)
}
const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const decodeB64Url = (v) => Buffer.from(v.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (v.length % 4)) % 4), 'base64')
const secret = decodeB64Url(secretMatch[1])
console.log(`secret 长度 ${secret.byteLength} 字节（期望 32）`)

const now = Date.now()
const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 1440 * 60 * 1000 }
const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
const sig = b64url(createHmac('sha256', secret).update(body).digest())
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
const cookie = `${cookieName}=v1.${body}.${sig}`
check('1. 自签 browser-session cookie 成功', cookie.length > 0, cookieName)

// ---- 首页 + manifest ---------------------------------------------------------
const res2 = await fetch(base, { headers: { cookie } })
const html = await res2.text()
check('2. 带 cookie 可取到首页', res2.ok, `HTTP ${res2.status}, ${html.length} 字节`)
if (!res2.ok) {
  console.log(html.slice(0, 200))
  process.exit(1)
}

const manifest = html.match(/\/plugins\/\?\?[^"'<> ]+/)?.[0]
const rev = manifest?.match(/rev=([^&"]+)/)?.[1]
console.log(`manifest rev=${rev}`)
const ids = [...new Set([...html.matchAll(/([\w@/.-]+)\/client\.js/g)].map((m) => m[1]))]
console.log(`manifest 客户端模块 ${ids.length} 个`)
console.log('  ' + ids.join('\n  '))
check('3. manifest 含 dsh-solpi-observation-pack/client.js', ids.includes('dsh-solpi-observation-pack'))

// ---- 取回 bundle 并对比 -------------------------------------------------------
// 注意：client-modules 只按【compose() 公布的整批 combo URL】提供响应，
// 单个 `/plugins/<id>/client.js` 不在响应表里（404），所以必须取整批。
if (ids.includes('dsh-solpi-observation-pack') && manifest) {
  const combo = manifest.replaceAll('&amp;', '&')
  const res3 = await fetch(new URL(combo, base), { headers: { cookie } })
  const served = await res3.text()
  check('4. combo bundle 可取回', res3.ok, `HTTP ${res3.status}, ${served.length} 字节`)

  const local = readFileSync('C:/CodeRepository/dsh-solpi-observation-pack/lib/client.js', 'utf8')
  // combo 是 63 份 bundle 的拼接；本插件的部分应逐字节出现在其中。
  check('5. 线上 combo 含本地 lib/client.js 的逐字节副本', served.includes(local), served.includes(local) ? `本地 ${local.length} 字符全在` : `本地 ${local.length} 字符未找到`)

  const own = served.includes(local) ? local : served
  const marks = {
    '注册槽 settings.section': own.includes('settings.section'),
    // 注意：本文件注释里提到过这个槽名，所以只能查"是否真的注册进去"。
    '只注册 settings.section，不注册 settings.plugin.item': own.includes("inject('settings.section'") && !own.includes("'settings.plugin.item'"),
    '命名空间 solpi-observation-pack': own.includes('solpi-observation-pack'),
    '中文菜单标签「观测打包」': own.includes('观测打包'),
    __ModuleLoader__: own.includes('__ModuleLoader__'),
    // 0.1.7-alpha.1 起客户端服务改名：仍依赖 settingsScope 的那一份会永远不激活。
    '走新契约 configForms.get(entryId)': own.includes('ctx.configForms.get('),
    '不再引用已删除的 settingsScope': !own.includes('settingsScope'),
  }
  for (const [k, v] of Object.entries(marks)) check(`6. 线上 bundle：${k}`, v)
}

// ---- settings 目录（/api 面） ------------------------------------------------
for (const path of ['api/settings/describe', 'api/settings', 'api']) {
  try {
    const r = await fetch(`${base}${path}`, { headers: { cookie } })
    console.log(`探路 /${path} -> HTTP ${r.status} (${(await r.text()).length}B)`)
  } catch (e) {
    console.log(`探路 /${path} -> ERR ${e.message}`)
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
for (const r of failed) console.log(`  ✗ ${r.name} — ${r.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
