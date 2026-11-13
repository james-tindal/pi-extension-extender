import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareUpstream, UpdateSkipped } from "./prepare-upstream.ts";
import type { Run } from "./add-package.ts";

const URL = "https://github.com/carderne/pi-sandbox.git";

// Answers are keyed by "command arg arg". A key ending in "*" matches any command starting with that prefix.
function fakeRun(answers: Record<string, string | Error>) {
  const calls: string[] = [];
  const run: Run = async (_cwd, command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const exact = answers[key];
    const prefix = Object.keys(answers).find((pattern) => pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1)));
    const answer = exact ?? (prefix === undefined ? undefined : answers[prefix]);
    if (answer === undefined) throw new Error(`unexpected command: ${key}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { run, calls };
}

const symref = "ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD";

test("prepares a git source: adds the remote, fetches the default branch, and returns its ref", async () => {
  const { run, calls } = fakeRun({
    "git rev-parse --abbrev-ref HEAD": "local",
    "git remote": "origin",
    [`git remote add extension-extender-upstream ${URL}`]: "",
    [`git ls-remote --symref ${URL} HEAD`]: symref,
    "git fetch --no-tags extension-extender-upstream main": "",
  });
  const target = await prepareUpstream({ checkout: "/c", source: "git:github.com/carderne/pi-sandbox", run });
  assert.equal(target, "extension-extender-upstream/main");
  assert.equal(calls.some((call) => call.startsWith("npm")), false);
});

test("updates the existing remote's URL instead of adding it again", async () => {
  const { run, calls } = fakeRun({
    "npm view pi-sandbox repository.url": "git+https://github.com/carderne/pi-sandbox.git",
    "git rev-parse --abbrev-ref HEAD": "local",
    "git remote": "origin\nextension-extender-upstream",
    [`git remote set-url extension-extender-upstream ${URL}`]: "",
    [`git ls-remote --symref ${URL} HEAD`]: symref,
    "git fetch --no-tags extension-extender-upstream main": "",
  });
  await prepareUpstream({ checkout: "/c", source: "npm:pi-sandbox", run });
  assert.equal(calls.some((call) => call.startsWith("git remote add")), false);
});

test("skips with a message when the remote cannot be reached", async () => {
  const { run } = fakeRun({
    "git rev-parse --abbrev-ref HEAD": "local",
    "git remote": "",
    [`git remote add extension-extender-upstream ${URL}`]: "",
    [`git ls-remote --symref ${URL} HEAD`]: new Error("Could not resolve host"),
  });
  await assert.rejects(prepareUpstream({ checkout: "/c", source: "git:github.com/carderne/pi-sandbox", run }), (error) => error instanceof UpdateSkipped && /could not reach .*Could not resolve host/.test(error.message));
});

test("skips with a message on a detached HEAD, without contacting the remote", async () => {
  const { run, calls } = fakeRun({ "git rev-parse --abbrev-ref HEAD": "HEAD" });
  await assert.rejects(prepareUpstream({ checkout: "/c", source: "git:github.com/carderne/pi-sandbox", run }), (error) => error instanceof UpdateSkipped && /detached HEAD/.test(error.message));
  assert.equal(calls.length, 1);
});

test("skips with a message when the default branch cannot be read", async () => {
  const { run } = fakeRun({
    "git rev-parse --abbrev-ref HEAD": "local",
    "git remote": "extension-extender-upstream",
    [`git remote set-url extension-extender-upstream ${URL}`]: "",
    [`git ls-remote --symref ${URL} HEAD`]: "",
  });
  await assert.rejects(prepareUpstream({ checkout: "/c", source: "git:github.com/carderne/pi-sandbox", run }), (error) => error instanceof UpdateSkipped && /default branch/.test(error.message));
});

test("skips with a message when npm cannot be reached for an npm source", async () => {
  const { run, calls } = fakeRun({
    "git rev-parse --abbrev-ref HEAD": "local",
    "npm view pi-sandbox repository.url": new Error("ENOTFOUND registry.npmjs.org"),
  });
  await assert.rejects(prepareUpstream({ checkout: "/c", source: "npm:pi-sandbox", run }), (error) => error instanceof UpdateSkipped && /could not look up npm:pi-sandbox on npm/.test(error.message));
  assert.equal(calls.some((call) => call.startsWith("git remote")), false);
});

test("without a repository URL, commits the latest npm release to the upstream branch when none is recorded", async () => {
  const { run, calls } = fakeRun({
    "git rev-parse --abbrev-ref HEAD": "local",
    "npm view pi-x repository.url": "",
    "npm view pi-x dist-tags.latest": "1.2.0",
    "git branch --list extension-extender-upstream": "",
    "npm pack*": "pi-x-1.2.0.tgz",
    "tar*": "",
    "git --work-tree*": "",
    "git write-tree": "tree1",
    "git commit-tree tree1 -m npm 1.2.0": "c1",
    "git update-ref refs/heads/extension-extender-upstream c1": "",
  });
  const target = await prepareUpstream({ checkout: "/c", source: "npm:pi-x", run });
  assert.equal(target, "extension-extender-upstream");
  assert.equal(calls.some((call) => call.startsWith("git remote")), false);
});

test("without a repository URL, does not commit when the latest npm release is already the branch tip", async () => {
  const { run, calls } = fakeRun({
    "git rev-parse --abbrev-ref HEAD": "local",
    "npm view pi-x repository.url": "",
    "npm view pi-x dist-tags.latest": "1.2.0",
    "git branch --list extension-extender-upstream": "  extension-extender-upstream",
    "git rev-parse extension-extender-upstream": "p0",
    "git log -1 --format=%s extension-extender-upstream": "npm 1.2.0",
  });
  const target = await prepareUpstream({ checkout: "/c", source: "npm:pi-x", run });
  assert.equal(target, "extension-extender-upstream");
  assert.equal(calls.some((call) => call.startsWith("npm pack")), false);
});

test("without a repository URL, commits a newer release on top of the branch tip", async () => {
  const { run, calls } = fakeRun({
    "git rev-parse --abbrev-ref HEAD": "local",
    "npm view pi-x repository.url": "",
    "npm view pi-x dist-tags.latest": "1.2.0",
    "git branch --list extension-extender-upstream": "  extension-extender-upstream",
    "git rev-parse extension-extender-upstream": "p0",
    "git log -1 --format=%s extension-extender-upstream": "npm 1.1.0",
    "npm pack*": "pi-x-1.2.0.tgz",
    "tar*": "",
    "git --work-tree*": "",
    "git write-tree": "tree2",
    "git commit-tree tree2 -p p0 -m npm 1.2.0": "c2",
    "git update-ref refs/heads/extension-extender-upstream c2": "",
  });
  await prepareUpstream({ checkout: "/c", source: "npm:pi-x", run });
  assert.equal(calls.includes("git commit-tree tree2 -p p0 -m npm 1.2.0"), true);
});

test("skips with a message when npm lists no latest version", async () => {
  const { run } = fakeRun({
    "git rev-parse --abbrev-ref HEAD": "local",
    "npm view pi-x repository.url": "",
    "npm view pi-x dist-tags.latest": "",
  });
  await assert.rejects(prepareUpstream({ checkout: "/c", source: "npm:pi-x", run }), (error) => error instanceof UpdateSkipped && /no latest version for pi-x/.test(error.message));
});
