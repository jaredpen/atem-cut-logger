#!/usr/bin/env node
'use strict'
// Turns an ATEM cut log + your camera recordings into a timeline for DaVinci Resolve (FCPXML)
// and a readable cut list (CSV).
//
//   node export.js <log.jsonl> --init                 write a cameras.json template to fill in
//   node export.js <log.jsonl> [--config cameras.json] [--out show.fcpxml]

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { spawnSync } = require('child_process')
const tc = require('../src/timecode')

process.on('uncaughtException', (err) => {
	console.error(`\nError: ${err.message}`)
	process.exit(1)
})

const args = process.argv.slice(2)
const flag = (name, def) => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 ? args[i + 1] : def
}
const logPath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--init'))
if (!logPath) {
	console.log('Usage:\n  node export.js <log.jsonl> --init\n  node export.js <log.jsonl> [--config cameras.json] [--out timeline.fcpxml]')
	process.exit(1)
}

// ---------- read log ----------
const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)
const all = lines.map((l, i) => {
	try {
		return JSON.parse(l)
	} catch {
		throw new Error(`${logPath} line ${i + 1} is not valid JSON`)
	}
})
const session = all.find((e) => e.type === 'session')
if (!session) throw new Error('Log has no session header - was it written by logger.js?')
const events = all.filter((e) => e.type !== 'session').sort((a, b) => a.t - b.t)
const rate = tc.getRate(session.fps)
const inputs = session.inputs || {}
const inputName = (id) => inputs[id] || `Input ${id}`

const defaultConfigPath = path.join(path.dirname(logPath), 'cameras.json')

// ---------- --init: write a template ----------
if (args.includes('--init')) {
	const cams = {}
	for (const [id, nm] of Object.entries(inputs)) {
		if (Number(id) >= 1 && Number(id) <= 40) cams[id] = { name: nm, file: '', clapAt: '', offsetFrames: 0 }
	}
	const template = {
		_help: [
			'Fill in "file" for each camera you recorded (full path). Leave it empty for inputs you did not record.',
			'sync: "timecode" if the camera files carry the same timecode as the ATEM; "clap" if you typed s in the logger at a clap.',
			'For "clap": set clapAt on each camera to the timecode where the clap is, as shown for that clip in Resolve.',
			'offsetFrames nudges one camera earlier (-) or later (+) if it is a frame off.',
			'audioFrom: camera number whose audio runs under the whole timeline, or null to cut audio with the picture.',
			'range: "all" for the whole log, or "recording" to keep only the part where the switcher itself was recording.',
		],
		timelineName: path.basename(logPath, '.jsonl'),
		sync: events.some((e) => e.tcFrames !== undefined) ? 'timecode' : 'clap',
		clapNumber: 1,
		audioFrom: null,
		range: 'all',
		unmapped: 'gap',
		cameras: cams,
	}
	const out = flag('config', defaultConfigPath)
	if (fs.existsSync(out)) {
		console.log(`${out} already exists - not overwriting it.`)
		process.exit(1)
	}
	fs.writeFileSync(out, JSON.stringify(template, null, 2))
	console.log(`Wrote ${out}. Fill in the camera file paths, then run:\n  node export.js "${logPath}" --config "${out}"`)
	process.exit(0)
}

