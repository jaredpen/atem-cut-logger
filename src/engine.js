'use strict'
// The logging engine. Connects to a real ATEM (or the demo switcher), turns its state into cut /
// transition events, writes them to a log file and tells the window about everything.
// No Electron code in here, so it can be tested and previewed on its own.
//
// Emits:
//   'state'   live status for the window (coalesced)
//   'session' a new session started: { header, events: [] }
//   'event'   one logged event (already written to the log file)
//   'sys'     a console line that is not part of the log: { level, msg, t }

const fs = require('fs')
const path = require('path')
const EventEmitter = require('events')
const { performance } = require('perf_hooks')
const { CutTracker, snapshotFromAtemState } = require('./tracker')
const TC = require('./timecode')
const { DemoSwitcher } = require('./demo-switcher')

const now = () => performance.timeOrigin + performance.now()
const PROGRAM_PORT_TYPES = new Set([0, 1, 2, 3, 4, 6, 7]) // sources that can be put on program

class Engine extends EventEmitter {
	constructor({ logDir, appVersion = '0.0.0' } = {}) {
		super()
		this.logDir = logDir
		this.appVersion = appVersion
		this.mode = 'idle' // 'idle' | 'atem' | 'demo'
		this.conn = 'idle' // 'idle' | 'connecting' | 'connected' | 'reconnecting'
		this.ip = ''
		this.me = 0
		this.atem = null
		this.demo = null
		this.info = null // { model, videoMode, fps, width, height }
		this.inputs = {} // id -> { name, short, camera }
		this.rate = null
		this.dropFrame = false
		this.tcAnchor = null // { ms, frames }
		this.live = null // last switcher snapshot
		this.session = null // { header, file, fd, events }
		this.tracker = null
		this.timeTimer = null
		this.slowTimer = null
		this.pushTimer = null
		this.syncCount = 0
	}

	// ------------------------------------------------------------------ public
	async connectAtem(ip, me = 1) {
		await this.stop()
		const { Atem, Enums } = require('atem-connection')
		this.Enums = Enums
		this.mode = 'atem'
		this.conn = 'connecting'
		this.ip = String(ip).trim()
		this.me = Math.max(0, Number(me || 1) - 1)
		const atem = new Atem()
		this.atem = atem
		atem.on('error', (e) => this.sys(`Switcher error: ${e}`, 'error'))
		atem.on('connected', () => {
			if (this.atem !== atem) return
			const st = atem.state
			const modeName = Enums.VideoMode[st.settings.videoMode]
			const fps = TC.rateLabelFromVideoModeName(modeName) || '25'
			const inputs = {}
			for (const [id, inp] of Object.entries(st.inputs || {})) {
				if (!inp || !PROGRAM_PORT_TYPES.has(inp.internalPortType)) continue
				inputs[id] = { name: inp.longName || inp.shortName || `Input ${id}`, short: inp.shortName || String(id), camera: inp.internalPortType === 0 }
			}
			// Ask the switcher for its timecode now and every 2 s.
			const ask = () => atem.requestTime().catch(() => {})
			this._onConnected(
				{
					model: st.info?.productIdentifier || Enums.Model[st.info?.model] || 'ATEM switcher',
					videoMode: modeName,
					fps,
					...TC.resolutionFromVideoModeName(modeName),
					timeMode: Enums.TimeMode?.[st.settings?.timeMode] ?? null,
					inputs,
				},
				() => {
					clearInterval(this.timeTimer)
					ask()
					this.timeTimer = setInterval(ask, 2000)
				}
			)
		})
		atem.on('updatedTime', (time) => {
			if (this.atem !== atem || !this.rate) return
			this._setTimecode(TC.tcToFrames(time, this.rate, !!time.dropFrame), now(), !!time.dropFrame)
		})
		atem.on('stateChanged', (state) => {
			if (this.atem !== atem || this.conn !== 'connected') return
			this._onChange(snapshotFromAtemState(state, this.me))
		})
		atem.on('disconnected', () => {
			if (this.atem !== atem) return
			clearInterval(this.timeTimer)
			this._onDisconnected()
		})
		this.sys(`Connecting to switcher at ${this.ip}…`)
		this.slowTimer = setTimeout(() => {
			if (this.atem === atem && this.conn === 'connecting')
				this.sys(`Still trying to reach ${this.ip}. Check the IP address and that this Mac is on the switcher's network. It keeps trying.`, 'warn')
		}, 6000)
		this._push()
		try {
			await atem.connect(this.ip)
		} catch (e) {
			this.sys(`Could not start the connection: ${e?.message ?? e}`, 'error')
		}
	}

