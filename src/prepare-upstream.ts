import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { progress } from './progress.ts'

const exec = promisify(execFile)

export const REMOTE = 'extension-extender-upstream'

export async function run(cwd: string, command: string, args: string[], env: Record<string, string> = {}) {
  const { stdout } = await exec(command, args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', ...env },
  })
  return stdout.trim()
}

export type Run = (cwd: string, command: string, args: string[], env?: Record<string, string>) => Promise<string>

export const npmPackageName = (source: string): string => source.slice('npm:'.length).replace(/@[^@/]+$/, '')

export async function npmRepositoryUrl(run: Run, root: string, source: string): Promise<string> {
  return run(root, 'npm', ['view', npmPackageName(source), 'repository.url'])
}

export class UpdateSkipped extends Error {}

async function network<T>(message: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw new UpdateSkipped(`${message}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const author = {
  GIT_AUTHOR_NAME: 'extension-extender',
  GIT_AUTHOR_EMAIL: 'extension-extender@localhost',
  GIT_COMMITTER_NAME: 'extension-extender',
  GIT_COMMITTER_EMAIL: 'extension-extender@localhost',
}

async function commitNpmRelease({ checkout, name, version, parent, run }: {
  checkout: string
  name: string
  version: string
  parent: string | undefined
  run: Run
}) {
  const dir = await mkdtemp(join(tmpdir(), 'extension-extender-npm-'))
  try {
    const tarball = await network(`could not download ${name}@${version}`, async () => {
      const output = await run(dir, 'npm', ['pack', `${name}@${version}`, '--pack-destination', dir])
      return output.split('\n').at(-1) ?? ''
    })
    await run(dir, 'tar', ['-xzf', join(dir, tarball), '-C', dir])
    const env = { GIT_INDEX_FILE: join(dir, 'index'), ...author }
    await run(checkout, 'git', ['--work-tree', join(dir, 'package'), 'add', '-A'], env)
    const tree = await run(checkout, 'git', ['write-tree'], env)
    const commit = await run(checkout, 'git', ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `npm ${version}`], env)
    await run(checkout, 'git', ['update-ref', `refs/heads/${REMOTE}`, commit])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function npmFallback({ checkout, source, run }: {
  checkout: string
  source: string
  run: Run
}): Promise<string> {
  const name = npmPackageName(source)
  const latest = await network(`could not reach npm for ${name}`, () => run(checkout, 'npm', ['view', name, 'dist-tags.latest']))
  if (latest === '') throw new UpdateSkipped(`npm lists no latest version for ${name}`)
  const exists = (await run(checkout, 'git', ['branch', '--list', REMOTE])) !== ''
  const parent = exists ? await run(checkout, 'git', ['rev-parse', REMOTE]) : undefined
  const last = exists ? await run(checkout, 'git', ['log', '-1', '--format=%s', REMOTE]) : ''
  if (last !== `npm ${latest}`) {
    await commitNpmRelease({ checkout, name, version: latest, parent, run })
  }
  return REMOTE
}

export async function upstreamFor({ checkout, source, run }: {
  checkout: string
  source: string
  run: Run
}) {
  try {
    return await prepareUpstream({ checkout, source, run })
  } catch (error) {
    if (error instanceof UpdateSkipped) {
      progress(`${basename(checkout)}: ${error.message}`, true)
      return undefined
    }
    throw error
  }
}

export async function prepareUpstream({ checkout, source, run }: {
  checkout: string
  source: string
  run: Run
}): Promise<string> {
  const branch = await run(checkout, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'HEAD') throw new UpdateSkipped('detached HEAD; check out a branch to update')
  const repository = source.startsWith('git:')
    ? `https://${source.slice('git:'.length)}.git`
    : await network(`could not look up ${source} on npm`, () => npmRepositoryUrl(run, checkout, source))
  if (repository === '') return npmFallback({ checkout, source, run })
  const url = repository.replace(/^git\+/, '')
  const remotes = (await run(checkout, 'git', ['remote'])).split('\n')
  await run(checkout, 'git', remotes.includes(REMOTE) ? ['remote', 'set-url', REMOTE, url] : ['remote', 'add', REMOTE, url])
  const listing = await network(`could not reach ${url}`, () => run(checkout, 'git', ['ls-remote', '--symref', url, 'HEAD']))
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listing)
  if (!match) throw new UpdateSkipped(`could not read the default branch of ${url}`)
  const defaultBranch = match[1]
  await network(`could not fetch ${defaultBranch} from ${url}`, () => run(checkout, 'git', ['fetch', '--no-tags', REMOTE, defaultBranch]))
  return `${REMOTE}/${defaultBranch}`
}
