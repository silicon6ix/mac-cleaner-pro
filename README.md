# Mac Cleaner Pro

A small web page that runs on your own Mac and helps you get back memory, disk space and a faster login. It is made for a Mac used for iOS and web development, so it knows about Xcode, simulators, dev servers and package caches.

Nothing happens without you seeing it first. Every action opens a preview that lists exactly what will change, and runs only when you press **Yes, do it**.

## Run it

You need Node.js 20 or newer (`node -v`). There is nothing to install: the app uses only what comes with Node.

```bash
npm install && npm run dev
```

This opens <http://127.0.0.1:4477> in your browser. Press Control-C in the terminal to stop it.

Other ways to start it:

| Command | What it does |
|---|---|
| `npm start` | Runs the server once (no restart on file changes). |
| `npm run dry` | **Practice mode for everything.** No action changes anything, whatever you click. Good for a first look. |
| `PORT=4480 npm start` | Uses another port. |
| `NO_OPEN=1 npm start` | Doesn't open the browser by itself. |
| `npm run check` | Read-only self-test. Runs every scan for real and checks the safety rules. Never cleans anything. |

There is also a **Practice mode** switch at the bottom of the sidebar. While it is on, every action only shows what it would have done.

## The three sections

### Memory

Shows how much memory is in use, how much has spilled into swap (memory moved to disk, which slows everything down), how much is compressed, and macOS's own memory pressure reading.

