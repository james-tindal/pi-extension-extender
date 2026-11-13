import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DefaultPackageManager, getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent'
import { addPackageEntry, hasEntry, listsExtender, orderExtenderBeforeCovered, overrideWarning } from './settings-doctor.ts'
import { npmPackageName, npmRepositoryUrl, run, upstreamFor, type Run } from './prepare-upstream.ts'

export async function addPackage({ tokens, root, agentDir, cwd, run }: {
  tokens: string[]
  root: string
  agentDir: string
  cwd: string
  run: Run
}): Promise<string | undefined> {
  const local = tokens.includes('-l') || tokens.includes('--local')
  const source = tokens.find((token) => token.startsWith('git:') || token.startsWith('npm:'))
  if (!source) throw new Error('Usage: /extension-extender add [-l|--local] <git:|npm:>')
  const globalPath = join(agentDir, 'settings.json')
  const targetPath = local ? join(cwd, '.pi', 'settings.json') : globalPath
  if (!local && !(await listsExtender(globalPath))) {
    throw new Error('extension-extender is not in global settings. Run /extension-extender install-global first, or add with -l.')
  }
  let url: string
  if (source.startsWith('git:')) {
    url = `https://${source.slice('git:'.length)}.git`
  } else {
    const repository = await npmRepositoryUrl(run, root, source)
    if (!repository) throw new Error(`${npmPackageName(source)} lists no repository.url on npm`)
    url = repository.replace(/^git\+/, '')
  }
  const name = basename(url).replace(/\.git$/, '')
  const checkout = join(root, name)
  if (existsSync(checkout)) throw new Error(`${checkout} already exists`)
  if (await hasEntry(targetPath, source)) return undefined
  await addPackageEntry(targetPath, source)
  await run(root, 'git', ['clone', url, name])
  await run(checkout, 'git', ['switch', '-c', 'local', '--track', 'origin/main'])
  return checkout
}

export async function packageSetup(cwd: string) {
  const agentDir = getAgentDir()
  const root = join(agentDir, 'extension-extender')
  await mkdir(root, { recursive: true })
  const settingsManager = SettingsManager.create(cwd, agentDir)
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager })
  return { agentDir, root, packages }
}

export type InstalledPackages = ReturnType<DefaultPackageManager['listConfiguredPackages']>

export function installDependencies(packages: DefaultPackageManager, cwd: string) {
  const manager = packages['getPackageManagerName']()
  const lockfileFlags: Record<string, string> = {
    npm: '--package-lock=false',
    pnpm: '--no-lockfile',
    bun: '--no-save',
  }
  const flag = lockfileFlags[manager]
  if (!flag) throw new Error(`Cannot disable lockfile writes for package manager '${manager}'.`)
  return packages['runNpmCommand']([...packages['getGitDependencyInstallArgs'](), flag], { cwd })
}

export const overridden = (root: string, installed: InstalledPackages) => async (source: string) => {
  const entry = installed.find((item) => item.source === source && item.scope === 'user' && item.installedPath !== undefined)
  if (entry?.installedPath === undefined) throw new Error(`${source} has no installed path`)
  const checkout = join(root, basename(entry.installedPath))
  const upstream = await upstreamFor({ checkout, source, run })
  if (upstream === undefined) return false
  const ahead = await run(checkout, 'git', ['rev-list', '--count', `HEAD..${upstream}`])
  const dirty = await run(checkout, 'git', ['status', '--porcelain'])
  return ahead !== '0' || dirty !== ''
}

export async function coveredBy(root: string, installed: InstalledPackages) {
  const folders = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name)
  return (source: string, scope: 'user' | 'project') => installed.some((entry) => entry.source === source && entry.scope === scope && entry.installedPath !== undefined && folders.includes(basename(entry.installedPath)))
}

export async function orderCheck({ agentDir, cwd, root, packages }: {
  agentDir: string
  cwd: string
  root: string
  packages: DefaultPackageManager
}) {
  const current = packages.listConfiguredPackages()
  return orderExtenderBeforeCovered({ agentDir, cwd, isCovered: await coveredBy(root, current), hasOverride: overridden(root, current) })
}

export async function addCommand({ tokens, root, agentDir, cwd, packages }: {
  tokens: string[]
  root: string
  agentDir: string
  cwd: string
  packages: DefaultPackageManager
}): Promise<{ text: string; level: 'info' | 'warning' }[]> {
  const messages: { text: string; level: 'info' | 'warning' }[] = []
  const checkout = await addPackage({ tokens, root, agentDir, cwd, run })
  if (checkout !== undefined) {
    await installDependencies(packages, checkout)
    messages.push({ text: `Checkout: ${checkout}`, level: 'info' })
  }
  const order = await orderCheck({ agentDir, cwd, root, packages })
  for (const fix of order.fixes) messages.push({ text: `${fix}. Run /reload to apply it.`, level: 'warning' })
  for (const source of order.overrides) messages.push({ text: overrideWarning(source), level: 'warning' })
  return messages
}
