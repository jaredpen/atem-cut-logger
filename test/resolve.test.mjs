// Tests for "Make Resolve timeline": reading camera files and building the FCPXML.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildTimeline, camerasInLog } = require('../src/resolve-export.js')
const { probe } = require('../src/media-probe.js')

// 25 fps, switcher timecode starts at 01:00:00:00 = frame 90000. 1 s = 25 frames = 1000 ms.
const at = (frames) => ({ t: (frames - 90000) * 40, tcFrames: frames })
const LOG = {
	header: { type: 'session', name: 'Test show', fps: '25', width: 1920, height: 1080, inputs: { 1: 'Wide', 2: 'Host', 3: 'Guest', 3010: 'Media Player 1' }, cameras: ['1', '2', '3'] },
	events: [
		{ type: 'initial', ...at(90000), program: 1, preview: 2 },
		{ type: 'sync', ...at(90025), n: 1 },
		{ type: 'cut', ...at(90100), from: 1, to: 2 },
		{ type: 'transition', ...at(90200), tEnd: at(90225).t, tcEndFrames: 90225, style: 'mix', from: 2, to: 3, rateFrames: 25 },
		{ type: 'cut', ...at(90300), from: 3, to: 1 },
		{ type: 'cut', ...at(90350), from: 1, to: 3010 },
		{ type: 'end', ...at(90400) },
	],
}
const file = (p, startTc, durationFrames, extra = {}) => ({ path: p, fps: '25', width: 3840, height: 2160, startTc, durationFrames, hasAudio: true, audioChannels: 2, ...extra })
const CAMS = {
	1: { files: [file('/m/CAM1.mov', '00:59:59:00', 2000)] },
	2: { files: [file('/m/CAM2_A.mov', '01:00:00:00', 150), file('/m/CAM2_B.mov', '01:00:06:00', 500)] }, // two files, split at 90150
	3: { files: [file('/m/CAM3.mov', '01:00:05:00', 500)] },
}

const spine = (xml) => [...xml.matchAll(/<(asset-clip|gap|transition) ([^>]*)>/g)].filter((m) => !/lane=/.test(m[2])).map((m) => ({ kind: m[1], ...Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]])) }))
const sec = (s) => {
	const m = /^(\d+)(?:\/(\d+))?s$/.exec(s)
	return Number(m[1]) / Number(m[2] || 1)
}

test('timecode sync: cuts land on the logged frames, across two files for one camera', () => {
	const r = buildTimeline(LOG, { cameras: CAMS, sync: 'timecode' })
	const s = spine(r.xml)
	const frames = (x) => Math.round(sec(x) * 25)
	assert.deepEqual(
		s.map((i) => [i.kind, i.name ?? null, frames(i.offset), frames(i.duration), i.start ? frames(i.start) : null]),
		[
			['asset-clip', 'Wide', 90000, 100, 90000],
			['asset-clip', 'Host', 90100, 50, 90100], // CAM2_A until its file ends
			['asset-clip', 'Host', 90150, 63, 90150], // CAM2_B carries on
			['transition', 'Cross Dissolve', 90200, 26, null], // starts where the switcher started it
			['asset-clip', 'Guest', 90213, 87, 90213],
			['asset-clip', 'Wide', 90300, 50, 90300],
			['gap', 'Media Player 1', 90350, 50, 90350],
		]
	)
	assert.match(r.xml, /tcStart="3600s"/) // timeline starts at 01:00:00:00, like the switcher
	assert.match(r.xml, /<asset id="a2" name="CAM2_A.mov" src="file:\/\/\/m\/CAM2_A.mov" start="3600s"/)
	assert.equal(r.summary.clips, 5)
	assert.equal(r.summary.dissolves, 1)
	assert.equal(r.cameras[2].coveredFrames, r.cameras[2].neededFrames)
	assert.deepEqual(r.warnings, [])
})

