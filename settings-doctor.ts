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

export const overrideBrief = (source: string): string => `${source} is loaded from global settings before the local override`;

export const overrideWarning = (source: string): string => `${source} loads from global settings before local extension-extender can load. Run /extension-extender install-global to enable your package override`;

export async function orderExtenderBeforeCovered({ agentDir, cwd, isCovered, hasOverride }: {
  agentDir: string;
  cwd: string;
  isCovered: (source: string, scope: "user" | "project") => boolean;
  hasOverride: (source: string) => Promise<boolean>;
}): Promise<{ fixes: string[]; overrides: string[]; listed: boolean }> {
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const fixes: string[] = [];
  const overrides: string[] = [];
  const listed = { user: false, project: false };
  for (const [path, scope] of [[globalPath, "user"], [projectPath, "project"]] as const) {
    const settings = await readSettings(path);
    if (!settings || !Array.isArray(settings.packages)) continue;
    const packages = settings.packages;
    const extenderIndex = packages.findIndex((entry) => EXTENDER_SOURCES.includes(sourceOf(entry) ?? ""));
    if (extenderIndex === -1) continue;
    listed[scope] = true;
    const coveredIndex = packages.findIndex((entry) => !EXTENDER_SOURCES.includes(sourceOf(entry) ?? "") && isCovered(sourceOf(entry) ?? "", scope));
    if (coveredIndex === -1 || coveredIndex > extenderIndex) continue;
    const [extender] = packages.splice(extenderIndex, 1);
    packages.splice(coveredIndex, 0, extender);
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
    fixes.push(`moved extension-extender above ${sourceOf(packages[coveredIndex + 1])} in ${path}`);
  }
  if (listed.project && !listed.user) {
    const globalSettings = await readSettings(globalPath);
    const globalPackages = Array.isArray(globalSettings?.packages) ? globalSettings.packages : [];
    for (const entry of globalPackages) {
      const source = sourceOf(entry);
      if (source === undefined || !isCovered(source, "user") || !(await hasOverride(source))) continue;
      overrides.push(source);
    }
  }
  return { fixes, overrides, listed: listed.user || listed.project };
}

export async function doctor({ agentDir, cwd, report, isCovered, hasOverride }: {
  agentDir: string;
  cwd: string;
  report: (message: string) => void;
  isCovered: (source: string, scope: "user" | "project") => boolean;
  hasOverride: (source: string) => Promise<boolean>;
}) {
  const order = await orderExtenderBeforeCovered({ agentDir, cwd, isCovered, hasOverride });
  for (const message of order.fixes) report(message);
  for (const source of order.overrides) report(overrideWarning(source));
  if (!order.listed) report("extension-extender is not listed in any settings.json");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("extension-extender: covered packages are only known inside Pi, so ordering is not checked here; use /extension-extender doctor");
  await doctor({
    agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    cwd: process.cwd(),
    report: (message) => console.log(message),
    isCovered: () => false,
    hasOverride: async () => false,
  });
}
