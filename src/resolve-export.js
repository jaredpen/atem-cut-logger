'use strict'
// Builds a DaVinci Resolve timeline (FCPXML, which Resolve's free version imports with
// File → Import → Timeline) from a cut log and the camera recordings, plus a CSV cut list.
//
// Every position is counted in "master frames": the switcher's own timecode, as a frame count.
// A camera file is placed by its start timecode (timecode sync), or by where a clap appears in it
// (clap sync). Several files per camera are fine; each part of the show uses the file that covers it.

const path = require('path')
const { pathToFileURL } = require('url')
const TC = require('./timecode')

const BLACK = 'black'
const KIND = { mix: 'Mix', dip: 'Dip', wipe: 'Wipe', dve: 'DVE', sting: 'Stinger' }

// ---------------------------------------------------------------- rational time for FCPXML
function gcd(a, b) {
	a = Math.abs(a)
	b = Math.abs(b)
	while (b) [a, b] = [b, a % b]
	return a || 1
}
function rational(num, den) {
	if (num === 0) return '0s'
	const g = gcd(num, den)
	num /= g
	den /= g
	return den === 1 ? `${num}s` : `${num}/${den}s`
}
// frames counted at `rate` -> seconds string
const fcpFrames = (frames, rate) => rational(Math.round(frames) * rate.den, rate.num)

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function defaultOptions() {
	return { sync: 'timecode', clapNumber: 1, audioFrom: null, range: 'all', unmapped: 'gap', dissolves: true, timelineName: '' }
}

/**
 * @param {{ header: object, events: object[] }} log
 * @param {object} options
 *   cameras: { [inputId]: { files: [{ path, fps, width, height, durationFrames, startTc, hasAudio, audioChannels }], clapAt, offsetFrames } }
 *   sync: 'timecode' | 'clap', clapNumber, audioFrom, range: 'all'|'recording', unmapped: 'gap'|'hold', dissolves, timelineName
 */
