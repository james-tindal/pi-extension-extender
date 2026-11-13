import { npmRepository, type Run } from "./add-package.ts";

export const REMOTE = "extension-extender-upstream";

export class UpdateSkipped extends Error {}

async function network<T>(message: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new UpdateSkipped(`${message}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function prepareUpstream({ checkout, source, run }: {
  checkout: string;
  source: string;
  run: Run;
}): Promise<string> {
  const url = source.startsWith("git:")
    ? `https://${source.slice("git:".length)}.git`
    : await network(`could not look up ${source} on npm`, () => npmRepository(run, checkout, source));
  const branch = await run(checkout, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") throw new UpdateSkipped("detached HEAD; check out a branch to update");
  const remotes = (await run(checkout, "git", ["remote"])).split("\n");
  await run(checkout, "git", remotes.includes(REMOTE) ? ["remote", "set-url", REMOTE, url] : ["remote", "add", REMOTE, url]);
  const listing = await network(`could not reach ${url}`, () => run(checkout, "git", ["ls-remote", "--symref", url, "HEAD"]));
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listing);
  if (!match) throw new UpdateSkipped(`could not read the default branch of ${url}`);
  const defaultBranch = match[1];
  await network(`could not fetch ${defaultBranch} from ${url}`, () => run(checkout, "git", ["fetch", "--no-tags", REMOTE, defaultBranch]));
  return `${REMOTE}/${defaultBranch}`;
}
