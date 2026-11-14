import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { existsSync, realpathSync } from 'node:fs'
import { link, mkdir, readdir, readFile, readlink, rm, symlink, lstat, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { overrideWarning } from './settings-doctor.ts'
import { addCommand, coveredBy, folderOf, installDependencies, orderCheck, overridden, packageSetup } from './add-package.ts'
import { run, upstreamFor } from './prepare-upstream.ts'
import { progress, statusBoard } from './progress.ts'

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function acquireLock(lock: string, report: (stage: string) => void) {
  const pending = `${lock}.${process.pid}`
  await writeFile(pending, String(process.pid))
  let waiting = false
  try {
    for (;;) {
      try {
        await link(pending, lock)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const owner = Number(await readFile(lock, 'utf8').catch(() => ''))
      if (Number.isInteger(owner) && owner > 0 && processAlive(owner)) {
        if (!waiting) report(`waiting for process ${owner} to complete the update`)
        waiting = true
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      await rm(lock, { recursive: true, force: true })
    }
  } finally {
    await rm(pending, { force: true })
  }
}

async function update({ checkout, source, report, warn, installDependencies }: {
  checkout: string
  source: string
  report: (stage: string, done?: boolean) => void
  warn: (message: string) => void
  installDependencies: (cwd: string) => Promise<void>
}) {
  report('checking repository')
  const git = (args: string[]) => run(checkout, 'git', args)
  const top = await git(['rev-parse', '--show-toplevel'])
  if (realpathSync(top) !== realpathSync(checkout)) {
    throw new Error(`${checkout} is not a standalone repository.`)
  }
  const gitDir = await git(['rev-parse', '--absolute-git-dir'])
  const lock = join(gitDir, 'extension-extender.lock')
  await acquireLock(lock, report)
  try {
    for (const state of ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
      if (existsSync(join(gitDir, state))) throw new Error(`${checkout} has an unfinished Git operation.`)
    }
    const target = await upstreamFor({ checkout, source, run })
    if (typeof target !== 'string') {
      report(`Update skipped: ${target.skipped}`, true)
      return
    }
    const before = await git(['rev-parse', 'HEAD'])
    if (await git(['rev-list', '--count', `HEAD..${target}`]) !== '0') {
      report(`rebasing onto ${target}`)
      try {
        await git(['-c', 'rebase.updateRefs=false', 'rebase', target])
      } catch (error) {
        if (!(await git(['diff', '--name-only', '--diff-filter=U']))) throw error
        await git(['rebase', '--abort'])
        report('Rebase conflict. Update skipped.', true)
        warn(`${basename(checkout)}: Rebase conflict. To resolve: \`cd ${checkout}; git rebase ${target}\``)
        return
      }
    }
    const updated = before !== await git(['rev-parse', 'HEAD'])
    if (!existsSync(join(checkout, 'node_modules')) || updated) {
      report('installing dependencies')
      await installDependencies(checkout)
    }
    report(updated ? 'updated' : 'already up to date', true)
  } finally {
    await rm(lock, { force: true })
  }
}

async function redirect({ installed, checkout }: {
  installed: string
  checkout: string
}) {
  if (resolve(installed) === resolve(checkout)) return
  const stat = await lstat(installed)
  if (stat.isSymbolicLink()) {
    const target = resolve(installed, '..', await readlink(installed))
    if (realpathSync(target) === realpathSync(checkout)) return
    // The package manager relinked it on reinstall; take it back.
    await unlink(installed)
    await symlink(checkout, installed, 'dir')
    return
  }
  await rm(installed, { recursive: true })
  await symlink(checkout, installed, 'dir')
}

export default async function extensionExtender(pi: ExtensionAPI) {
  try {
    const { agentDir, root, packages } = await packageSetup(process.cwd())
    pi.registerCommand('extension-extender', {
      description: 'Run extension-extender: doctor, or add <git:|npm:>',
      handler: async (args, ctx) => {
        const tokens = args.trim().split(/\s+/)
        const [subcommand] = tokens
        if (subcommand === 'add') {
          for (const message of await addCommand({ tokens, root, agentDir, cwd: process.cwd(), packages })) ctx.ui.notify(message.text, message.level)
          return
        }
        throw new Error('Usage: /extension-extender add [-l|--local] <git:|npm:>')
      },
    })
    const installed = packages.listConfiguredPackages()
    const order = await orderCheck({ agentDir, cwd: process.cwd(), root, packages })
    const warnings: string[] = []
    pi.on('session_start', (_event, ctx) => {
      if (warnings.length) ctx.ui.notify(['extension-extender', ...warnings.flatMap((warning) => warning.split('\n').map((line) => `  ${line}`))].join('\n'), 'warning')
    })
    for (const fix of order.fixes) warnings.push(fix)
    const skipUpdate = new Set(order.overrides.map((source) => folderOf(installed)(source, 'user')))
    for (const name of skipUpdate) warnings.push(overrideWarning(name))
    const folders = (await readdir(root, { withFileTypes: true })).filter((folder) => folder.isDirectory() && !folder.name.startsWith('.'))
    const board = statusBoard([...folders.map((folder) => folder.name), ''])
    let previousLoad: Promise<void> = Promise.resolve()
    let loaded = 0
    const showLoaded = () => board('', `${loaded}/${folders.length} packages loaded`)
    showLoaded()
    await Promise.all(folders.map((folder) => {
      const checkout = join(root, folder.name)
      const report = (stage: string) => board(folder.name, stage)
      const source = installed.find((entry) => entry.installedPath && basename(entry.installedPath) === folder.name)?.source
      if (source === undefined) {
        report('No matching package found. Cannot check for updates.')
        warnings.push(`${folder.name}: found override repository but no matching package in settings.json. Add a matching package to enable updating your override from upstream`)
      }
      if (skipUpdate.has(folder.name)) report('Package loaded before extension-extender')
      const before = previousLoad
      const load = (async () => {
        if (!skipUpdate.has(folder.name) && source !== undefined) {
          try {
            await update({
              checkout,
              source,
              report,
              warn: (message) => warnings.push(message),
              installDependencies: (cwd) => installDependencies(packages, cwd),
            })
          } catch (error) {
            report(`update failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        await before
        try {
          const matches = installed.filter((entry) => entry.installedPath && basename(entry.installedPath) === folder.name)
          if (matches.length) {
            for (const match of matches) await redirect({ installed: match.installedPath!, checkout })
          } else {
            const resources = await packages.resolveExtensionSources([checkout])
            for (const resource of resources.extensions) {
              if (!resource.enabled) continue
              const { default: factory } = await import(pathToFileURL(resource.path).href)
              if (typeof factory !== 'function') throw new Error(`${resource.path} does not export an extension factory.`)
              await factory(pi)
            }
          }
          loaded++
          showLoaded()
        } catch (error) {
          const message = `Failed to load extension '${checkout}': ${error instanceof Error ? error.message : String(error)}`
          report(message)
          pi.on('session_start', (_event, ctx) => ctx.ui.notify(message, 'error'))
        }
      })()
      previousLoad = load
      return load
    }))
    board('', `${loaded}/${folders.length} packages loaded. Done`)
  } catch (error) {
    progress()
    console.error('extension-extender: startup failed', error)
    process.exit(1)
  }
}
