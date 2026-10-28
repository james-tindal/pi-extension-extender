# extension-extender

Keep your own changes to Pi extensions without losing updates from upstream.

Put Git checkouts in `~/.pi/agent/extension-extender/`. At startup, the extender fetches updates for each checkout. It rebases your local commits onto the tracking branch, then loads the extension.

Extensions update when Pi starts and when you run `/reload` because Pi provides no extension hook for `pi update`.

You choose the repository, branch, and local commits through Git. There is no separate repository configuration.

## Setup

Git and pnpm must be available.

In `~/.pi/agent/settings.json`, put the extender first in the `packages` list:

```json
{
  "packages": [
    "extensions/extension-extender",
    "npm:pi-sandbox"
  ]
}
```

Keep your other package entries in the list. The example uses the current local installation of the extender.

## Add an extension

For example, clone `pi-sandbox`:

```sh
mkdir -p ~/.pi/agent/extension-extender
git clone https://github.com/carderne/pi-sandbox.git ~/.pi/agent/extension-extender/pi-sandbox
cd ~/.pi/agent/extension-extender/pi-sandbox
git switch -c local --track origin/main
```

Make your changes in that checkout. Commit your changes before you start Pi. Then restart Pi.

The extender loads every non-hidden folder in this directory. Each folder must contain a Git checkout of a Pi extension package. The current branch must have a tracking branch.

After an update, the extender installs dependencies. It also installs dependencies that are absent. It does not run dependency install scripts.

If you use `PI_CODING_AGENT_DIR`, put the checkouts in `extension-extender/` under that directory instead.

## Replace an installed extension

Name the checkout folder after the installed package directory. For `pi-sandbox`, use `pi-sandbox`.

Keep the existing package entry in your Pi configuration. The extender uses your checkout instead of the installed copy. This applies to npm, Git, and local installations.

The checkout must retain the extension entry points of the installed package. For example, a package that loads `index.ts` still needs that file.

A checkout without a matching installation loads as an additional extension.

## Update failures

If an update fails, Pi stops with an error. It does not silently load the original extension.

- **Uncommitted changes:** Commit your changes in the checkout before you restart Pi.
- **No tracking branch:** Set one with `git branch --set-upstream-to=origin/main`, or select another remote branch.
- **Rebase conflict:** Resolve the conflict in the checkout. Then run `git rebase --continue`.
- **Network or authentication failure:** Restore access to the remote repository before you restart Pi.

If you do not want to complete a conflicting rebase, run `git rebase --abort`. The extender will attempt the update again at the next startup.
