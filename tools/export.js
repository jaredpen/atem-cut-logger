#!/usr/bin/env node
'use strict'
// Command-line version of "Make Resolve timeline" (the app has the same thing with a window).
//
//   node tools/export.js <log.jsonl> --init                 write a cameras.json to fill in
//   node tools/export.js <log.jsonl> [--config cameras.json] [--out timeline.fcpxml]
//
// cameras.json: { "sync": "timecode"|"clap", "clapNumber": 1, "audioFrom": null, "range": "all",
//   "unmapped": "gap", "dissolves": true, "timelineName": "",
//   "cameras": { "1": { "files": ["/path/CAM1_A001.mov"], "clapAt": "", "offsetFrames": 0, "fileStartTimecode": "" } } }

const fs = require('fs')
const path = require('path')
const { buildTimeline, camerasInLog } = require('../src/resolve-export')
const { probe } = require('../src/media-probe')

process.on('uncaughtException', (err) => {
	console.error(`\nError: ${err.message}`)
	process.exit(1)
})

const args = process.argv.slice(2)
const flag = (name, def) => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 ? args[i + 1] : def
}
const logPath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && /^--(config|out)$/.test(args[i - 1])))
if (!logPath) {
	console.log('Usage:\n  node tools/export.js <log.jsonl> --init\n  node tools/export.js <log.jsonl> [--config cameras.json] [--out timeline.fcpxml]')
	process.exit(1)
}

function readLog(file) {
	const rows = fs
		.readFileSync(file, 'utf8')
		.split(/\r?\n/)
		.filter(Boolean)
		.map((l, i, all) => {
			try {
				return JSON.parse(l)
			} catch {
				if (i === all.length - 1) return null // cut short by a power loss
				throw new Error(`${file} line ${i + 1} is damaged`)
			}
		})
		.filter(Boolean)
	const header = rows.find((r) => r.type === 'session')
	if (!header) throw new Error("This isn't an ATEM Cut Logger log.")
	return { header, events: rows.filter((r) => r.type !== 'session') }
}

const log = readLog(logPath)
const configPath = flag('config', logPath.replace(/\.jsonl$/, '') + '.cameras.json')

if (args.includes('--init')) {
	if (fs.existsSync(configPath)) throw new Error(`${configPath} already exists.`)
	const cameras = {}
	for (const c of Object.values(camerasInLog(log))) cameras[c.id] = { name: c.name, files: [], clapAt: '', offsetFrames: 0, fileStartTimecode: '' }
	const hasTc = log.events.some((e) => typeof e.tcFrames === 'number')
	fs.writeFileSync(configPath, JSON.stringify({ sync: hasTc ? 'timecode' : 'clap', clapNumber: 1, audioFrom: null, range: 'all', unmapped: 'gap', dissolves: true, timelineName: log.header.name || '', cameras }, null, 2))
	console.log(`Wrote ${configPath}. Add each camera's file(s), then run:\n  node tools/export.js "${logPath}"`)
	process.exit(0)
}

if (!fs.existsSync(configPath)) throw new Error(`No ${configPath}. Make one with --init.`)
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const dir = path.dirname(path.resolve(configPath))
const cameras = {}
for (const [id, c] of Object.entries(cfg.cameras || {})) {
	const list = [].concat(c.files || [], c.file ? [c.file] : []).filter(Boolean)
	cameras[id] = {
		clapAt: c.clapAt || '',
		offsetFrames: c.offsetFrames || 0,
		files: list.map((f) => {
			const p = path.resolve(dir, f)
			const info = fs.existsSync(p) ? probe(p) : { path: p, reason: 'file not found' }
			if (!fs.existsSync(p)) console.warn(`Camera ${id}: ${p} not found here; the timeline still points to it.`)
			return { ...info, path: p, startTcOverride: c.fileStartTimecode || '' }
		}),
	}
}
const r = buildTimeline(log, { ...cfg, cameras })
const out = flag('out', logPath.replace(/\.jsonl$/, '') + '.fcpxml')
fs.writeFileSync(out, r.xml)
const csvPath = out.replace(/\.fcpxml$/, '') + ' cut list.csv'
fs.writeFileSync(csvPath, r.csv)
console.log(`Timeline "${r.summary.name}": ${r.summary.length}, ${r.summary.clips} clips, ${r.summary.dissolves} dissolves, ${r.summary.gaps} gaps.`)
console.log(`Wrote ${out}\nWrote ${csvPath}`)
if (r.warnings.length) console.log(`\nWarnings:\n${r.warnings.map((w) => '  - ' + w).join('\n')}`)