function buildTimeline(log, options) {
	const opts = { ...defaultOptions(), ...options }
	const header = log.header
	if (!header) throw new Error('This log has no header.')
	const events = log.events.filter((e) => e.type !== 'session').sort((a, b) => a.t - b.t)
	const rate = TC.getRate(header.fps)
	const inputs = header.inputs || {}
	const inputName = (id) => (id === BLACK ? 'Black' : inputs[id] || `Input ${id}`)
	const warnings = []
	const warn = (m) => {
		if (!warnings.includes(m)) warnings.push(m)
	}

	// ---- master clock
	const tcEvents = events.filter((e) => typeof e.tcFrames === 'number')
	const useTc = tcEvents.length > 0
	if (opts.sync === 'timecode' && !useTc)
		throw new Error("This log has no switcher timecode, so it can't be lined up by timecode. Choose clap sync instead.")
	const masterFrame = (ms) => {
		if (!useTc) return TC.msToFrames(ms, rate)
		let best = tcEvents[0]
		for (const e of tcEvents) if (Math.abs(e.t - ms) < Math.abs(best.t - ms)) best = e
		return best.tcFrames + TC.msToFrames(ms - best.t, rate)
	}
	const dropFrame = events.some((e) => typeof e.tc === 'string' && e.tc.includes(';'))
	const fmt = (f) => TC.framesToTc(Math.round(f), rate, dropFrame)

	// ---- what was on air, as segments of master frames
	let program = null
	let black = false
	const eff = () => (black ? BLACK : program)
	const bounds = []
	for (const e of events) {
		const before = eff()
		let frame
		let dur = 0
		if (e.type === 'initial') {
			program = e.program
			black = !!e.black
			bounds.push({ frame: Math.round(masterFrame(e.t)), src: eff(), dur: 0, how: 'start' })
			continue
		} else if (e.type === 'cut') {
			program = e.to
			frame = masterFrame(e.t)
		} else if (e.type === 'transition') {
			program = e.to
			const a = masterFrame(e.t)
			const b = masterFrame(e.tEnd)
			if (e.style === 'sting' || !opts.dissolves) frame = e.style === 'sting' ? (a + b) / 2 : a + (b - a) / 2
			else {
				dur = Math.max(0, Math.round((b - a) / 2) * 2)
				frame = Math.round(a) + dur / 2
			}
		} else if (e.type === 'black_on' || e.type === 'black_off') {
			black = e.type === 'black_on'
			frame = (masterFrame(e.t) + masterFrame(e.tEnd ?? e.t)) / 2
		} else continue
		if (eff() !== before) bounds.push({ frame: Math.round(frame), src: eff(), dur, how: e.type === 'transition' ? e.style : e.type })
	}
	if (!bounds.length) throw new Error('No switching found in this log.')

	const endEvent = [...events].reverse().find((e) => e.type === 'end') || events[events.length - 1]
	let rangeStart = bounds[0].frame
	let rangeEnd = Math.round(masterFrame(endEvent.t))
	if (opts.range === 'recording') {
		const rs = events.find((e) => e.type === 'record_start') || (events.find((e) => e.type === 'initial')?.recording ? events[0] : null)
		const re = events.find((e) => e.type === 'record_stop' && (!rs || e.t > rs.t))
		if (!rs) warn("The switcher's recorder never ran during this log, so the whole log was used.")
		else {
			rangeStart = Math.round(masterFrame(rs.t))
			if (re) rangeEnd = Math.round(masterFrame(re.t))
		}
	}
	let segments = bounds.map((b, i) => ({ start: b.frame, end: i + 1 < bounds.length ? bounds[i + 1].frame : rangeEnd, src: b.src, dur: b.dur, how: b.how }))
	segments = segments
		.map((s) => ({ ...s, dur: s.start < rangeStart ? 0 : s.dur, start: Math.max(s.start, rangeStart), end: Math.min(s.end, rangeEnd) }))
		.filter((s) => s.end > s.start)
	if (!segments.length) throw new Error('Nothing is left in the chosen range.')

	// ---- cameras and their files
	const syncMarks = events.filter((e) => e.type === 'sync')
	const onAir = new Set(segments.map((s) => String(s.src)))
	const cams = {}
	for (const [id, cfg] of Object.entries(opts.cameras || {})) {
		if (!cfg || !cfg.files || !cfg.files.length) continue
		const name = inputName(id)
		const files = []
		for (const f of cfg.files) {
			const fr = f.fps ? TC.getRate(f.fps) : rate
			let start = null
			const tcText = (f.startTcOverride || f.startTc || '').trim()
			if (tcText) {
				try {
					start = TC.tcToFrames(tcText, fr)
				} catch {
					warn(`${name}: "${tcText}" isn't a timecode (HH:MM:SS:FF). ${path.basename(f.path)} was left out.`)
					continue
				}
			} else if (opts.sync === 'clap') start = 0
			else {
				warn(`${name}: ${path.basename(f.path)} has no start timecode. Type it in, or use clap sync. It was left out.`)
				continue
			}
			if (f.fps && f.fps !== rate.label) warn(`${name}: ${path.basename(f.path)} is ${f.fps} fps but the switcher ran at ${rate.label} fps.`)
			const ratio = rate.num / rate.den / (fr.num / fr.den)
			files.push({
				path: f.path,
				name: path.basename(f.path),
				fr,
				start,
				dur: f.durationFrames || null,
				startM: start * ratio,
				endM: f.durationFrames ? (start + f.durationFrames) * ratio : Infinity,
				width: f.width || header.width,
				height: f.height || header.height,
				hasAudio: f.hasAudio !== false,
				channels: f.audioChannels || 2,
			})
		}
		if (!files.length) continue
		files.sort((a, b) => a.startM - b.startM)
		let off = 0
		if (opts.sync === 'clap') {
			const n = Number(opts.clapNumber || 1)
			const mark = syncMarks.find((e) => e.n === n) || syncMarks[n - 1]
			if (!mark) throw new Error(`Clap sync needs a SYNC point in the log, and this log has ${syncMarks.length ? `no sync point #${n}` : 'none'}.`)
			if (!String(cfg.clapAt || '').trim()) {
				if (onAir.has(String(id))) throw new Error(`${name}: type the timecode where the clap is in this camera's recording.`)
				continue
			}
			const fr0 = files[0].fr
			let clap
			try {
				clap = TC.tcToFrames(String(cfg.clapAt).trim(), fr0)
			} catch {
				throw new Error(`${name}: "${cfg.clapAt}" isn't a timecode (HH:MM:SS:FF).`)
			}
			off = clap * (rate.num / rate.den / (fr0.num / fr0.den)) - masterFrame(mark.t)
		}
		off = Math.round(off) + Math.round(Number(cfg.offsetFrames) || 0)
		cams[id] = { id, name, files, off }
	}

	// Pieces of [a, b) covered by a camera's files
	function cover(cam, a, b) {
		const pieces = []
		for (const f of cam.files) {
			const s = Math.max(a, Math.ceil(f.startM - cam.off - 1e-6))
			const e = Math.min(b, f.endM === Infinity ? b : Math.floor(f.endM - cam.off + 1e-6))
			if (e > s) pieces.push({ start: s, end: e, file: f })
		}
		pieces.sort((x, y) => x.start - y.start)
		// drop overlaps (two files covering the same moment: keep the first)
		const out = []
		for (const p of pieces) {
			const last = out[out.length - 1]
			if (last && p.start < last.end) {
				if (p.end <= last.end) continue
				p.start = last.end
			}
			out.push(p)
		}
		return out
	}

	// ---- clips and gaps
	const stats = {}
	const statFor = (id) => (stats[id] ??= { name: inputName(id), neededFrames: 0, coveredFrames: 0, missing: [] })
	const items = []
	const pushGap = (start, end, label) => {
		const last = items[items.length - 1]
		if (last && last.kind === 'gap' && last.end === start) {
			last.end = end
			if (!last.label.includes(label)) last.label += ` / ${label}`
		} else items.push({ kind: 'gap', start, end, label })
	}
	for (const s of segments) {
		const cam = s.src === BLACK ? null : cams[String(s.src)]
		if (s.src !== BLACK && inputs[s.src] !== undefined && !cam && isCameraInput(header, s.src)) statFor(s.src).neededFrames += s.end - s.start
		if (!cam) {
			const label = inputName(s.src)
			const last = items[items.length - 1]
			if (opts.unmapped === 'hold' && s.src !== BLACK && last?.kind === 'clip' && last.end === s.start) {
				const fileEnd = last.file.endM === Infinity ? Infinity : Math.floor(last.file.endM - last.cam.off)
				last.end = Math.min(s.end, fileEnd)
				if (last.end < s.end) pushGap(last.end, s.end, label)
			} else pushGap(s.start, s.end, label)
			continue
		}
		const st = statFor(s.src)
		st.neededFrames += s.end - s.start
		let pos = s.start
		for (const p of cover(cam, s.start, s.end)) {
			if (p.start > pos) {
				pushGap(pos, p.start, `${cam.name} (no footage)`)
				st.missing.push([pos, p.start])
			}
			items.push({ kind: 'clip', cam, file: p.file, start: p.start, end: p.end, trans: p.start === s.start ? s.dur : 0 })
			st.coveredFrames += p.end - p.start
			pos = p.end
		}
		if (pos < s.end) {
			pushGap(pos, s.end, `${cam.name} (no footage)`)
			st.missing.push([pos, s.end])
		}
	}
	for (const [id, st] of Object.entries(stats)) {
		if (!cams[id]) {
			if (st.neededFrames > 0) warn(`${st.name} was on air for ${TC.fmtDuration(TC.framesToMs(st.neededFrames, rate))} but has no recording added. Those parts are gaps.`)
			continue
		}
		if (st.missing.length) {
			const total = st.missing.reduce((n, [a, b]) => n + b - a, 0)
			warn(`${st.name}: no footage for ${TC.fmtDuration(TC.framesToMs(total, rate))} of its on-air time (first at ${fmt(st.missing[0][0])}). Was the camera recording? Those parts are gaps.`)
		}
		st.missingTc = st.missing.slice(0, 5).map(([a, b]) => [fmt(a), fmt(b)])
		delete st.missing
	}

	// ---- dissolves need spare footage either side of the edit
	for (let i = 0; i < items.length; i++) {
		const b = items[i]
		if (b.kind !== 'clip' || !b.trans) continue
		const a = items[i - 1]
		if (!a || a.kind !== 'clip') {
			b.trans = 0
			continue
		}
		const aHandle = a.file.endM === Infinity ? Infinity : a.file.endM - a.cam.off - a.end
		const bHandle = b.start - (b.file.startM - b.cam.off)
		const half = Math.floor(Math.min(b.trans / 2, aHandle, bHandle, a.end - a.start, b.end - b.start))
		const fitted = Math.max(0, half) * 2
		if (fitted < b.trans) warn(`The dissolve at ${fmt(b.start)} was shortened from ${b.trans} to ${fitted} frames (not enough footage either side).`)
		b.trans = fitted
	}

	// ---- FCPXML
	const tStart = items[0].start
	const tEnd = items[items.length - 1].end
	const origin = useTc ? 0 : tStart - TC.tcToFrames('01:00:00:00', rate)
	const tl = (f) => f - origin
	const T = (f) => fcpFrames(f, rate)
	const tcFormat = dropFrame ? 'DF' : 'NDF'

	const formats = new Map()
	const formatId = (w, h, r) => {
		const key = `${w}x${h}@${r.label}`
		if (!formats.has(key)) formats.set(key, { id: `r${formats.size + 1}`, w, h, r })
		return formats.get(key).id
	}
	const seqFormat = formatId(header.width || 1920, header.height || 1080, rate)

	const audioCam = opts.audioFrom != null && opts.audioFrom !== '' ? cams[String(opts.audioFrom)] : null
	if (opts.audioFrom != null && opts.audioFrom !== '' && !audioCam) warn(`The audio camera (${inputName(opts.audioFrom)}) has no recording added, so audio follows the picture.`)
	const audioPieces = audioCam ? cover(audioCam, tStart, tEnd) : []
	if (audioCam) {
		const covered = audioPieces.reduce((n, p) => n + p.end - p.start, 0)
		if (covered < tEnd - tStart) warn(`${audioCam.name}'s recording doesn't cover the whole timeline, so the audio has gaps.`)
	}

	const assets = new Map()
	const assetFor = (file) => {
		if (!assets.has(file.path)) assets.set(file.path, { id: `a${assets.size + 1}`, file })
		return assets.get(file.path).id
	}
	for (const it of items) if (it.kind === 'clip') assetFor(it.file)
	for (const p of audioPieces) assetFor(p.file)

	const assetXml = [...assets.values()].map(({ id, file }) => {
		const durFrames = file.dur ?? Math.ceil(((tEnd + 1000) * 2) / (rate.num / rate.den / (file.fr.num / file.fr.den)))
		return `    <asset id="${id}" name="${esc(file.name)}" src="${esc(pathToFileURL(file.path).href)}" start="${fcpFrames(file.start, file.fr)}" duration="${fcpFrames(durFrames, file.fr)}" hasVideo="1" format="${formatId(file.width, file.height, file.fr)}"${
			file.hasAudio ? ` hasAudio="1" audioSources="1" audioChannels="${file.channels}" audioRate="48000"` : ''
		}/>`
	})

	// Connected audio clips, each attached to the spine item where it starts.
	const connected = new Map()
	for (const p of audioPieces) {
		const idx = items.findIndex((it) => p.start >= it.start && p.start < it.end)
		if (idx < 0) continue
		const parent = items[idx]
		const local = parent.kind === 'clip' ? p.start + parent.cam.off : tl(p.start)
		const xml = `\n            <asset-clip ref="${assetFor(p.file)}" lane="-1" name="${esc(audioCam.name)} audio" offset="${T(local)}" start="${T(p.start + audioCam.off)}" duration="${T(p.end - p.start)}" srcEnable="audio" tcFormat="${tcFormat}"/>`
		connected.set(idx, (connected.get(idx) || '') + xml)
	}

	const spine = []
	items.forEach((it, i) => {
		if (it.kind === 'clip' && it.trans) {
			const how = segments.find((s) => s.start === it.start)?.how
			spine.push(`          <transition name="Cross Dissolve" offset="${T(tl(it.start) - it.trans / 2)}" duration="${T(it.trans)}"><!-- ${KIND[how] || 'Transition'} on the switcher --></transition>`)
		}
		const inner = connected.get(i) ? `${connected.get(i)}\n          ` : ''
		const attrs = `offset="${T(tl(it.start))}" duration="${T(it.end - it.start)}"`
		if (it.kind === 'clip') {
			spine.push(`          <asset-clip ref="${assetFor(it.file)}" name="${esc(it.cam.name)}" ${attrs} start="${T(it.start + it.cam.off)}" tcFormat="${tcFormat}"${audioCam ? ' srcEnable="video"' : ''}>${inner}</asset-clip>`)
		} else {
			spine.push(`          <gap name="${esc(it.label)}" ${attrs} start="${T(tl(it.start))}">${inner}</gap>`)
		}
	})

	const name = opts.timelineName || header.name || 'ATEM cut'
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.8">
  <resources>
${[...formats.values()].map((f) => `    <format id="${f.id}" frameDuration="${fcpFrames(1, f.r)}" width="${f.w}" height="${f.h}"/>`).join('\n')}
${assetXml.join('\n')}
  </resources>
  <library>
    <event name="${esc(name)}">
      <project name="${esc(name)}">
        <sequence format="${seqFormat}" duration="${T(tEnd - tStart)}" tcStart="${T(tl(tStart))}" tcFormat="${tcFormat}" audioLayout="stereo" audioRate="48k">
          <spine>
${spine.join('\n')}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`

	// ---- CSV cut list
	const row = (cols) => cols.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')
	const csv = [row(['#', 'Timeline TC', 'Switcher TC', 'Type', 'From', 'To', 'Transition frames', 'Note'])]
	let n = 0
	for (const e of events) {
		if (!['initial', 'cut', 'transition', 'black_on', 'black_off', 'sync', 'marker', 'record_start', 'record_stop', 'disconnected', 'reconnected'].includes(e.type)) continue
		const f = masterFrame(e.t)
		csv.push(
			row([
				++n,
				TC.framesToTc(Math.round(tl(f)), rate, dropFrame),
				e.tc || '',
				e.type === 'transition' ? e.style : e.type,
				e.from !== undefined ? inputName(e.from) : '',
				e.to !== undefined ? inputName(e.to) : e.program !== undefined ? inputName(e.program) : '',
				e.type === 'transition' ? Math.round(masterFrame(e.tEnd) - f) : '',
				e.note || (e.n ? `sync #${e.n}` : ''),
			])
		)
	}

	const clips = items.filter((i) => i.kind === 'clip')
	return {
		xml,
		csv: csv.join('\n') + '\n',
		warnings,
		summary: {
			name,
			length: TC.fmtDuration(TC.framesToMs(tEnd - tStart, rate)),
			lengthTc: TC.framesToTc(tEnd - tStart, rate),
			startTc: fmt(tl(tStart)),
			fps: rate.label,
			clips: clips.length,
			dissolves: clips.filter((c) => c.trans).length,
			gaps: items.length - clips.length,
			files: assets.size,
			clock: useTc ? 'switcher timecode' : "the Mac's clock",
		},
		cameras: stats,
	}
}

