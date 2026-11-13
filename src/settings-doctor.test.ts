import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderExtenderBeforeCovered } from "./settings-doctor.ts";

const EXTENDER = "npm:pi-extension-extender";
const GIT_EXTENDER = "git:github.com/james-tindal/pi-extension-extender";
const noOverride = async () => false;

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

async function order(
  paths: { agentDir: string; cwd: string },
  isCovered: (source: string, scope: "user" | "project") => boolean = () => false,
  hasOverride: (source: string) => Promise<boolean> = noOverride,
) {
  return orderExtenderBeforeCovered({ ...paths, isCovered, hasOverride });
}

test("moves the extender above the covered package in the global settings and keeps the other entries in order", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:a", EXTENDER, { source: "npm:b", filtered: true }] }),
  });
  const { fixes } = await order(paths, (source) => source === "npm:a");
  const settings = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [EXTENDER, "npm:a", { source: "npm:b", filtered: true }]);
  assert.deepEqual(fixes, [`moved extension-extender above npm:a in ${join(paths.agentDir, "settings.json")}`]);
});

test("does not move the extender when it already precedes every covered package, even if it is not first", async () => {
  const content = JSON.stringify({ packages: ["npm:x", EXTENDER, "npm:covered"] }, null, 2) + "\n";
  const paths = setup({ global: content });
  const { fixes } = await order(paths, (source) => source === "npm:covered");
  assert.equal(readFileSync(join(paths.agentDir, "settings.json"), "utf8"), content);
  assert.deepEqual(fixes, []);
});

test("matches the git source form of the extender", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:a", GIT_EXTENDER] }),
  });
  const { fixes } = await order(paths, (source) => source === "npm:a");
  const settings = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [GIT_EXTENDER, "npm:a"]);
  assert.equal(fixes.length, 1);
});

test("never treats the extender itself as a covered package", async () => {
  const content = JSON.stringify({ packages: [EXTENDER] });
  const paths = setup({ global: content });
  const { fixes } = await order(paths, () => true);
  assert.equal(readFileSync(join(paths.agentDir, "settings.json"), "utf8"), content);
  assert.deepEqual(fixes, []);
});

test("moves the extender above covered packages in project settings", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:x"] }),
    project: JSON.stringify({ packages: ["npm:z", EXTENDER] }),
  });
  const { fixes, overrides } = await order(paths, (source, scope) => scope === "project" && source === "npm:z");
  const project = JSON.parse(readFileSync(join(paths.cwd, ".pi", "settings.json"), "utf8"));
  assert.deepEqual(project.packages, [EXTENDER, "npm:z"]);
  assert.deepEqual(fixes, [`moved extension-extender above npm:z in ${join(paths.cwd, ".pi", "settings.json")}`]);
  assert.deepEqual(overrides, []);
});

test("reports no override when the extender is in project settings and no global package is covered", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: [] }),
    project: JSON.stringify({ packages: [EXTENDER] }),
  });
  const { fixes, overrides } = await order(paths, () => true, async () => true);
  assert.deepEqual(fixes, []);
  assert.deepEqual(overrides, []);
});

test("reports an override when a covered global package with local changes loads before a project-only extender, and leaves the settings alone", async () => {
  const projectContent = JSON.stringify({ packages: [EXTENDER] });
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:covered"] }),
    project: projectContent,
  });
  const { overrides } = await order(paths, (source, scope) => scope === "user" && source === "npm:covered", async () => true);
  assert.equal(readFileSync(join(paths.cwd, ".pi", "settings.json"), "utf8"), projectContent);
  assert.deepEqual(overrides, ["npm:covered"]);
});

test("reports no override for a covered global package whose checkout has no local changes", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:covered"] }),
    project: JSON.stringify({ packages: [EXTENDER] }),
  });
  const { overrides } = await order(paths, (source, scope) => scope === "user" && source === "npm:covered", async () => false);
  assert.deepEqual(overrides, []);
});

test("throws on invalid settings JSON instead of skipping the file", async () => {
  const paths = setup({ global: "{" });
  await assert.rejects(order(paths), SyntaxError);
});

test("places the extender directly above the first covered entry in the global settings", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:a", "npm:covered", "npm:b", EXTENDER] }),
  });
  const { fixes } = await order(paths, (source, scope) => scope === "user" && source === "npm:covered");
  const settings = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, ["npm:a", EXTENDER, "npm:covered", "npm:b"]);
  assert.deepEqual(fixes, [`moved extension-extender above npm:covered in ${join(paths.agentDir, "settings.json")}`]);
});

test("checks the project settings with the project scope", async () => {
  const paths = setup({
    global: JSON.stringify({ packages: ["npm:covered"] }),
    project: JSON.stringify({ packages: ["npm:covered", EXTENDER] }),
  });
  const { fixes } = await order(paths, (source, scope) => scope === "project" && source === "npm:covered");
  const project = JSON.parse(readFileSync(join(paths.cwd, ".pi", "settings.json"), "utf8"));
  assert.deepEqual(project.packages, [EXTENDER, "npm:covered"]);
  assert.equal(fixes.length, 1);
});
