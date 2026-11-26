'use strict'
// File-level helpers for "Make Resolve timeline", shared by the app and the dev preview.
const fs = require('fs')
const path = require('path')
const { buildTimeline, camerasInLog } = require('./resolve-export')
const { probe, VIDEO_EXT } = require('./media-probe')

function readLog(file) {
	const text = fs.readFileSync(file, 'utf8')
	const rows = []
	const lines = text.split(/\r?\n/).filter(Boolean)
	lines.forEach((l, i) => {
		try {
			rows.push(JSON.parse(l))
		} catch {
			// The last line can be cut short if the Mac lost power mid-write; skip it.
			if (i !== lines.length - 1) throw new Error(`Line ${i + 1} of the log is damaged.`)
		}
	})
	const header = rows.find((r) => r.type === 'session')
	if (!header) throw new Error("This file isn't an ATEM Cut Logger log.")
	return { header, events: rows.filter((r) => r.type !== 'session').sort((a, b) => a.t - b.t) }
}

const sidecar = (logFile) => logFile.replace(/\.jsonl$/i, '') + '.resolve.json'

function openForResolve(file, { liveFile } = {}) {
	try {
		const log = readLog(file)
		let saved = null
		try {
			saved = JSON.parse(fs.readFileSync(sidecar(file), 'utf8'))
		} catch {
			/* first time for this log */
		}
		const ev = log.events
		return {
			ok: true,
			file,
			name: path.basename(file),
			header: log.header,
			cameras: camerasInLog(log),
			hasTc: ev.some((e) => typeof e.tcFrames === 'number'),
			syncMarks: ev.filter((e) => e.type === 'sync').map((e) => ({ n: e.n, tc: e.tc || null })),
			recorded: ev.some((e) => e.type === 'record_start') || !!ev.find((e) => e.type === 'initial')?.recording,
			closed: ev.some((e) => e.type === 'end'),
			stillLogging: liveFile === file,
			saved,
		}
	} catch (e) {
		return { ok: false, reason: e.message }
	}
}

function analyze(file, config) {
	try {
		fs.writeFileSync(sidecar(file), JSON.stringify(config, null, 2))
	} catch {
		/* read-only folder: fine */
	}
	try {
		const r = buildTimeline(readLog(file), config)
		return { ok: true, summary: r.summary, warnings: r.warnings, cameras: r.cameras }
	} catch (e) {
		return { ok: false, reason: e.message }
	}
}

const build = (file, config) => buildTimeline(readLog(file), config)

function writeTimeline(r, out) {
	if (!out.endsWith('.fcpxml')) out += '.fcpxml'
	fs.writeFileSync(out, r.xml)
	const csvFile = out.replace(/\.fcpxml$/, '') + ' cut list.csv'
	fs.writeFileSync(csvFile, r.csv)
	return { ok: true, file: out, csvFile, summary: r.summary, warnings: r.warnings }
}

const probeAll = (paths) => paths.filter((p) => fs.existsSync(p) && fs.statSync(p).isFile()).map((p) => probe(p))

module.exports = { readLog, openForResolve, analyze, build, writeTimeline, probeAll, VIDEO_EXT }
