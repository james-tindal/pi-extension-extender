import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, orderExtenderBeforeCovered } from "./settings-doctor.ts";

const EXTENDER = "npm:pi-extension-extender";
const GIT_EXTENDER = "git:github.com/james-tindal/pi-extension-extender";

function setup({ global, project }: { global?: string; project?: string }) {
  const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  if (global !== undefined) writeFileSync(join(agentDir, "settings.json"), global);
  if (project !== undefined) {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), project);
  }
  return { agentDir, cwd };
}

async function run(paths: { agentDir: string; cwd: string }, isCovered: (source: string, scope: "user" | "project") => boolean = () => false) {
  const reports: string[] = [];
  await doctor({ ...paths, isCovered, report: (message) => reports.push(message) });
  return reports;
}

test("moves the extender above the covered package in the global settings and keeps the other entries in order", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:a", EXTENDER, { source: "npm:b", filtered: true }] }),
  });
  const reports = await run(paths, (source) => source === "npm:a");
  const settings = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [EXTENDER, "npm:a", { source: "npm:b", filtered: true }]);
  assert.deepEqual(reports, [`moved extension-extender above npm:a in ${join(paths.agentDir, "settings.json")}`]);
});

test("does not move the extender when it already precedes every covered package, even if it is not first", async () => {
  const content = JSON.stringify({ packages: ["npm:x", EXTENDER, "npm:covered"] }, null, 2) + "\n";
  const paths = setup({ global: content });
  const reports = await run(paths, (source) => source === "npm:covered");
  assert.equal(readFileSync(join(paths.agentDir, "settings.json"), "utf8"), content);
  assert.deepEqual(reports, []);
});

test("matches the git source form of the extender", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:a", GIT_EXTENDER] }),
  });
  const reports = await run(paths, (source) => source === "npm:a");
  const settings = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [GIT_EXTENDER, "npm:a"]);
  assert.equal(reports.length, 1);
});

test("reports when the extender is not listed in any settings file", async () => {
  const content = JSON.stringify({ packages: ["npm:a"] });
  const paths = setup({ global: content });
  const reports = await run(paths);
  assert.equal(readFileSync(join(paths.agentDir, "settings.json"), "utf8"), content);
  assert.deepEqual(reports, ["extension-extender is not listed in any settings.json"]);
});

test("moves the extender above covered packages in project settings and warns when global packages load before it", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:x"] }),
    project: JSON.stringify({ packages: ["npm:z", EXTENDER] }),
  });
  const reports = await run(paths, (source) => source === "npm:z");
  const project = JSON.parse(readFileSync(join(paths.cwd, ".pi", "settings.json"), "utf8"));
  assert.deepEqual(project.packages, [EXTENDER, "npm:z"]);
  assert.deepEqual(reports, [
    `moved extension-extender above npm:z in ${join(paths.cwd, ".pi", "settings.json")}`,
    "extension-extender is in project settings, so global packages load before it; move it to the global settings.json",
  ]);
});

test("does not warn when the extender is in project settings and no global packages exist", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: [] }),
    project: JSON.stringify({ packages: [EXTENDER] }),
  });
  const reports = await run(paths);
  assert.deepEqual(reports, []);
});

test("throws on invalid settings JSON instead of skipping the file", async () => {
  const paths = setup({ global: "{" });
  await assert.rejects(run(paths), SyntaxError);
});

test("places the extender directly above the first covered entry in the global settings", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:a", "npm:covered", "npm:b", EXTENDER] }),
  });
  const fixes = await orderExtenderBeforeCovered({ ...paths, isCovered: (source, scope) => scope === "user" && source === "npm:covered" });
  const settings = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, ["npm:a", EXTENDER, "npm:covered", "npm:b"]);
  assert.deepEqual(fixes, [`moved extension-extender above npm:covered in ${join(paths.agentDir, "settings.json")}`]);
});

test("does not change settings when the extender already precedes every covered entry", async () => {
  const content = JSON.stringify({ packages: ["npm:a", EXTENDER, "npm:covered"] }, null, 2) + "\n";
  const paths = setup({ global: content });
  const fixes = await orderExtenderBeforeCovered({ ...paths, isCovered: (source) => source === "npm:covered" });
  assert.equal(readFileSync(join(paths.agentDir, "settings.json"), "utf8"), content);
  assert.deepEqual(fixes, []);
});

test("checks the project settings with the project scope", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:covered"] }),
    project: JSON.stringify({ packages: ["npm:covered", EXTENDER] }),
  });
  const fixes = await orderExtenderBeforeCovered({ ...paths, isCovered: (source, scope) => scope === "project" && source === "npm:covered" });
  const project = JSON.parse(readFileSync(join(paths.cwd, ".pi", "settings.json"), "utf8"));
  assert.deepEqual(project.packages, [EXTENDER, "npm:covered"]);
  assert.equal(fixes.length, 1);
});
