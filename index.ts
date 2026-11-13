import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readlink, rm, symlink, lstat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { overrideBrief, overrideWarning } from "./settings-doctor.ts";
import { addCommand, coveredBy, installDependencies, orderCheck, overridden, packageSetup } from "./add-package.ts";
import { run, upstreamFor } from "./prepare-upstream.ts";
import { progress } from "./progress.ts";

async function update({ checkout, source, report, installDependencies }: {
  checkout: string;
  source: string;
  report: (stage: string, done?: boolean) => void;
  installDependencies: (cwd: string) => Promise<void>;
}) {
  report("checking repository");
  const git = (args: string[]) => run(checkout, "git", args);
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (realpathSync(top) !== realpathSync(checkout)) {
    throw new Error(`${checkout} is not a standalone repository.`);
  }
  const gitDir = await git(["rev-parse", "--absolute-git-dir"]);
  const lock = join(gitDir, "extension-extender.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    for (const state of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
      if (existsSync(join(gitDir, state))) throw new Error(`${checkout} has an unfinished Git operation.`);
    }
    const target = await upstreamFor({ checkout, source, run });
    if (target === undefined) return;
    const before = await git(["rev-parse", "HEAD"]);
    if (target !== undefined && await git(["rev-list", "--count", `HEAD..${target}`]) !== "0") {
      report(`rebasing onto ${target}`);
      try {
        await git(["-c", "rebase.updateRefs=false", "rebase", target]);
      } catch (error) {
        if (!(await git(["diff", "--name-only", "--diff-filter=U"]))) throw error;
        await git(["rebase", "--abort"]);
        report(`Rebase conflict. Update skipped. To resolve: \`cd ${checkout}; git rebase ${target}\``, true);
        return;
      }
    }
    const updated = before !== await git(["rev-parse", "HEAD"]);
    if (!existsSync(join(checkout, "node_modules")) || updated) {
      report("installing dependencies");
      await installDependencies(checkout);
    }
    report(updated ? "updated" : "already up to date", true);
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
    // The package manager relinked it on reinstall; take it back.
    report("relinking installed package to local checkout");
    await unlink(installed);
    await symlink(checkout, installed, "dir");
    return;
  }
  report("redirecting installed package to local checkout");
  await rm(installed, { recursive: true });
  await symlink(checkout, installed, "dir");
}

export default async function extensionExtender(pi: ExtensionAPI) {
  try {
    const { agentDir, root, packages } = await packageSetup(process.cwd());
    pi.registerCommand("extension-extender", {
      description: "Run extension-extender: doctor, or add <git:|npm:>",
      handler: async (args, ctx) => {
        const tokens = args.trim().split(/\s+/);
        const [subcommand] = tokens;
        if (subcommand === "install-global") {
          await packages.install("npm:pi-extension-extender");
          await orderCheck({ agentDir, cwd: process.cwd(), root, packages });
          await ctx.reload();
          return;
        }
        if (subcommand === "add") {
          for (const message of await addCommand({ tokens, root, agentDir, cwd: process.cwd(), packages })) ctx.ui.notify(message.text, message.level);
          return;
        }
        throw new Error("Usage: /extension-extender add [-l|--local] <git:|npm:> | /extension-extender install-global");
      },
    });
    const installed = packages.listConfiguredPackages();
    const order = await orderCheck({ agentDir, cwd: process.cwd(), root, packages });
    for (const fix of order.fixes) pi.on("session_start", (_event, ctx) => ctx.ui.notify(`${fix}. Run /reload to apply it.`, "warning"));
    const skipUpdate = new Set(order.overrides.map((source) => {
      const entry = installed.find((item) => item.source === source && item.scope === "user");
      if (entry?.installedPath === undefined) throw new Error(`${source} has no installed path`);
      return basename(entry.installedPath);
    }));
    for (const source of order.overrides) {
      console.error(`extension-extender: ${overrideBrief(source)}`);
      pi.on("session_start", (_event, ctx) => ctx.ui.notify(overrideWarning(source), "warning"));
    }
    for (const folder of await readdir(root, { withFileTypes: true })) {
      if (!folder.isDirectory() || folder.name.startsWith(".")) continue;
      const checkout = join(root, folder.name);
      const report = (stage: string, done = false) => progress(`${folder.name}: ${stage}`, done);
      const source = installed.find((entry) => entry.installedPath && basename(entry.installedPath) === folder.name)?.source;
      if (source === undefined) report("No matching package found. Cannot check for updates.", true);
      if (!skipUpdate.has(folder.name) && source !== undefined) await update({
        checkout,
        source,
        report,
        installDependencies: (cwd) => installDependencies(packages, cwd),
      });
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
    }
  } catch (error) {
    progress();
    console.error("extension-extender: startup failed", error);
    process.exit(1);
  }
}
