import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readlink, rename, rm, symlink, lstat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { clearLine, cursorTo } from "node:readline";

const exec = promisify(execFile);

class RebaseConflict extends Error {}

async function run(cwd: string, command: string, args: string[]) {
  const { stdout } = await exec(command, args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
  });
  return stdout.trim();
}

function progress(message = "", done = false) {
  const line = message ? `extension-extender: ${message}` : "";
  if (process.stderr.isTTY) {
    cursorTo(process.stderr, 0);
    clearLine(process.stderr, 0);
    process.stderr.write(line.slice(0, Math.max(1, process.stderr.columns - 1)));
    if (done) process.stderr.write("\n");
  } else if (message) {
    process.stderr.write(`${line}\n`);
  }
}

async function update({ checkout, report }: { checkout: string; report: (stage: string) => void }) {
  report("checking repository");
  const git = (args: string[]) => run(checkout, "git", args);
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (realpathSync(top) !== realpathSync(checkout)) {
    throw new Error(`${checkout} is not a standalone repository.`);
  }
  const gitDir = await git(["rev-parse", "--absolute-git-dir"]);
  const lock = join(gitDir, "extension-extender.lock");
  await mkdir(lock);
  try {
    if (await git(["status", "--porcelain"])) throw new Error(`${checkout} has uncommitted changes.`);
    for (const state of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
      if (existsSync(join(gitDir, state))) throw new Error(`${checkout} has an unfinished Git operation.`);
    }
    const branch = await git(["symbolic-ref", "--short", "HEAD"]);
    const remote = await git(["config", "--get", `branch.${branch}.remote`]);
    const remoteBranch = await git(["config", "--get", `branch.${branch}.merge`]);
    const upstreamRef = await git(["rev-parse", "--symbolic-full-name", "@{upstream}"]);
    const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const remoteUrl = await git(["remote", "get-url", remote]);
    const github = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(remoteUrl);
    let needsFetch = true;
    if (github) {
      report("checking remote");
      const repository = github.slice(1).map(encodeURIComponent).join("/");
      const ref = remoteBranch.slice("refs/".length).split("/").map(encodeURIComponent).join("/");
      const response = await fetch(`https://api.github.com/repos/${repository}/git/ref/${ref}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "extension-extender" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`GitHub API check failed for ${upstream}: HTTP ${response.status}.`);
      const body = await response.json();
      const sha = body?.object?.sha;
      if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
        throw new Error(`GitHub API returned an invalid commit SHA for ${upstream}.`);
      }
      needsFetch = sha !== await git(["rev-parse", upstreamRef]);
    }
    if (needsFetch) {
      report("fetching remote");
      await git(["fetch", "--no-tags", remote, `+${remoteBranch}:${upstreamRef}`]);
    }
    const before = await git(["rev-parse", "HEAD"]);
    if (await git(["rev-list", "--count", `HEAD..${upstream}`]) !== "0") {
      report(`rebasing ${branch} onto ${upstream}`);
      try {
        await git(["-c", "rebase.updateRefs=false", "rebase", upstream]);
      } catch (error) {
        if (await git(["diff", "--name-only", "--diff-filter=U"])) {
          throw new RebaseConflict(`Rebase conflict in ${checkout}.\nResolve the rebase conflict in that repository, then restart Pi.`);
        }
        throw error;
      }
    }
    const updated = before !== await git(["rev-parse", "HEAD"]);
    if (!existsSync(join(checkout, "node_modules")) || updated) {
      report("installing dependencies");
      await run(checkout, "pnpm", ["install", existsSync(join(checkout, "pnpm-lock.yaml")) ? "--frozen-lockfile" : "--lockfile=false", "--ignore-scripts"]);
    }
    return updated;
  } finally {
    await rm(lock, { recursive: true });
  }
}

async function redirect({ installed, checkout, report }: {
  installed: string;
  checkout: string;
  report: (stage: string) => void;
}) {
  if (resolve(installed) === resolve(checkout)) return;
  const stat = await lstat(installed);
  if (stat.isSymbolicLink()) {
    const target = resolve(installed, "..", await readlink(installed));
    if (realpathSync(target) === realpathSync(checkout)) return;
    throw new Error(`${installed} already links to ${target}.`);
  }
  const backup = `${installed}.extension-extender-original`;
  if (existsSync(backup)) throw new Error(`Refusing to overwrite ${backup}.`);
  report("redirecting installed package to local checkout");
  await rename(installed, backup);
  try {
    await symlink(checkout, installed, "dir");
  } catch (error) {
    await rename(backup, installed);
    throw error;
  }
}

export default async function extensionExtender(pi: ExtensionAPI) {
  try {
    const agentDir = getAgentDir();
    const root = join(agentDir, "extension-extender");
    await mkdir(root, { recursive: true });
    const settingsManager = SettingsManager.create(process.cwd(), agentDir);
    const packages = new DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager });
    const installed = packages.listConfiguredPackages();
    for (const folder of await readdir(root, { withFileTypes: true })) {
      if (!folder.isDirectory() || folder.name.startsWith(".")) continue;
      const checkout = join(root, folder.name);
      const report = (stage: string) => progress(`${folder.name}: ${stage}`);
      const updated = await update({ checkout, report });
      const matches = installed.filter((entry) => entry.installedPath && basename(entry.installedPath) === folder.name);
      if (matches.length) {
        for (const match of matches) await redirect({ installed: match.installedPath!, checkout, report });
      } else {
        report("loading local extension");
        const resources = await packages.resolveExtensionSources([checkout]);
        for (const resource of resources.extensions) {
          if (!resource.enabled) continue;
          const { default: factory } = await import(pathToFileURL(resource.path).href);
          if (typeof factory !== "function") throw new Error(`${resource.path} does not export an extension factory.`);
          await factory(pi);
        }
      }
      progress(`${folder.name}: ${updated ? "updated" : "already up to date"}`, true);
    }
  } catch (error) {
    progress();
    console.error("extension-extender: startup failed", error instanceof RebaseConflict ? error.message : error);
    process.exit(1);
  }
}
