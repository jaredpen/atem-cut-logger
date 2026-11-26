# Changelog

## 1.1.0
- **Start logging** and **Stop logging** buttons. Connecting to the switcher no longer starts logging by itself, so you choose when a log begins and ends. (To go back to starting automatically, tick "Start logging automatically when I connect" in Settings.)
- **New log file…** saves and closes the current log and carries on in a new file, for the next segment or show, without missing a switch.
- Each log gets a name you choose, e.g. "Sunday Service". Files are named by date, time and that name: `2026-11-26 1930 Sunday Service.jsonl`.
- When a log stops, the console shows where it was saved, with a **Show in Finder** link. Clicking the logging pill in the header does the same.
- If you switch while connected but not logging, the console warns you that the switch wasn't saved.
- After stopping, the finished log stays on the timeline until the next one starts.

## 1.0.0
- First version of the Mac app.
- Logs every cut, transition (mix, dip, wipe, DVE, stinger), T-bar move, direct program-bus press and fade to black, stamped with the switcher's timecode.
- Live editor-style timeline: a PROGRAM track, one track per camera, an "Other sources" track, transitions as crossfades, markers, sync points, the switcher's own recording and connection drops. Hover for details; scroll, drag and zoom through the show.
- Console of every switch next to the timeline. Click a line to jump to it. Type notes as markers; SYNC button (S) for clap sync.
- Demo switcher with program/preview buses, CUT/AUTO/FTB, T-bar, transition styles and rates, switcher REC, dropped connections and an auto director.
- Open saved logs on the timeline.
- App updates from GitHub, installed from inside the app.
