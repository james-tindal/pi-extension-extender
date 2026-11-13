import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { addPackageEntry, hasEntry, listsExtender } from "./settings-doctor.ts";

export type Run = (cwd: string, command: string, args: string[]) => Promise<string>;

export async function npmRepository(run: Run, root: string, source: string) {
  const name = source.slice("npm:".length).replace(/@[^@/]+$/, "");
  const repository = await run(root, "npm", ["view", name, "repository.url"]);
  if (!repository) throw new Error(`${name} lists no repository.url on npm`);
  return repository.replace(/^git\+/, "");
}

export async function addPackage({ tokens, root, agentDir, cwd, run, checkOrder }: {
  tokens: string[];
  root: string;
  agentDir: string;
  cwd: string;
  run: Run;
  checkOrder: () => Promise<void>;
}) {
  const local = tokens.includes("-l") || tokens.includes("--local");
  const source = tokens.find((token) => token.startsWith("git:") || token.startsWith("npm:"));
  if (!source) throw new Error("Usage: /extension-extender add [-l|--local] <git:|npm:>");
  const globalPath = join(agentDir, "settings.json");
  const targetPath = local ? join(cwd, ".pi", "settings.json") : globalPath;
  if (!local && !(await listsExtender(globalPath))) {
    throw new Error("extension-extender is not in global settings. Run /extension-extender install-global first, or add with -l.");
  }
  const url = source.startsWith("git:") ? `https://${source.slice("git:".length)}.git` : await npmRepository(run, root, source);
  const name = basename(url).replace(/\.git$/, "");
  const checkout = join(root, name);
  if (existsSync(checkout)) throw new Error(`${checkout} already exists`);
  if (await hasEntry(targetPath, source)) {
    await checkOrder();
    return;
  }
  await addPackageEntry(targetPath, source);
  await run(root, "git", ["clone", url, name]);
  await run(checkout, "git", ["switch", "-c", "local", "--track", "origin/main"]);
  await checkOrder();
}
