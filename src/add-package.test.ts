import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPackage } from './add-package.ts'
import type { Run } from './prepare-upstream.ts'

const EXTENDER = 'npm:pi-extension-extender'

function setup({ global, project }: { global?: string; project?: string }) {
  const agentDir = mkdtempSync(join(tmpdir(), 'agent-'))
  const cwd = mkdtempSync(join(tmpdir(), 'cwd-'))
  const root = join(agentDir, 'extension-extender')
  mkdirSync(root)
  if (global !== undefined) writeFileSync(join(agentDir, 'settings.json'), global)
  if (project !== undefined) {
    mkdirSync(join(cwd, '.pi'))
    writeFileSync(join(cwd, '.pi', 'settings.json'), project)
  }
  return { agentDir, cwd, root }
}

function fakeRun(repositories: Record<string, string> = {}) {
  const calls: { cwd: string; command: string; args: string[] }[] = []
  const run: Run = async (cwd, command, args) => {
    calls.push({ cwd, command, args })
    if (command === 'npm' && args[0] === 'view') return repositories[args[1]] ?? ''
    return ''
  }
  return { run, calls }
}

async function add(paths: { agentDir: string; cwd: string; root: string }, run: Run, args: string) {
  return addPackage({
    tokens: args.split(/\s+/),
    root: paths.root,
    agentDir: paths.agentDir,
    cwd: paths.cwd,
    run,
  })
}

test('adds a git package to global settings, clones it, and returns the checkout path', async () => {
  const paths = setup({ global: JSON.stringify({ packages: [EXTENDER] }) })
  const { run, calls } = fakeRun()
  const checkout = await add(paths, run, 'add git:github.com/owner/repo')
  const settings = JSON.parse(readFileSync(join(paths.agentDir, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.packages, [EXTENDER, 'git:github.com/owner/repo'])
  assert.deepEqual(calls.map((call) => call.args), [
    ['clone', 'https://github.com/owner/repo.git', 'repo'],
    ['switch', '-c', 'local', '--track', 'origin/main'],
  ])
  assert.equal(checkout, join(paths.root, 'repo'))
})

test('aborts a global add when the extender is not in global settings, and writes nothing', async () => {
  const content = JSON.stringify({ packages: ['npm:other'] })
  const paths = setup({ global: content })
  const { run, calls } = fakeRun()
  await assert.rejects(add(paths, run, 'add git:github.com/owner/repo'), /install-global first, or add with -l/)
  assert.equal(readFileSync(join(paths.agentDir, 'settings.json'), 'utf8'), content)
  assert.deepEqual(calls, [])
})

test('adds a local package to project settings without needing the extender in global settings', async () => {
  const paths = setup({ global: JSON.stringify({ packages: ['npm:other'] }) })
  const { run, calls } = fakeRun()
  await add(paths, run, 'add -l git:github.com/owner/repo')
  const project = JSON.parse(readFileSync(join(paths.cwd, '.pi', 'settings.json'), 'utf8'))
  assert.deepEqual(project.packages, ['git:github.com/owner/repo'])
  assert.equal(calls[0].args[0], 'clone')
})

test('aborts when the checkout folder already exists, and writes nothing', async () => {
  const content = JSON.stringify({ packages: [EXTENDER] })
  const paths = setup({ global: content })
  mkdirSync(join(paths.root, 'repo'))
  const { run, calls } = fakeRun()
  await assert.rejects(add(paths, run, 'add git:github.com/owner/repo'), /already exists/)
  assert.equal(readFileSync(join(paths.agentDir, 'settings.json'), 'utf8'), content)
  assert.deepEqual(calls, [])
})

test('adds nothing when the entry already exists, and returns no checkout', async () => {
  const content = JSON.stringify({ packages: [EXTENDER, 'git:github.com/owner/repo'] })
  const paths = setup({ global: content })
  const { run, calls } = fakeRun()
  const checkout = await add(paths, run, 'add git:github.com/owner/repo')
  assert.equal(readFileSync(join(paths.agentDir, 'settings.json'), 'utf8'), content)
  assert.deepEqual(calls, [])
  assert.equal(checkout, undefined)
})

test('resolves an npm source to its repository.url, stripping the git+ prefix', async () => {
  const paths = setup({ global: JSON.stringify({ packages: [EXTENDER] }) })
  const { run, calls } = fakeRun({ 'pi-sandbox': 'git+https://github.com/carderne/pi-sandbox.git' })
  await add(paths, run, 'add npm:pi-sandbox@1.2.0')
  const settings = JSON.parse(readFileSync(join(paths.agentDir, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.packages, [EXTENDER, 'npm:pi-sandbox@1.2.0'])
  assert.deepEqual(calls[1].args, ['clone', 'https://github.com/carderne/pi-sandbox.git', 'pi-sandbox'])
})

test('aborts an npm add when npm lists no repository.url, and writes nothing', async () => {
  const content = JSON.stringify({ packages: [EXTENDER] })
  const paths = setup({ global: content })
  const { run, calls } = fakeRun()
  await assert.rejects(add(paths, run, 'add npm:pi-ghsearch'), /lists no repository.url on npm/)
  assert.equal(readFileSync(join(paths.agentDir, 'settings.json'), 'utf8'), content)
  assert.deepEqual(calls.map((call) => call.args[0]), ['view'])
})

test('requires a git: or npm: source', async () => {
  const paths = setup({ global: JSON.stringify({ packages: [EXTENDER] }) })
  const { run } = fakeRun()
  await assert.rejects(add(paths, run, 'add'), /Usage/)
})
