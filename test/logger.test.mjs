// npm test — checks the cut tracker, the timeline model and a full demo-switcher session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { CutTracker } = require('../src/tracker.js')
const { Engine } = require('../src/engine.js')
const { SessionModel } = require('../renderer/model.js')
const TC = require('../src/timecode.js')

function track(steps) {
	const out = []
	const tr = new CutTracker((e) => out.push(e))
	let s = { program: 1, preview: 2, inTransition: false, style: 'mix', rateFrames: 25, ftbInTransition: false, ftbFullyBlack: false, recording: false }
	for (const [t, change] of steps) {
		s = { ...s, ...change }
		tr.update({ ...s }, t)
	}
	return out
}

test('cut, including the moment program and preview read the same', () => {
	const ev = track([
		[0, {}],
		[1000, { program: 2 }],
		[1006, { preview: 1 }],
	])
	assert.deepEqual(
		ev.map((e) => [e.type, e.from, e.to, e.t]),
		[
			['initial', undefined, undefined, 0],
			['cut', 1, 2, 1000],
		]
	)
})

test('auto transition, in every order the switcher may report it', () => {
	const a = track([[0, {}], [1000, { inTransition: true }], [2000, { inTransition: false, program: 2, preview: 1 }]])
	const b = track([[0, {}], [1000, { inTransition: true }], [1990, { program: 2, preview: 1 }], [2000, { inTransition: false }]])
	const c = track([[0, {}], [1000, { inTransition: true }], [2000, { inTransition: false }], [2020, { program: 2, preview: 1 }]])
	for (const ev of [a, b, c]) {
		const t = ev.filter((e) => e.type !== 'initial')
		assert.equal(t.length, 1)
		assert.equal(t[0].type, 'transition')
		assert.equal(t[0].from, 1)
		assert.equal(t[0].to, 2)
		assert.equal(t[0].t, 1000)
		assert.ok(t[0].tEnd >= 2000 && t[0].tEnd <= 2020)
	}
})

test('T-bar pulled back and key-only transitions are not logged as switches', () => {
	const ev = track([[0, {}], [1000, { inTransition: true }], [1500, { inTransition: false }], [5000, { inTransition: true }], [6000, { inTransition: false }]])
	assert.deepEqual(ev.map((e) => e.type), ['initial'])
})

test('a cut long after a cancelled transition is still a cut', () => {
	const ev = track([[0, {}], [1000, { inTransition: true }], [1500, { inTransition: false }], [4000, { program: 2 }]])
	assert.equal(ev[1].type, 'cut')
})

test('fade to black and switcher recording', () => {
	const ev = track([[0, {}], [500, { recording: true }], [1000, { ftbInTransition: true }], [2000, { ftbInTransition: false, ftbFullyBlack: true }], [3000, { recording: false }]])
	assert.deepEqual(ev.map((e) => e.type), ['initial', 'record_start', 'black_on', 'record_stop'])
	assert.equal(ev[2].t, 1000)
	assert.equal(ev[2].tEnd, 2000)
})

test('timeline model builds segments, overlaps for transitions, and black', () => {
	const m = new SessionModel()
	m.load({ type: 'session', t: 0, fps: '25' }, [
		{ type: 'initial', t: 0, program: 1, preview: 2 },
		{ type: 'cut', t: 1000, from: 1, to: 2 },
		{ type: 'transition', t: 2000, tEnd: 3000, from: 2, to: 3, style: 'mix', rateFrames: 25 },
		{ type: 'black_on', t: 4000, tEnd: 5000 },
		{ type: 'cut', t: 5500, from: 3, to: 1 }, // under black: not on air
		{ type: 'black_off', t: 6000, tEnd: 7000 },
		{ type: 'marker', t: 6500, note: 'hello' },
		{ type: 'end', t: 9000 },
	])
	assert.deepEqual(
		m.segments.map((s) => [s.src, s.start, s.end, s.transIn?.kind ?? null]),
		[
			[1, 0, 1000, null],
			[2, 1000, 3000, 'cut'],
			[3, 2000, 5000, 'mix'],
			['black', 4000, 7000, 'ftb'],
			[1, 6000, 9000, 'ftb'],
		]
	)
	assert.equal(m.switchCount, 3)
	assert.equal(m.markers[0].label, 'hello')
	assert.equal(m.segmentAt(2400).src, 2) // before the middle of the dissolve
	assert.equal(m.segmentAt(2600).src, 3)
	const totals = m.onAirTotals(9000)
	assert.equal(totals[2], 1500)
})

test('timecode helpers', () => {
	const r = TC.getRate('29.97')
	assert.equal(TC.framesToTc(TC.tcToFrames('10:00:00;00', r, true), r, true), '10:00:00;00')
	assert.equal(TC.prettyVideoMode('N4KHDp2997'), '2160p29.97')
	assert.equal(TC.fmtDuration(3723000), '1:02:03')
})