Apps are grouped by the app they belong to (all of Chrome's helper processes count as Chrome). The memory figure for each app includes the part macOS compressed or moved to swap, so an app you haven't touched in hours still shows its real weight. The orange part of each bar is that compressed or swapped part.

| Action | What it does | Command it runs |
|---|---|---|
| **Shut down simulators** | Shuts down the running iPhone simulators you tick. Their apps and data stay. | `xcrun simctl shutdown <udid>` |
| **Stop idle debugger helpers** | Stops `lldb-rpc-server` processes that have no `debugserver` child, which Xcode sometimes leaves behind. If you are debugging on a real iPhone, the helper looks idle too, so stop the debug session in Xcode first. | `kill -TERM <pid>` |
| **Stop dev servers and Node programs** | Lists long-running `node`, `next-server`, `bun` and `deno` processes with their folder, ports, age and memory. Stopping one sends a polite stop to it and its child processes, like pressing Control-C. Programs started by Claude (tool helpers) are listed separately and marked. | `kill -TERM <pids>` |
| **Quit apps** | Asks the apps you tick to quit, like choosing Quit from their menu, so they can ask you to save. Nothing is force quit. The first time, macOS may ask you to allow this. | `osascript -e 'tell application id "<bundle id>" to quit'` |

Before stopping anything, the server checks again that each process is the same one you saw (same number and same start time), so a recycled process number is never hit.

### Disk space

Laid out like a classic cleaner: categories on the left, the items in the selected category on the right, and **Selected / Total** with a **Remove** button at the bottom. Each item shows its size, when it was last used, and tags such as *In use*, *Stale*, *Newest* or *Main project*. Things that are safe to remove are ticked for you; you can change any tick.

| Category | What it finds | How it removes it | Ticked for you |
|---|---|---|---|
| Xcode junk: build folders | Each folder in `~/Library/Developer/Xcode/DerivedData`, sorted by last use. Agent copies (`*-agent-*`) are tagged. | Moves to the Trash | Folders not used in the last 3 days. |
| Xcode junk: main project | The newest non-agent build folder of each project used this month. | Moves to the Trash, only after you **Unlock** it | Never. Removing it means a full rebuild. |
| Xcode junk: device support | `~/Library/Developer/Xcode/iOS DeviceSupport` (and watchOS, tvOS…), one per device and iOS version. | Moves to the Trash | Older versions when a newer one exists for the same device. |
| Xcode junk: archives | `~/Library/Developer/Xcode/Archives`. They hold the crash symbols (dSYM) of shipped builds. | Moves to the Trash | Never. |
| Xcode junk: other | Leftover `Unsaved_Xcode_Document` folders, shared module caches, documentation cache, SwiftUI preview data, device logs. | Moves to the Trash | Leftovers, docs, previews, logs. |
| Simulators | Broken simulators (their iOS version is gone), simulators not started in 60+ days, and simulator runtimes (7–9 GB each). The newest runtime of each platform is locked. | `xcrun simctl delete unavailable`, `xcrun simctl delete <udid>`, `xcrun simctl runtime delete <id>` (permanent) | Broken ones; unused 180+ days. |
| Developer caches | npm (`~/.npm/_cacache`), Yarn, Homebrew, pip, CocoaPods, Swift packages, Playwright browsers, Gradle. For pnpm only packages no project uses are removed. | Moves to the Trash; `pnpm store prune` | npm, Yarn, Homebrew, pip, CocoaPods, SwiftPM, pnpm. |
| App caches | Folders in `~/Library/Caches` over 20 MB (Apple's own are skipped). | Moves to the Trash | Never. Quit the app first. |
| App logs | Folders in `~/Library/Logs` over 5 MB. | Moves to the Trash | Not written to in a week. |
| Big old downloads | Installers (`.dmg`, `.pkg`, `.xip`, `.iso`) older than a week and files over 100 MB untouched for 30 days in `~/Downloads`. | Moves to the Trash | Never. Look at each one. |
| Trash | Empties the Trash. macOS may hide its size from the app. | `osascript -e 'tell application "Finder" to empty trash'` (permanent) | Never. |

Moving to the Trash uses macOS's own `trash` command, so you can put things back from Finder. The space comes back when you empty the Trash. Tick **Skip the Trash** to delete right away instead.

Safety fence: the server only ever removes items its own scan found, and only inside these folders: `~/Library/Developer/Xcode` (DerivedData, Archives, DeviceSupport, DocumentationCache, device logs, SwiftUI previews), `~/Library/Developer/CoreSimulator/Caches`, `~/Library/Caches`, `~/Library/Logs`, `~/Downloads`, `~/.npm`, `~/Library/pnpm`, `~/.gradle/caches`. It refuses the folders themselves, your Documents, your projects and anything else. Paths are checked again right before removal.

### Startup

| List | What you see | What you can do |
|---|---|---|
| Login and background items | What System Settings → General → Login Items lists, read with `sfltool dumpbtm`, with on or off. | **Open Login Items settings**. macOS only lets you switch these there. |
| Your launch agents (`~/Library/LaunchAgents`) | Each agent's name, what it runs, when it runs, and whether it is running, off, blocked in System Settings, or points to a removed app. | **Turn off** (`launchctl bootout gui/<uid>/<label>` then `launchctl disable gui/<uid>/<label>`) or **Turn on**. Every change goes in **Recent changes** with an **Undo** button. The plist file is never edited or deleted. |
| Launch agents for all users (`/Library/LaunchAgents`) | Same details. | **How to turn off** shows the commands to run yourself. |
| Launch daemons (`/Library/LaunchDaemons`) | Same details. | **How to turn off** shows the `sudo` commands to run yourself. |

The undo history is kept in `~/.mac-cleaner-pro/startup-undo.json`.

## Safety rules

- The server listens on `127.0.0.1` only, so nothing else on your network can reach it.
- Each run makes a new secret that only its own page knows. Requests without it, or from another web address, are refused. That stops other websites from sending actions to it.
- Every change is a two-step preview and confirm. The confirm runs exactly the previewed plan; a preview works once and expires after 15 minutes.
- It never runs `sudo`. Anything that needs admin rights is shown as a command for you to run.
- It never touches your documents or project source.

## Settings

Optional, in `~/.mac-cleaner-pro/config.json`:

```json
{
  "inUseDays": 3,
  "protectDerivedData": ["MyApp-abcdefghijklmnopqrstuvwxyzab"]
}
```

- `inUseDays`: build folders used within this many days are tagged *In use* and left unticked.
- `protectDerivedData`: extra DerivedData folder names that are locked like the main project.

## How it's built

Plain Node.js (no packages) and a plain HTML/CSS/JS page.

| File | Job |
|---|---|
| `server/index.js` | Web server, host and secret checks, routes. |
| `server/plans.js` | Preview → confirm plans, practice runs. |
| `server/ram.js` | Memory figures, process grouping, simulators, debugger helpers, dev servers, quitting apps. |
| `server/disk.js` | Disk scan, sizes, the safety fence, cleaning. |
| `server/startup.js` | Login items, launch agents and daemons, turn off / on / undo. |
| `server/selftest.js` | `npm run check`. |
| `public/` | The page. |
