import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const EXTENDER_SOURCES = ["npm:pi-extension-extender", "git:github.com/james-tindal/pi-extension-extender"];

type Settings = { packages?: unknown } & Record<string, unknown>;

async function readSettings(path: string): Promise<Settings | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf8"));
}

function sourceOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null && "source" in entry && typeof entry.source === "string") return entry.source;
  return undefined;
}

export async function doctor({ agentDir, cwd, report, isCovered }: {
  agentDir: string;
  cwd: string;
  report: (message: string) => void;
  isCovered: (source: string, scope: "user" | "project") => boolean;
}) {
  for (const fix of await orderExtenderBeforeCovered({ agentDir, cwd, isCovered })) report(fix);
  const globalSettings = await readSettings(join(agentDir, "settings.json"));
  const projectSettings = await readSettings(join(cwd, ".pi", "settings.json"));
  const entriesOf = (settings: Settings | undefined): unknown[] => (Array.isArray(settings?.packages) ? settings.packages : []);
  const listsExtender = (entries: unknown[]) => entries.some((entry) => EXTENDER_SOURCES.includes(sourceOf(entry) ?? ""));
  const globalEntries = entriesOf(globalSettings);
  const projectEntries = entriesOf(projectSettings);
  if (!listsExtender(globalEntries) && !listsExtender(projectEntries)) report("extension-extender is not listed in any settings.json");
  if (listsExtender(projectEntries) && globalEntries.length > 0) {
    report("extension-extender is in project settings, so global packages load before it; move it to the global settings.json");
  }
}

export async function orderExtenderBeforeCovered({ agentDir, cwd, isCovered }: {
  agentDir: string;
  cwd: string;
  isCovered: (source: string, scope: "user" | "project") => boolean;
}): Promise<string[]> {
  const fixes: string[] = [];
  for (const [path, scope] of [[join(agentDir, "settings.json"), "user"], [join(cwd, ".pi", "settings.json"), "project"]] as const) {
    const settings = await readSettings(path);
    if (!settings || !Array.isArray(settings.packages)) continue;
    const packages = settings.packages;
    const extenderIndex = packages.findIndex((entry) => EXTENDER_SOURCES.includes(sourceOf(entry) ?? ""));
    if (extenderIndex === -1) continue;
    const coveredIndex = packages.findIndex((entry) => isCovered(sourceOf(entry) ?? "", scope));
    if (coveredIndex === -1 || coveredIndex > extenderIndex) continue;
    const [extender] = packages.splice(extenderIndex, 1);
    packages.splice(coveredIndex, 0, extender);
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
    fixes.push(`moved extension-extender above ${sourceOf(packages[coveredIndex + 1])} in ${path}`);
  }
  return fixes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("extension-extender: covered packages are only known inside Pi, so ordering is not checked here; use /extension-extender doctor");
  await doctor({
    agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    cwd: process.cwd(),
    report: (message) => console.log(message),
    isCovered: () => false,
  });
}