test('missing footage becomes a labelled gap with a warning; dissolves need handles', () => {
	const cams = { ...CAMS, 3: { files: [file('/m/CAM3.mov', '01:00:09:00', 500)] } } // starts at 90225, after the dissolve
	const r = buildTimeline(LOG, { cameras: cams })
	const s = spine(r.xml)
	assert.ok(s.some((i) => i.kind === 'gap' && /Guest \(no footage\)/.test(i.name)))
	assert.ok(!s.some((i) => i.kind === 'transition'))
	assert.ok(r.warnings.some((w) => /Guest: no footage for/.test(w)))
	assert.ok(r.cameras[3].coveredFrames < r.cameras[3].neededFrames)
})

test('clap sync, audio from one camera, hold on previous camera, cuts only', () => {
	const cams = {
		1: { files: [file('/m/A.mov', '', 3000)], clapAt: '00:00:10:00' },
		2: { files: [file('/m/B.mov', '', 3000)], clapAt: '00:00:12:00', offsetFrames: 1 },
		3: { files: [file('/m/C.mov', '', 3000)], clapAt: '00:00:08:00' },
	}
	const r = buildTimeline(LOG, { cameras: cams, sync: 'clap', audioFrom: 1, unmapped: 'hold', dissolves: false })
	const s = spine(r.xml)
	const f = (x) => Math.round(sec(x) * 25)
	// clap (sync #1) is at switcher frame 90025; Wide's clap is at its frame 250 -> offset -89775
	assert.equal(f(s[0].start), 90000 - 89775)
	assert.equal(f(s[1].start), 90100 - (90025 - 300) + 1) // Host, with the 1-frame nudge
	assert.ok(!s.some((i) => i.kind === 'transition'))
	assert.ok(!s.some((i) => i.kind === 'gap'), 'media player held on previous camera')
	assert.equal(s[s.length - 1].name, 'Wide')
	assert.match(r.xml, /lane="-1" name="Wide audio"/)
	assert.match(r.xml, /srcEnable="video"/)
})

test('clap sync without a clap time is a clear error', () => {
	assert.throws(() => buildTimeline(LOG, { cameras: { 1: { files: [file('/m/A.mov', '', 3000)] } }, sync: 'clap' }), /Wide: type the timecode where the clap is/)
})

test('cameras in log: on-air time per camera', () => {
	const c = camerasInLog(LOG)
	assert.equal(Math.round(c[1].onAirMs), 6000)
	assert.equal(c[1].times, 2)
	assert.equal(Math.round(c[2].onAirMs), 4500)
})

test('real files: reads timecode from .mov and .mp4, and builds a valid timeline', { skip: !spawnSync('ffmpeg', ['-version']).stdout }, () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-media-'))
	const mk = (name, tc, secs, rate = '25') =>
		spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${rate}`, '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-t', String(secs), '-timecode', tc, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', path.join(dir, name)])
	mk('CAM1.mov', '00:59:59:00', 30)
	mk('CAM2.mp4', '01:00:00:00', 20)
	mk('CAM3.mov', '01:00:05:00', 20)
	const p1 = probe(path.join(dir, 'CAM1.mov'))
	const p2 = probe(path.join(dir, 'CAM2.mp4'))
	assert.equal(p1.startTc, '00:59:59:00')
	assert.equal(p2.startTc, '01:00:00:00')
	assert.equal(p1.fps, '25')
	assert.equal(p1.durationFrames, 750)
	assert.equal(p1.hasAudio, true)
	const cams = { 1: { files: [p1] }, 2: { files: [p2] }, 3: { files: [probe(path.join(dir, 'CAM3.mov'))] } }
	const r = buildTimeline(LOG, { cameras: cams })
	const out = path.join(dir, 't.fcpxml')
	fs.writeFileSync(out, r.xml)
	const lint = spawnSync('xmllint', ['--noout', out], { encoding: 'utf8' })
	if (!lint.error) assert.equal(lint.status, 0, lint.stderr)
	assert.deepEqual(r.warnings, [])
	fs.rmSync(dir, { recursive: true, force: true })
})
