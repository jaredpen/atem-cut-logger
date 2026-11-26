# ATEM Cut Logger

A Mac app that logs every **cut** and **transition** on a Blackmagic ATEM switcher (built for the ATEM Television Studio 4K8). For each one it records the camera, the exact moment and the switcher's timecode.

- **Timeline (left):** an editor-style view of the log. The **PROGRAM** track shows the cut as it went out. Below it is one track per camera, showing when that camera was on air, plus a track for other sources (media player, bars, black). Dissolves show as crossfades, and markers, sync points, the switcher's own recording and any connection drops appear on the ruler.
- **Start / Stop logging:** you decide when a log begins and ends, and give each log a name. **New log file…** splits the show into separate files without missing a switch.
- **Console (right):** every switch as a line of text, like a server log. Click a line to jump to that moment on the timeline. Type a note at the bottom to drop a marker, or press **SYNC** at a clap.
- **Demo mode:** a simulated switcher with program/preview buses, CUT, AUTO, T-bar, fade to black, the switcher's recorder, dropped connections and an auto director. Use it to test the app without hardware.

The timeline only shows the log; it never changes it. The log files are what a DaVinci Resolve plugin will use later to cut the camera recordings.

---

## 1. Install as a Mac app (one time)

1. Install **Node.js** (the LTS version) from <https://nodejs.org>. The app needs it only to build itself.
2. Download this repository (green **Code** button → **Download ZIP**), unzip it, and **double-click `Install ATEM Cut Logger.command`**.
   - If macOS says it can't verify the file, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. Then double-click the file again.
   - A Terminal window opens and does everything itself. The first time takes about 2–5 minutes.
3. When it finishes, **ATEM Cut Logger** is in your **Applications** folder and opens straight away. Drag it to the Dock to keep it handy.
4. The first time you connect, macOS asks to let the app find devices on your **local network**. Click **Allow**, or it can't reach the switcher.

You can delete the unzipped folder afterwards. **Updates come from GitHub inside the app** (see below), so you won't need to download it again.

## 2. Logging a show

1. Put the Mac on the same network as the switcher.
2. Type the switcher's IP address in the top bar and click **Connect**. (The IP is in ATEM Setup, or on the switcher's LCD under network settings.) The PGM/PVW tally in the header and on the camera tracks starts following the switcher, but nothing is saved yet.
3. Click **● Start logging**, type a name for the log (for example *Sunday Service*) and press **Enter**. Every switch from now on is written to the file the moment it happens, so nothing is lost if the app or the Mac stops.
4. During the show:
   - Press **S** (or **SYNC**) at a clap when you're syncing cameras by clap.
   - Press **N**, type a note and press **Enter** to drop a marker ("Q&A starts").
   - To split the show into separate files (for example one per segment), click **New log file…** and give the next part a name. The current file is saved and the new one starts at the same instant.
5. Click **■ Stop logging** at the end. The file is saved and closed; you stay connected, ready for the next one.

If you switch while connected but not logging, the console warns you that the switch was not saved. Prefer logging to start the moment you connect? Tick **Start logging automatically when I connect** in ⚙ Settings.

If the network drops, the app keeps trying to reconnect. The gap shows as a red band on the timeline, and any switching done while disconnected is logged when it reconnects.

### Where the log files are (and the Resolve plugin)
You don't need to save anything by hand. Each log is saved **automatically, as it happens**, to `Documents/ATEM Cut Logger Logs` (change it in ⚙ Settings), named by date, time and the name you gave it:

```
Documents/ATEM Cut Logger Logs/2026-11-26 1930 Sunday Service.jsonl
```

That `.jsonl` file **is** the file for the DaVinci Resolve plugin: in Resolve you'll pick it, and the plugin cuts the camera clips to match. To find a log, click **Show in Finder** on the SAVED line in the console, or click the logging pill in the header. Copy the file to your edit drive with the camera footage if you edit on another computer. **Open log…** shows any saved log on the timeline. Demo logs are saved too, with "(demo)" in the name.

### Timeline controls
| Do this | To |
|---|---|
| Scroll or drag | Go back in time (stops following live) |
| Pinch, or ⌘/⌥ + scroll | Zoom |
| **LIVE** button, **L**, or double-click | Follow live again |
| **Fit** or **F** | Show the whole session |
| Hover a clip | In/out timecode, length, how it came in |
| Click a console line | Jump to that moment |

## 3. Demo mode

Click **Demo**, then **● Start logging**. A demo switcher panel appears under the timeline:

- **PROGRAM** row: a direct cut to that source. **PREVIEW** row: picks the next source.
- **CUT**, **AUTO** (uses the selected MIX / DIP / WIPE / DVE / STING and the rate), **FTB**.
- **T-bar:** pull it all the way for a manual transition, or partway and back to check that a cancelled transition is *not* logged.
- **Switcher REC:** starts and stops the switcher's own recorder, which shows as a red bar on the ruler.
- **Drop connection 4 s:** simulates the network dropping.
- **Auto director:** switches cameras by itself (cuts and transitions) so you can leave it running.
- Keys: **1–8** preview, **⇧ + 1–8** straight to program, **Space** CUT, **Enter** AUTO, **B** fade to black.

Demo logs are saved like real ones (with "(demo)" in the file name), so you can also use them to test the Resolve plugin later.

## 4. Updates

The app checks this GitHub repository each time it opens. When there's a newer version it shows **Update available** in the header.

1. Click **Update available** (or ⚙ Settings → App updates).
2. Click **Install update**, then click it again to confirm.
3. The app closes, rebuilds itself in a Terminal window (a few minutes) and reopens. Your logs and settings are kept.

You can't update while connected to a real switcher, and you shouldn't during a show. The repository is set to `jaredpen/atem-cut-logger`. If the repository is private, paste a GitHub access token in Settings.

**Publishing an update (for whoever maintains the code):** change the code, raise `"version"` in `package.json` (for example 1.0.0 → 1.1.0), add a section at the top of `CHANGELOG.md`, and push to the main branch. Every installed app will offer the update.

## 5. Things to know
- **Accuracy:** the switcher reports changes over the network within a few milliseconds. Times are stamped with the **switcher's own timecode** (asked for every 2 seconds), so they line up with camera files that share that timecode.
- **What counts as a switch:** cuts, AUTO and T-bar transitions that change program, direct program-bus presses, and fade to/from black. Key-only transitions and a T-bar pulled back don't count.
- This logs **one M/E** (M/E 1 by default; change it in Settings for bigger switchers).
- **Test before trusting it live:** connect, make a few cuts and transitions on the panel, and check the console shows each one with the right camera names.

## Log format
One JSON object per line. The first line describes the session (switcher, video format, input names). The rest are events: `initial`, `cut`, `transition` (start and end time, style, rate), `black_on`/`black_off`, `sync`, `marker`, `record_start`/`record_stop`, `disconnected`/`reconnected`, `end`. Each event has `t` (ms), `wall` (ISO time) and, when the switcher reports timecode, `tc` and `tcFrames`.

`tools/export.js` turns a log plus camera files into an FCPXML timeline (command line, for now): `node tools/export.js <log.jsonl> --init`, fill in `cameras.json`, then `node tools/export.js <log.jsonl>`.

## Developer use
- `npm install`, then `npm start` to run from source.
- `npm test` runs the tracker, timeline-model and end-to-end demo tests.
- `npm run preview` runs the real engine and shows the window in a web browser at http://localhost:5178 (no Electron needed).