// ---------- config ----------
const configPath = flag('config', defaultConfigPath)
if (!fs.existsSync(configPath)) {
	console.log(`No camera config at ${configPath}. Create one with:\n  node export.js "${logPath}" --init`)
	process.exit(1)
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const configDir = path.dirname(path.resolve(configPath))
const warnings = []
const warn = (msg) => warnings.push(msg)

// ---------- master clock ----------
// Every moment in the log is turned into a "master frame". With timecode available that is the
// ATEM's own timecode (taken from the nearest logged event, so PC clock drift does not build up);
// otherwise it is the PC clock converted to frames.
const tcEvents = events.filter((e) => typeof e.tcFrames === 'number')
const useTc = config.sync === 'timecode' ? true : tcEvents.length > 0
if (config.sync === 'timecode' && tcEvents.length === 0) {
	throw new Error('sync is "timecode" but this log has no ATEM timecode (switcher did not answer time requests). Use "clap" sync instead.')
}
function masterFrame(ms) {
	if (!useTc) return tc.msToFrames(ms, rate)
	let best = tcEvents[0]
	for (const e of tcEvents) if (Math.abs(e.t - ms) < Math.abs(best.t - ms)) best = e
	return best.tcFrames + tc.msToFrames(ms - best.t, rate)
}
const dropFrame = useTc && events.some((e) => typeof e.tc === 'string' && e.tc.includes(';'))

// ---------- build program segments ----------
const BLACK = 'black'
let program = null
let black = false
const boundaries = [] // { frame, source, transitionFrames, event }
const effective = () => (black ? BLACK : program)

for (const e of events) {
	const before = effective()
	let frame = null
	let dur = 0
	if (e.type === 'initial') {
		program = e.program
		black = !!e.black
		boundaries.push({ frame: Math.round(masterFrame(e.t)), source: effective(), transitionFrames: 0, event: e })
		continue
	}
	if (e.type === 'cut') {
		program = e.to
		frame = masterFrame(e.t)
	} else if (e.type === 'transition') {
		program = e.to
		const a = masterFrame(e.t)
		const b = masterFrame(e.tEnd)
		if (e.style === 'sting') {
			frame = (a + b) / 2 // stinger hides the switch; cut in the middle of it
		} else {
			// Dissolve starts on the frame the ATEM started it; the edit point is its middle.
			dur = Math.max(0, Math.round((b - a) / 2) * 2) // even number of frames
			frame = Math.round(a) + dur / 2
		}
	} else if (e.type === 'black_on' || e.type === 'black_off') {
		black = e.type === 'black_on'
		frame = (masterFrame(e.t) + masterFrame(e.tEnd ?? e.t)) / 2
	} else continue
	if (effective() !== before) boundaries.push({ frame: Math.round(frame), source: effective(), transitionFrames: dur, event: e })
}
if (!boundaries.length) throw new Error('No switching found in the log.')

// Timeline range
const endEvent = [...events].reverse().find((e) => e.type === 'end') || events[events.length - 1]
let rangeStart = boundaries[0].frame
let rangeEnd = Math.round(masterFrame(endEvent.t))
if (config.range === 'recording') {
	const rs = events.find((e) => e.type === 'record_start')
	const re = events.find((e) => e.type === 'record_stop' && (!rs || e.t > rs.t))
	if (!rs) warn('range is "recording" but the switcher never started recording in this log - using the whole log.')
	else {
		rangeStart = Math.round(masterFrame(rs.t))
		if (re) rangeEnd = Math.round(masterFrame(re.t))
	}
}

let segments = []
for (let i = 0; i < boundaries.length; i++) {
	const b = boundaries[i]
	const start = b.frame
	const end = i + 1 < boundaries.length ? boundaries[i + 1].frame : rangeEnd
	segments.push({ start, end, source: b.source, transitionFrames: b.transitionFrames, event: b.event })
}
// Clip to range
segments = segments
	.map((s) => ({ ...s, start: Math.max(s.start, rangeStart), end: Math.min(s.end, rangeEnd), transitionFrames: s.start < rangeStart ? 0 : s.transitionFrames }))
	.filter((s) => s.end > s.start)

// ---------- cameras ----------
function probe(file) {
	const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' })
	if (r.error || r.status !== 0) return null
	try {
		return JSON.parse(r.stdout)
	} catch {
		return null
	}
}
let ffprobeMissing = false

const cameras = {}
for (const [id, cam] of Object.entries(config.cameras || {})) {
	if (!cam || !cam.file) continue
	const file = path.resolve(configDir, cam.file)
	const info = { id, name: cam.name || inputName(id), file, width: session.width, height: session.height, startFrames: 0, durationFrames: null, hasAudio: true }
	if (!fs.existsSync(file)) warn(`Camera ${id}: file not found here (${file}). The timeline will still point to it.`)
	const p = fs.existsSync(file) ? probe(file) : null
	if (fs.existsSync(file) && !p) ffprobeMissing = true
	if (p) {
		const v = p.streams.find((s) => s.codec_type === 'video')
		info.hasAudio = p.streams.some((s) => s.codec_type === 'audio')
		info.audioChannels = p.streams.find((s) => s.codec_type === 'audio')?.channels
		if (v) {
			info.width = v.width
			info.height = v.height
			const [n, d] = (v.r_frame_rate || '0/1').split('/').map(Number)
			const fileFps = n / d
			if (Math.abs(fileFps - rate.num / rate.den) > 0.01) warn(`Camera ${id}: file is ${fileFps.toFixed(3)} fps but the switcher ran at ${rate.label}. Cuts may drift.`)
		}
		const tcTag = p.format?.tags?.timecode || v?.tags?.timecode || p.streams.find((s) => s.tags?.timecode)?.tags?.timecode
		if (tcTag) info.startFrames = tc.tcToFrames(tcTag, rate)
		const secs = Number(p.format?.duration || v?.duration)
		if (secs) info.durationFrames = Math.floor(secs * (rate.num / rate.den))
	}
	if (cam.fileStartTimecode) info.startFrames = tc.tcToFrames(cam.fileStartTimecode, rate)
	else if (config.sync !== 'clap' && !p?.format?.tags?.timecode && !p?.streams?.some((s) => s.tags?.timecode)) {
		throw new Error(
			`Camera ${id}: can't read the timecode at the start of ${path.basename(file)}` +
				(p ? ' (the file has none).' : ' (ffprobe not installed or file missing).') +
				` Set "fileStartTimecode" for this camera in cameras.json, or use "sync": "clap".`
		)
	}

	// Offset: source frame = master frame + offset
	let offset
	if (config.sync === 'clap') {
		const syncs = events.filter((e) => e.type === 'sync')
		const n = Number(config.clapNumber || 1)
		const mark = syncs.find((e) => e.n === n) || syncs[n - 1]
		if (!mark) throw new Error(`sync is "clap" but the log has no sync mark #${n}. Type s + Enter in the logger at the clap.`)
		if (!cam.clapAt) throw new Error(`Camera ${id}: set "clapAt" to the timecode where the clap is in this file.`)
		offset = tc.tcToFrames(cam.clapAt, rate) - masterFrame(mark.t)
	} else {
		offset = 0
	}
	info.offset = Math.round(offset) + Number(cam.offsetFrames || 0)
	cameras[id] = info
}
if (!Object.keys(cameras).length) throw new Error(`No camera files set in ${configPath}.`)
if (ffprobeMissing) warn('ffprobe (part of ffmpeg) was not found, so file timecode and lengths were not read. Install ffmpeg for automatic checks, or set fileStartTimecode in cameras.json.')

// ---------- turn segments into clips and gaps ----------
const items = []
for (const s of segments) {
	const cam = s.source === BLACK ? null : cameras[String(s.source)]
	if (!cam) {
		const label = s.source === BLACK ? 'Black' : inputName(s.source)
		const last = items[items.length - 1]
		if (config.unmapped === 'hold' && s.source !== BLACK && last?.kind === 'clip' && last.end === s.start) {
			// Stay on the previous camera, but not past the end of its file.
			const fileEnd = last.cam.durationFrames ? last.cam.startFrames + last.cam.durationFrames - last.cam.offset : Infinity
			last.end = Math.min(s.end, fileEnd)
			if (last.end < s.end) items.push({ kind: 'gap', start: last.end, end: s.end, label })
		} else items.push({ kind: 'gap', start: s.start, end: s.end, label })
		continue
	}
	// Source range this segment needs, and what the file actually covers
	const srcStart = s.start + cam.offset
	const fileStart = cam.startFrames
	const fileEnd = cam.durationFrames ? cam.startFrames + cam.durationFrames : Infinity
	const coveredStart = Math.max(s.start, fileStart - cam.offset)
	const coveredEnd = Math.min(s.end, fileEnd - cam.offset)
	if (coveredEnd <= coveredStart) {
		warn(`${cam.name}: no footage at ${tc.framesToTc(s.start, rate, dropFrame)} (camera wasn't recording?) - left a gap.`)
		items.push({ kind: 'gap', start: s.start, end: s.end, label: `${cam.name} (no footage)` })
		continue
	}
	if (coveredStart > s.start) {
		warn(`${cam.name}: footage starts late at ${tc.framesToTc(s.start, rate, dropFrame)} - gap before it.`)
		items.push({ kind: 'gap', start: s.start, end: coveredStart, label: `${cam.name} (no footage)` })
	}
	items.push({ kind: 'clip', cam, start: coveredStart, end: coveredEnd, transitionFrames: coveredStart === s.start ? s.transitionFrames : 0 })
	if (coveredEnd < s.end) {
		warn(`${cam.name}: footage ends early at ${tc.framesToTc(coveredEnd, rate, dropFrame)} - gap after it.`)
		items.push({ kind: 'gap', start: coveredEnd, end: s.end, label: `${cam.name} (no footage)` })
	}
	void srcStart
}

// Merge neighbouring gaps
for (let i = items.length - 1; i > 0; i--) {
	if (items[i].kind === 'gap' && items[i - 1].kind === 'gap') {
		items[i - 1].end = items[i].end
		items.splice(i, 1)
	}
}

// Make dissolves fit: both clips need spare footage (handles) either side of the edit.
for (let i = 1; i < items.length; i++) {
	const b = items[i]
	const a = items[i - 1]
	if (b.kind !== 'clip' || !b.transitionFrames) continue
	if (a.kind !== 'clip') {
		b.transitionFrames = 0
		continue
	}
	const aFileEnd = a.cam.durationFrames ? a.cam.startFrames + a.cam.durationFrames : Infinity
	const aHandle = aFileEnd - (a.end + a.cam.offset)
	const bHandle = b.start + b.cam.offset - b.cam.startFrames
	const half = Math.min(b.transitionFrames / 2, aHandle, bHandle, a.end - a.start, b.end - b.start)
	const fitted = Math.max(0, Math.floor(half)) * 2
	if (fitted < b.transitionFrames) warn(`Dissolve at ${tc.framesToTc(b.start, rate, dropFrame)} shortened from ${b.transitionFrames} to ${fitted} frames (not enough footage either side).`)
	b.transitionFrames = fitted
}

// ---------- write FCPXML ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const T = (frames) => tc.fcpTime(frames, rate)
const frameDuration = tc.fcpTime(1, rate)
const tcFormat = dropFrame ? 'DF' : 'NDF'
const timelineStart = items[0].start
const timelineEnd = items[items.length - 1].end
// Timeline timecode matches the ATEM's when we have it, otherwise starts at 01:00:00:00.
const tlOrigin = useTc ? 0 : timelineStart - tc.tcToFrames('01:00:00:00', rate)
const tl = (f) => f - tlOrigin

const formats = new Map()
const formatId = (w, h) => {
	const key = `${w}x${h}`
	if (!formats.has(key)) formats.set(key, { id: `r${formats.size + 1}`, w, h })
	return formats.get(key).id
}
const seqFormat = formatId(session.width, session.height)

const usedCams = [...new Set(items.filter((i) => i.kind === 'clip').map((i) => i.cam.id))].map((id) => cameras[id])
const audioCam = config.audioFrom != null && config.audioFrom !== '' ? cameras[String(config.audioFrom)] : null
if (config.audioFrom != null && config.audioFrom !== '' && !audioCam) warn(`audioFrom is ${config.audioFrom} but that camera has no file set - audio will cut with the picture.`)
if (audioCam && !usedCams.includes(audioCam)) usedCams.push(audioCam)

const assetXml = usedCams.map((cam, i) => {
	cam.assetId = `a${i + 1}`
	const maxUsed = Math.max(...items.filter((it) => it.kind === 'clip' && it.cam === cam).map((it) => it.end + cam.offset + it.transitionFrames), timelineEnd + cam.offset)
	const dur = cam.durationFrames ?? maxUsed - cam.startFrames + 1
	return `    <asset id="${cam.assetId}" name="${esc(path.basename(cam.file))}" src="${esc(pathToFileURL(cam.file).href)}" start="${T(cam.startFrames)}" duration="${T(dur)}" hasVideo="1" format="${formatId(cam.width, cam.height)}"${cam.hasAudio ? ` hasAudio="1" audioSources="1" audioChannels="${cam.audioChannels || 2}" audioRate="48000"` : ''}/>`
})

const spine = []
items.forEach((it, i) => {
	if (it.kind === 'clip' && it.transitionFrames) {
		spine.push(`          <transition name="Cross Dissolve" offset="${T(tl(it.start) - it.transitionFrames / 2)}" duration="${T(it.transitionFrames)}"/>`)
	}
	const attrs = `offset="${T(tl(it.start))}" duration="${T(it.end - it.start)}"`
	let connected = ''
	if (i === 0 && audioCam) {
		// One continuous audio clip under the whole timeline, attached to the first item.
		const parentStart = it.kind === 'clip' ? it.start + it.cam.offset : tl(it.start)
		connected = `\n            <asset-clip ref="${audioCam.assetId}" lane="-1" name="${esc(audioCam.name)} audio" offset="${T(parentStart)}" start="${T(timelineStart + audioCam.offset)}" duration="${T(timelineEnd - timelineStart)}" srcEnable="audio" tcFormat="${tcFormat}"/>\n          `
	}
	if (it.kind === 'clip') {
		spine.push(`          <asset-clip ref="${it.cam.assetId}" name="${esc(it.cam.name)}" ${attrs} start="${T(it.start + it.cam.offset)}" tcFormat="${tcFormat}"${audioCam ? ' srcEnable="video"' : ''}>${connected}</asset-clip>`)
	} else {
		spine.push(`          <gap name="${esc(it.label)}" ${attrs} start="${T(tl(it.start))}">${connected}</gap>`)
	}
})

const name = config.timelineName || path.basename(logPath, '.jsonl')
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.8">
  <resources>
${[...formats.values()].map((f) => `    <format id="${f.id}" frameDuration="${frameDuration}" width="${f.w}" height="${f.h}"/>`).join('\n')}
${assetXml.join('\n')}
  </resources>
  <library>
    <event name="${esc(name)}">
      <project name="${esc(name)}">
        <sequence format="${seqFormat}" duration="${T(timelineEnd - timelineStart)}" tcStart="${T(tl(timelineStart))}" tcFormat="${tcFormat}" audioLayout="stereo" audioRate="48k">
          <spine>
${spine.join('\n')}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`
const outPath = flag('out', logPath.replace(/\.jsonl$/, '') + '.fcpxml')
fs.writeFileSync(outPath, xml)

// ---------- CSV cut list ----------
const csvPath = outPath.replace(/\.fcpxml$/, '') + '-cutlist.csv'
const row = (cols) => cols.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')
const csv = [row(['#', 'Timeline TC', 'Wall clock', 'Type', 'From', 'To', 'Transition frames', 'Note'])]
let n = 0
for (const e of events) {
	if (!['initial', 'cut', 'transition', 'black_on', 'black_off', 'sync', 'marker', 'record_start', 'record_stop', 'disconnected', 'reconnected'].includes(e.type)) continue
	const f = e.type === 'transition' ? (e.style === 'sting' ? (masterFrame(e.t) + masterFrame(e.tEnd)) / 2 : masterFrame(e.t)) : masterFrame(e.t)
	csv.push(
		row([
			++n,
			tc.framesToTc(tl(Math.round(f)), rate, dropFrame),
			new Date(e.t).toLocaleString(),
			e.type === 'transition' ? e.style : e.type,
			e.from !== undefined ? inputName(e.from) : '',
			e.to !== undefined ? inputName(e.to) : e.program !== undefined ? inputName(e.program) : '',
			e.type === 'transition' ? Math.round(masterFrame(e.tEnd) - masterFrame(e.t)) : '',
			e.note || (e.n ? `sync #${e.n}` : ''),
		])
	)
}
fs.writeFileSync(csvPath, csv.join('\n') + '\n')

// ---------- summary ----------
const clips = items.filter((i) => i.kind === 'clip')
console.log(`Timeline "${name}": ${tc.framesToTc(timelineEnd - timelineStart, rate)} long, ${clips.length} clips, ${clips.filter((c) => c.transitionFrames).length} dissolves, ${items.length - clips.length} gaps.`)
console.log(`Clock: ${useTc ? 'ATEM timecode' : 'computer clock'}; sync: ${config.sync || 'timecode'}.`)
console.log(`Wrote ${outPath}`)
console.log(`Wrote ${csvPath}`)
if (warnings.length) {
	console.log(`\n${warnings.length} warning(s):`)
	for (const w of [...new Set(warnings)].slice(0, 30)) console.log(`  - ${w}`)
	if (warnings.length > 30) console.log(`  ... and ${warnings.length - 30} more`)
}