	async startDemo({ format } = {}) {
		await this.stop()
		this.mode = 'demo'
		this.conn = 'connecting'
		this.ip = ''
		this.me = 0
		const demo = new DemoSwitcher({ format })
		this.demo = demo
		demo.on('connected', () => {
			if (this.demo !== demo) return
			const tick = () => this._setTimecode(demo.timecodeFrames(Date.now()), now(), false)
			this._onConnected(demo.info(), () => {
				clearInterval(this.timeTimer)
				tick()
				this.timeTimer = setInterval(tick, 2000)
			})
		})
		demo.on('change', (snap) => {
			if (this.demo === demo && this.conn === 'connected') this._onChange(snap)
		})
		demo.on('disconnected', () => {
			if (this.demo !== demo) return
			clearInterval(this.timeTimer)
			this._onDisconnected()
		})
		demo.on('demo', () => this._push())
		this.sys('Starting the demo switcher. Everything is logged exactly as with a real switcher.')
		this._push()
		demo.connect()
	}

	async stop() {
		clearTimeout(this.slowTimer)
		clearInterval(this.timeTimer)
		this._endSession()
		const atem = this.atem
		const demo = this.demo
		this.atem = null
		this.demo = null
		const wasActive = this.mode !== 'idle'
		this.mode = 'idle'
		this.conn = 'idle'
		this.live = null
		this.tcAnchor = null
		if (demo) demo.disconnect()
		if (atem) {
			try {
				await atem.disconnect()
				await atem.destroy()
			} catch {
				/* ignore */
			}
		}
		if (wasActive) this.sys(demo ? 'Demo switcher stopped.' : 'Disconnected from the switcher.')
		this._push()
	}

	// Close the current log file and start a new one (same switcher, same state).
	newSession() {
		if (this.conn !== 'connected') return false
		this._endSession()
		this._startSession()
		this.tracker.update(this.live, now())
		return true
	}

	marker(text) {
		text = String(text || '').trim()
		if (!text) return false
		if (!this.session) return this.sys('Not logging yet. Connect to a switcher or start the demo first.', 'warn'), false
		this._write({ type: 'marker', t: now(), note: text })
		return true
	}

	sync() {
		if (!this.session) return this.sys('Not logging yet. Connect to a switcher or start the demo first.', 'warn'), false
		this._write({ type: 'sync', t: now(), n: ++this.syncCount })
		return true
	}

	demoCommand(cmd, arg) {
		const d = this.demo
		if (!d) return false
		switch (cmd) {
			case 'preview':
				d.setPreview(arg)
				break
			case 'program':
				d.setProgram(arg)
				break
			case 'cut':
				d.cut()
				break
			case 'auto':
				d.auto()
				break
			case 'tbar':
				d.tbar(arg)
				break
			case 'ftb':
				d.ftb()
				break
			case 'style':
				d.setStyle(arg)
				break
			case 'rate':
				d.setRate(arg)
				break
			case 'record':
				d.setRecording(arg)
				break
			case 'drop':
				d.dropConnection(Number(arg) || 4000)
				break
			case 'director':
				d.setDirector(!!arg?.on, arg || {})
				break
			default:
				return false
		}
		return true
	}

	getState() {
		return {
			mode: this.mode,
			conn: this.conn,
			ip: this.ip,
			me: this.me + 1,
			info: this.info && { ...this.info, inputs: undefined },
			inputs: this.inputs,
			live: this.live,
			tcAnchor: this.tcAnchor && this.rate ? { ...this.tcAnchor, fps: this.rate.label, dropFrame: this.dropFrame } : null,
			session: this.session
				? { file: this.session.file, name: path.basename(this.session.file), startedAt: this.session.header.t, count: this.session.events.length, source: this.session.header.source }
				: null,
			demo: this.demo ? this.demo.settings() : null,
			logDir: this.logDir,
		}
	}

	getSession() {
		return this.session ? { header: this.session.header, events: this.session.events, file: this.session.file } : null
	}

	setLogDir(dir) {
		this.logDir = dir
		this._push()
	}

	sys(msg, level = 'info') {
		this.emit('sys', { msg, level, t: now() })
	}

	// ------------------------------------------------------------------ internals
	async _onConnected(info, startTimecode) {
		clearTimeout(this.slowTimer)
		const owner = this.atem || this.demo
		const first = !this.session
		this.info = info
		this.inputs = info.inputs
		this.rate = TC.getRate(info.fps)
		this.tcAnchor = null
		startTimecode?.()
		// Wait briefly for the switcher's timecode so the first logged event carries it.
		if (!this.tcAnchor) {
			await new Promise((res) => {
				this._tcWait = res
				setTimeout(res, 700)
			})
			this._tcWait = null
		}
		if ((this.atem || this.demo) !== owner) return
		if (!this.tcAnchor) this.sys("The switcher didn't report timecode, so times are logged by this Mac's clock.", 'warn')
		this.conn = 'connected'
		if (first) {
			this.sys(`Connected: ${info.model} · ${TC.prettyVideoMode(info.videoMode)}`)
			this._startSession()
		} else {
			this._write({ type: 'reconnected', t: now() })
			this.sys('Reconnected. Any switching that happened while disconnected is logged at this moment.', 'warn')
		}
		const snap = this.demo ? this.demo.snapshot() : snapshotFromAtemState(this.atem?.state, this.me)
		if (!snap) this.sys(`This switcher has no M/E ${this.me + 1}. Choose M/E 1 in Settings.`, 'error')
		this._onChange(snap)
	}

