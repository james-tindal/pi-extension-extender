import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareUpstream, UpdateSkipped } from "./prepare-upstream.ts";
import type { Run } from "./add-package.ts";

const URL = "https://github.com/carderne/pi-sandbox.git";

function fakeRun(answers: Record<string, string | Error>) {
  const calls: string[] = [];
  const run: Run = async (_cwd, command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const answer = answers[key];
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

test("skips with a message when npm lists no repository.url", async () => {
  const { run, calls } = fakeRun({ "npm view pi-ghsearch repository.url": "" });
  await assert.rejects(prepareUpstream({ checkout: "/c", source: "npm:pi-ghsearch", run }), (error) => error instanceof UpdateSkipped && /lists no repository.url/.test(error.message));
  assert.deepEqual(calls, ["npm view pi-ghsearch repository.url"]);
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