test('demo session end to end: log file, timecode, and the Resolve exporter can read it', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-test-'))
	const engine = new Engine({ logDir: dir, appVersion: 'test' })
	const events = []
	engine.on('event', (e) => events.push(e))
	await engine.startDemo({ format: '1080p25' })
	const wait = (ms) => new Promise((r) => setTimeout(r, ms))
	await wait(900)
	assert.equal(engine.session, null, 'connecting does not start logging by itself')
	assert.equal(engine.startLogging('Sunday Service').ok, true)
	assert.match(path.basename(engine.session.file), /^\d{4}-\d\d-\d\d \d{4} Sunday Service \(demo\)\.jsonl$/)
	engine.demoCommand('rate', 5)
	engine.demoCommand('preview', 3)
	engine.demoCommand('cut')
	await wait(100)
	engine.demoCommand('auto')
	await wait(450)
	engine.demoCommand('style', 'dip')
	engine.demoCommand('rate', 5)
	engine.demoCommand('preview', 4)
	engine.demoCommand('auto')
	await wait(450)
	engine.marker('test note')
	engine.sync()
	engine.demoCommand('program', 3010)
	await wait(50)
	const file = engine.session.file
	await engine.stop()

	const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
	assert.equal(lines[0].type, 'session')
	assert.equal(lines[0].source, 'demo')
	assert.equal(lines[0].name, 'Sunday Service')
	assert.equal(lines[lines.length - 1].type, 'end')
	const switches = lines.filter((e) => e.type === 'cut' || e.type === 'transition')
	assert.deepEqual(
		switches.map((e) => [e.type, e.from, e.to, e.style ?? null]),
		[
			['cut', 1, 3, null],
			['transition', 3, 1, 'mix'],
			['transition', 1, 4, 'dip'],
			['cut', 4, 3010, null],
		]
	)
	assert.ok(lines.every((e) => e.type === 'session' || typeof e.tc === 'string'), 'every event carries the switcher timecode')
	assert.deepEqual(events.length, lines.length - 1)

	// The log feeds straight into the Resolve exporter
	const cams = { sync: 'timecode', cameras: { 1: { file: 'A.mov', fileStartTimecode: '00:00:00:00' }, 3: { file: 'B.mov', fileStartTimecode: '00:00:00:00' }, 4: { file: 'C.mov', fileStartTimecode: '00:00:00:00' } } }
	fs.writeFileSync(path.join(dir, 'cameras.json'), JSON.stringify(cams))
	const x = spawnSync(process.execPath, [path.resolve('tools/export.js'), file, '--config', path.join(dir, 'cameras.json')], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
	assert.equal(x.status, 0, x.stdout + x.stderr)
	const xml = fs.readFileSync(file.replace(/\.jsonl$/, '.fcpxml'), 'utf8')
	assert.match(xml, /<transition name="Cross Dissolve"/)
	fs.rmSync(dir, { recursive: true, force: true })
})

test('start, stop and new log file', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-test-'))
	const engine = new Engine({ logDir: dir, appVersion: 'test' })
	const sys = []
	engine.on('sys', (m) => sys.push(m))
	const ended = []
	engine.on('sessionEnd', (e) => ended.push(e.file))
	const wait = (ms) => new Promise((r) => setTimeout(r, ms))
	assert.equal(engine.startLogging('x').ok, false, "can't log before connecting")
	await engine.startDemo({ format: '1080p25' })
	await wait(900)
	// switching while not logging is not saved, but the operator is warned
	engine.demoCommand('cut')
	await wait(50)
	assert.ok(sys.some((m) => /Not logging: .* was not saved/.test(m.msg)))
	assert.equal(fs.readdirSync(dir).length, 0)

	engine.startLogging('Part 1')
	engine.demoCommand('cut')
	await wait(50)
	const first = engine.session.file
	engine.startLogging('Part 2') // "New log file": closes Part 1, opens Part 2
	engine.demoCommand('cut')
	await wait(50)
	const second = engine.session.file
	engine.stopLogging()
	assert.equal(engine.session, null)
	assert.equal(engine.conn, 'connected', 'still connected after stopping')
	assert.deepEqual(ended, [first, second])
	for (const [f, n] of [[first, 'Part 1'], [second, 'Part 2']]) {
		const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
		assert.equal(rows[0].name, n)
		assert.equal(rows[1].type, 'initial', 'each file opens with what is on air')
		assert.equal(rows.filter((r) => r.type === 'cut').length, 1)
		assert.equal(rows[rows.length - 1].type, 'end')
	}
	// same name twice in the same minute doesn't overwrite
	engine.startLogging('Part 1')
	engine.stopLogging()
	assert.equal(fs.readdirSync(dir).length, 3)
	await engine.stop()
	fs.rmSync(dir, { recursive: true, force: true })
})
