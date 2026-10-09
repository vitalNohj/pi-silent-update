# pi-silent-update

A [Pi](https://pi.dev) extension that keeps Pi and its packages up to date without Pi's update popups ("Update Available" and "Package Updates Available"). It runs `pi update --all` once per machine, and only when something new is actually out. If anything fails, you see it inside Pi until it is fixed.

## What it does

On every Pi start:

1. **Hides Pi's own update popups.** It sets `PI_SKIP_VERSION_CHECK=1` and replaces Pi's startup package-update check (`InteractiveMode.checkForPackageUpdates`) with a no-op. This happens when the extension loads, before Pi runs either check. Pi's model catalog refresh is not affected, because `PI_OFFLINE` is never set.
2. **Throttles.** A small state file, `<agent dir>/silent-update.json`, records when the last check ran. Inside the throttle window (6h by default) the extension reads that one file and does nothing else.
3. **Checks without npm.** Each check makes plain HTTPS requests:
   - Pi: `https://pi.dev/api/latest-version` (the endpoint Pi itself uses), compared with the version installed on disk.
   - npm packages: the registry's version for each package in your global and project `packages` settings, compared with the installed `package.json`. It uses Pi's own `DefaultPackageManager` to list and parse packages, so local and pinned sources (`npm:foo@1.2.3`, `git:...@ref`) are skipped the same way `pi update` skips them. Project packages are included only for projects you have trusted.
   - Unpinned git packages: `git ls-remote` against the tracked branch.
4. **Updates once per machine.** When something is newer, it takes a lock (an atomic `mkdir` of `<agent dir>/silent-update.lock`) and starts `pi update --all` in a short-lived `systemd-run --user` unit. Where systemd is not available, it starts a detached process instead. Either way, Pi starts without waiting, and closing the session does not stop the update. Any other session that sees the lock skips its own run. The update gets 15 minutes before it is stopped.
5. **Verifies the result.** When the job finishes, the extension reads the installed versions again. Anything still older than the version it aimed for counts as a failure, even if `pi update` exited 0.

A successful update shows one line, for example `Updated is-number 6.0.0 -> 7.0.0; restart Pi to use it`. If nothing changed, you see nothing.

## Install

```sh
pi install git:github.com/vitalNohj/pi-silent-update
```

It works only in interactive Pi sessions, and it does not delay startup.

## Command

`/silent-update` runs a check now, ignoring the throttle, and prints the current state: last check, last update, last result, and any recorded failure.

## Settings

All settings are environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_SILENT_UPDATE_INTERVAL_HOURS` | `6` | Minimum time between checks on this machine. `0` checks on every start. |
| `PI_SILENT_UPDATE_CMD` | `pi update --all` | Command the background job runs. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's agent dir. The state file and lock live here. |
| `PI_OFFLINE` | unset | Pi's offline mode. While it is set, no check runs. |
| `npm_config_registry` | `https://registry.npmjs.org` | npm registry to query. |

## How failures appear

Every failure is written to the state file, including:

- a failed check (for example, an unreachable registry or pi.dev)
- `pi update --all` exiting non-zero or timing out
- a package still older than expected after the update
- a lock left from a run that never finished (it is treated as broken after 1h, removed, and reported)
- an update that could not be started

While a failure is recorded, every Pi session shows a warning naming what failed and the command to run by hand, and the status line shows `⚠ update failed: /silent-update`:

```
Warning: pi-silent-update failed: `pi update --all` exited 1: npm ERR! ... Run by hand: pi update --all
```

The warning stays until a later check or update succeeds. That success clears it, and the extension says so once.

Everything happens inside Pi. Apart from the version checks above, the extension makes no network calls: no email, no webhooks, no telemetry.

## Uninstall

```sh
pi remove git:github.com/vitalNohj/pi-silent-update
rm -f ~/.pi/agent/silent-update.json   # optional: the state file
```

Once it is removed, Pi shows its own update popups again.

## Development

```sh
npm install   # dev only: jiti, to run the TypeScript tests on Node versions without type stripping
npm test
```

The extension is a single file, `index.ts`, with no runtime dependencies.

## Credits

Prior art: [pi-auto-update](https://www.npmjs.com/package/pi-auto-update) (MIT), which runs `pi update` on every start, and [pi-updater](https://www.npmjs.com/package/pi-updater) (MIT), which asks before updating. This extension borrows the idea of updating from a startup hook from pi-auto-update. It adds the version check, the per-machine lock, result verification, and failure reporting.

## License

MIT