function isCameraInput(header, id) {
	if (header.cameras) return header.cameras.map(String).includes(String(id))
	const n = Number(id)
	return n >= 1 && n <= 40
}

// Which cameras the log needs footage for, and for how long each was on air.
function camerasInLog(log) {
	const header = log.header
	const out = {}
	const ids = header.cameras ? header.cameras.map(String) : Object.keys(header.inputs || {}).filter((id) => Number(id) >= 1 && Number(id) <= 40)
	for (const id of ids) out[id] = { id, name: (header.inputs || {})[id] || `Input ${id}`, onAirMs: 0, times: 0 }
	const evs = log.events.filter((e) => e.type !== 'session').sort((a, b) => a.t - b.t)
	let program = null
	let black = false
	let since = null
	const close = (t) => {
		if (program != null && !black && out[program] && since != null) out[program].onAirMs += t - since
	}
	for (const e of evs) {
		if (e.type === 'initial') {
			program = String(e.program)
			black = !!e.black
			since = e.t
			if (out[program] && !black) out[program].times++
		} else if (e.type === 'cut' || e.type === 'transition') {
			const t = e.type === 'transition' ? (e.t + e.tEnd) / 2 : e.t
			close(t)
			program = String(e.to)
			since = t
			if (out[program] && !black) out[program].times++
		} else if (e.type === 'black_on' || e.type === 'black_off') {
			close(e.t)
			black = e.type === 'black_on'
			since = e.t
		} else if (e.type === 'end') close(e.t)
	}
	if (!evs.some((e) => e.type === 'end') && evs.length) close(evs[evs.length - 1].t)
	return out
}

module.exports = { buildTimeline, camerasInLog, defaultOptions }
