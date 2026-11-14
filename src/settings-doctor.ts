import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const isExtender = (source: string): boolean => source.endsWith('pi-extension-extender')

type Settings = { packages?: unknown } & Record<string, unknown>

async function readSettings(path: string): Promise<Settings | undefined> {
  if (!existsSync(path)) return undefined
  return JSON.parse(await readFile(path, 'utf8'))
}

function sourceOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (typeof entry === 'object' && entry !== null && 'source' in entry && typeof entry.source === 'string') return entry.source
  return undefined
}

export async function hasEntry(path: string, source: string): Promise<boolean> {
  const settings = await readSettings(path)
  return Array.isArray(settings?.packages) && settings.packages.some((entry) => sourceOf(entry) === source)
}

export async function listsExtender(path: string): Promise<boolean> {
  const settings = await readSettings(path)
  return Array.isArray(settings?.packages) && settings.packages.some((entry) => isExtender(sourceOf(entry) ?? ''))
}

export async function addPackageEntry(path: string, source: string): Promise<void> {
  const settings: Settings = (await readSettings(path)) ?? {}
  const packages = Array.isArray(settings.packages) ? settings.packages : []
  packages.push(source)
  settings.packages = packages
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`)
}

export const overrideWarning = (name: string): string => `${name}: couldn't override because it was installed globally but extension-extender is installed locally.\nEither install extension-extender globally or move ${name} from global to local.`

export async function orderExtenderBeforeCovered({ agentDir, cwd, isCovered, hasOverride, nameOf }: {
  agentDir: string
  cwd: string
  isCovered: (source: string, scope: 'user' | 'project') => boolean
  hasOverride: (source: string) => Promise<boolean>
  nameOf: (source: string, scope: 'user' | 'project') => string
}): Promise<{ fixes: string[]; overrides: string[] }> {
  const globalPath = join(agentDir, 'settings.json')
  const projectPath = join(cwd, '.pi', 'settings.json')
  const fixes: string[] = []
  const overrides: string[] = []
  const listed = { user: false, project: false }
  for (const [path, scope] of [[globalPath, 'user'], [projectPath, 'project']] as const) {
    const settings = await readSettings(path)
    if (!settings || !Array.isArray(settings.packages)) continue
    const packages = settings.packages
    const extenderIndex = packages.findIndex((entry) => isExtender(sourceOf(entry) ?? ''))
    if (extenderIndex === -1) continue
    listed[scope] = true
    const coveredIndex = packages.findIndex((entry) => !isExtender(sourceOf(entry) ?? '') && isCovered(sourceOf(entry) ?? '', scope))
    if (coveredIndex === -1 || coveredIndex > extenderIndex) continue
    const [extender] = packages.splice(extenderIndex, 1)
    packages.splice(coveredIndex, 0, extender)
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`)
    fixes.push(`${nameOf(sourceOf(packages[coveredIndex + 1]) ?? '', scope)}: Run /reload to enable the override. (Moved extension-extender above it in ${path})`)
  }
  if (listed.project && !listed.user) {
    const globalSettings = await readSettings(globalPath)
    const globalPackages = Array.isArray(globalSettings?.packages) ? globalSettings.packages : []
    for (const entry of globalPackages) {
      const source = sourceOf(entry)
      if (source === undefined || !isCovered(source, 'user') || !(await hasOverride(source))) continue
      overrides.push(source)
    }
  }
  return { fixes, overrides }
}
