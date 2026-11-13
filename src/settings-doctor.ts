import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const EXTENDER_SOURCES = ['npm:pi-extension-extender', 'git:github.com/james-tindal/pi-extension-extender']

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
  return Array.isArray(settings?.packages) && settings.packages.some((entry) => EXTENDER_SOURCES.includes(sourceOf(entry) ?? ''))
}

export async function addPackageEntry(path: string, source: string): Promise<void> {
  const settings: Settings = (await readSettings(path)) ?? {}
  const packages = Array.isArray(settings.packages) ? settings.packages : []
  packages.push(source)
  settings.packages = packages
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`)
}

export const overrideBrief = (source: string): string => `${source} is loaded from global settings before the local override`

export const overrideWarning = (source: string): string => `${source} loads from global settings before local extension-extender can load. Run /extension-extender install-global to enable your package override`

export async function orderExtenderBeforeCovered({ agentDir, cwd, isCovered, hasOverride }: {
  agentDir: string
  cwd: string
  isCovered: (source: string, scope: 'user' | 'project') => boolean
  hasOverride: (source: string) => Promise<boolean>
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
    const extenderIndex = packages.findIndex((entry) => EXTENDER_SOURCES.includes(sourceOf(entry) ?? ''))
    if (extenderIndex === -1) continue
    listed[scope] = true
    const coveredIndex = packages.findIndex((entry) => !EXTENDER_SOURCES.includes(sourceOf(entry) ?? '') && isCovered(sourceOf(entry) ?? '', scope))
    if (coveredIndex === -1 || coveredIndex > extenderIndex) continue
    const [extender] = packages.splice(extenderIndex, 1)
    packages.splice(coveredIndex, 0, extender)
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`)
    fixes.push(`moved extension-extender above ${sourceOf(packages[coveredIndex + 1])} in ${path}`)
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
