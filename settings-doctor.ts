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

export async function doctor({ agentDir, cwd, report }: {
  agentDir: string;
  cwd: string;
  report: (message: string) => void;
}) {
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const globalSettings = await readSettings(globalPath);
  const projectSettings = await readSettings(projectPath);
  let found = false;
  for (const [path, settings] of [[globalPath, globalSettings], [projectPath, projectSettings]] as const) {
    if (!settings || !Array.isArray(settings.packages)) continue;
    const packages = settings.packages;
    const index = packages.findIndex((entry) => EXTENDER_SOURCES.includes(sourceOf(entry) ?? ""));
    if (index === -1) continue;
    found = true;
    if (index !== 0) {
      packages.unshift(...packages.splice(index, 1));
      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
      report(`moved extension-extender to the top of ${path}`);
    }
  }
  if (!found) report("extension-extender is not listed in any settings.json");
  if (projectSettings && Array.isArray(projectSettings.packages) && projectSettings.packages.some((entry) => EXTENDER_SOURCES.includes(sourceOf(entry) ?? "")) && Array.isArray(globalSettings?.packages) && globalSettings.packages.length > 0) {
    report("extension-extender is in project settings, so global packages load before it; move it to the global settings.json");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await doctor({
    agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    cwd: process.cwd(),
    report: (message) => console.log(message),
  });
}