	_onChange(snap) {
		if (!snap) return
		this.live = snap
		if (this.tracker) this.tracker.update(snap, now())
		this._push()
	}

	_onDisconnected() {
		if (this.conn === 'connected' && this.session) {
			this._write({ type: 'disconnected', t: now() })
			this.sys(this.mode === 'demo' ? 'Demo: connection dropped. Reconnecting…' : 'Lost the switcher. Reconnecting… (logging resumes automatically)', 'error')
		}
		this.conn = 'reconnecting'
		this._push()
	}

	_setTimecode(frames, t, dropFrame) {
		this.dropFrame = dropFrame
		// Keep counting past midnight instead of jumping back to 00:00:00:00.
		if (this.tcAnchor) {
			const expected = this.tcAnchor.frames + TC.msToFrames(t - this.tcAnchor.ms, this.rate)
			const day = TC.tcToFrames('24:00:00:00', this.rate, dropFrame)
			while (frames < expected - day / 2) frames += day
		}
		const had = !!this.tcAnchor
		this.tcAnchor = { ms: t, frames }
		if (this._tcWait) this._tcWait()
		if (!had) this._push()
	}

	_tcFramesAt(t) {
		if (!this.tcAnchor || !this.rate) return null
		return this.tcAnchor.frames + Math.round(TC.msToFrames(t - this.tcAnchor.ms, this.rate))
	}

	_startSession() {
		const info = this.info
		const d = new Date()
		const pad = (x) => String(x).padStart(2, '0')
		const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
		const kind = this.mode === 'demo' ? 'demo' : 'atem'
		fs.mkdirSync(this.logDir, { recursive: true })
		let file = path.join(this.logDir, `${kind}-session-${stamp}.jsonl`)
		for (let i = 2; fs.existsSync(file); i++) file = path.join(this.logDir, `${kind}-session-${stamp}-${i}.jsonl`)
		const inputNames = {}
		for (const [id, inp] of Object.entries(this.inputs)) inputNames[id] = inp.name
		const header = {
			type: 'session',
			t: now(),
			wall: new Date().toISOString(),
			source: kind,
			app: `ATEM Cut Logger ${this.appVersion}`,
			switcherIp: this.ip || null,
			model: info.model,
			videoMode: info.videoMode,
			fps: info.fps,
			width: info.width,
			height: info.height,
			timeMode: info.timeMode ?? null,
			mixEffect: this.me + 1,
			inputs: inputNames,
			cameras: Object.keys(this.inputs).filter((id) => this.inputs[id].camera),
		}
		const fd = fs.openSync(file, 'a')
		fs.writeSync(fd, JSON.stringify(header) + '\n')
		this.session = { header, file, fd, events: [] }
		this.syncCount = 0
		this.tracker = new CutTracker((ev) => this._write(ev))
		this.emit('session', { header, events: [], file })
		this.sys(`Logging to ${file}`)
	}

	_endSession() {
		const s = this.session
		if (!s) return
		this._write({ type: 'end', t: now() })
		try {
			fs.closeSync(s.fd)
		} catch {
			/* ignore */
		}
		this.sys(`Log saved: ${s.file} (${s.events.filter((e) => e.type === 'cut' || e.type === 'transition').length} switches)`)
		this.session = null
		this.tracker = null
	}

	_write(ev) {
		const s = this.session
		if (!s) return
		const rec = { ...ev, wall: new Date(ev.t).toISOString() }
		const frames = this._tcFramesAt(ev.t)
		if (frames !== null) {
			rec.tcFrames = frames
			rec.tc = TC.framesToTc(frames, this.rate, this.dropFrame)
			if (ev.tEnd !== undefined) rec.tcEndFrames = this._tcFramesAt(ev.tEnd)
		}
		try {
			fs.writeSync(s.fd, JSON.stringify(rec) + '\n')
		} catch (e) {
			this.sys(`Could not write to the log file: ${e.message}`, 'error')
		}
		s.events.push(rec)
		this.emit('event', rec)
		this._push()
	}

	_push() {
		if (this.pushTimer) return
		this.pushTimer = setTimeout(() => {
			this.pushTimer = null
			this.emit('state', this.getState())
		}, 15)
	}
}

module.exports = { Engine }
