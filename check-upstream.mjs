#!/usr/bin/env node
/** Compare all four SoL-Pi mechanisms with the commit used for the DSH study. */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const baseline = 'd7ecfc089944f0d04b80122a0a9a6ca0d786f3d0'
const repo = process.env.SOL_PI_REPO ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sol-pi-research', 'SoL-Pi')
const offline = process.argv.includes('--offline')
const mechanisms = [
  'action-fusion',
  'observation-pack',
  'evidence-preserving-reducer',
  'online-context-compact',
]

if (process.argv.slice(2).some((arg) => arg !== '--offline')) {
  console.error('Usage: node check-upstream.mjs [--offline]')
  process.exit(2)
}
if (!existsSync(join(repo, '.git'))) {
  console.error(`SoL-Pi clone not found: ${repo} (set SOL_PI_REPO to override)`)
  process.exit(2)
}

function git(args, allowChanged = false) {
  const result = spawnSync('git', args, { cwd: repo, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0 && !(allowChanged && result.status === 1)) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status})`)
  }
  return result.status
}

try {
  if (!offline) git(['fetch', 'origin', 'main'])
  const latest = 'refs/remotes/origin/main'
  git(['cat-file', '-e', `${baseline}^{commit}`])
  git(['cat-file', '-e', `${latest}^{commit}`])
  console.log(`\nBaseline: ${baseline}\nLatest:   ${latest}\nClone:    ${repo}`)
  let changed = 0
  for (const mechanism of mechanisms) {
    const path = `src/sol-pi/extensions/${mechanism}`
    console.log(`\n${mechanism}:`)
    const status = git(['diff', '--quiet', baseline, latest, '--', path], true)
    if (status === 0) {
      console.log('  unchanged')
      continue
    }
    changed++
    git(['diff', '--stat', baseline, latest, '--', path])
  }
  console.log('\nShared and integration changes (review imports, config, tests, docs separately):')
  git(['diff', '--stat', baseline, latest, '--', '.', ':(exclude)src/sol-pi/extensions/action-fusion', ':(exclude)src/sol-pi/extensions/observation-pack', ':(exclude)src/sol-pi/extensions/evidence-preserving-reducer', ':(exclude)src/sol-pi/extensions/online-context-compact'])
  console.log(`\n${changed} of ${mechanisms.length} extension directories changed. A zero here does not rule out indirect changes in shared code.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
