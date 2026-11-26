'use strict'
// A pretend ATEM switcher for demo mode. It behaves like the real one as seen over the network:
// program/preview buses, CUT, AUTO, T-bar, fade to black, the switcher's own recorder, and dropped
// connections. Its state goes through exactly the same cut tracker and log file as a real switcher.

const EventEmitter = require('events')
const TC = require('./timecode')

const FORMATS = {
	'2160p23.976': { videoMode: 'N4KHDp2398', fps: '23.976' },
	'2160p25': { videoMode: 'P4KHDp25', fps: '25' },
	'2160p29.97': { videoMode: 'N4KHDp2997', fps: '29.97' },
	'2160p50': { videoMode: 'P4KHDp5000', fps: '50' },
	'2160p59.94': { videoMode: 'N4KHDp5994', fps: '59.94' },
	'1080p25': { videoMode: 'P1080p25', fps: '25' },
	'1080p29.97': { videoMode: 'N1080p2997', fps: '29.97' },
	'1080p50': { videoMode: 'P1080p50', fps: '50' },
	'1080p59.94': { videoMode: 'N1080p5994', fps: '59.94' },
}

const DEMO_INPUTS = {
	0: { name: 'Black', short: 'BLK', camera: false },
	1: { name: 'Wide', short: 'CAM1', camera: true },
	2: { name: 'Host', short: 'CAM2', camera: true },
	3: { name: 'Guest', short: 'CAM3', camera: true },
	4: { name: 'Two-shot', short: 'CAM4', camera: true },
	5: { name: 'Audience', short: 'CAM5', camera: true },
	6: { name: 'Jib', short: 'CAM6', camera: true },
	7: { name: 'Stage left', short: 'CAM7', camera: true },
	8: { name: 'Stage right', short: 'CAM8', camera: true },
	1000: { name: 'Color Bars', short: 'BARS', camera: false },
	3010: { name: 'Media Player 1', short: 'MP1', camera: false },
}

const rand = (a, b) => a + Math.random() * (b - a)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

class DemoSwitcher extends EventEmitter {
	constructor({ format = '2160p29.97' } = {}) {
		super()
		this.formatName = FORMATS[format] ? format : '2160p29.97'
		const f = FORMATS[this.formatName]
		this.videoMode = f.videoMode
		this.rate = TC.getRate(f.fps)
		this.inputs = JSON.parse(JSON.stringify(DEMO_INPUTS))
		this.s = {
			program: 1,
			preview: 2,
			inTransition: false,
			transitionPos: 0,
			style: 'mix',
			ftbInTransition: false,
			ftbFullyBlack: false,
			recording: false,
		}
		this.rates = { mix: 30, dip: 30, wipe: 30, dve: 30, sting: 45 }
		this.ftbRate = 30
		this.connected = false
		this.timers = new Set()
		this.anim = null
		this.director = { on: false, minS: 3, maxS: 9, timer: null }
		this.tcOffsetMs = 0
	}

	info() {
		const res = TC.resolutionFromVideoModeName(this.videoMode)
		return {
			model: 'Demo switcher (simulated ATEM Television Studio 4K8)',
			videoMode: this.videoMode,
			fps: this.rate.label,
			...res,
			inputs: this.inputs,
		}
	}

	settings() {
		return {
			style: this.s.style,
			rateFrames: this.rates[this.s.style],
			ftbRate: this.ftbRate,
			director: { on: this.director.on, minS: this.director.minS, maxS: this.director.maxS },
			recording: this.s.recording,
			connected: this.connected,
			format: this.formatName,
		}
	}

	snapshot() {
		return { ...this.s, rateFrames: this.rates[this.s.style] }
	}

	// Time-of-day timecode, like an ATEM set to "time of day".
	timecodeFrames(ms) {
		const d = new Date(ms + this.tcOffsetMs)
		const fps = this.rate.nominal
		return ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * fps + Math.floor((d.getMilliseconds() / 1000) * fps)
	}

	connect() {
		this.connected = true
		this._later(() => this.emit('connected'), 30)
	}

	disconnect() {
		this.setDirector(false)
		this.connected = false
		for (const t of this.timers) clearTimeout(t)
		this.timers.clear()
		clearInterval(this.anim)
		this.anim = null
	}

	_later(fn, ms) {
		const t = setTimeout(() => {
			this.timers.delete(t)
			fn()
		}, ms)
		this.timers.add(t)
		return t
	}

	_change() {
		if (this.connected) this.emit('change', this.snapshot())
		this.emit('demo', this.settings())
	}

	frameMs() {
		return TC.framesToMs(1, this.rate)
	}

	busy() {
		return this.s.inTransition || this.s.ftbInTransition
	}

	// ---- buses
	setPreview(id) {
		id = Number(id)
		if (!(id in this.inputs) || this.s.inTransition) return
		this.s.preview = id
		this._change()
	}

	// Pressing a program-bus button is a direct cut to that source.
	setProgram(id) {
		id = Number(id)
		if (!(id in this.inputs) || this.s.inTransition || id === this.s.program) return
		this.s.program = id
		this._change()
	}

	cut() {
		if (this.s.inTransition) return
		const old = this.s.program
		// Like the real switcher, program and preview briefly read the same during a cut.
		this.s.program = this.s.preview
		this._change()
		this._later(() => {
			this.s.preview = old
			this._change()
		}, 6)
	}

	auto() {
		if (this.busy()) return
		const frames = this.rates[this.s.style]
		const duration = frames * this.frameMs()
		const start = Date.now()
		this.s.inTransition = true
		this.s.transitionPos = 0
		this._change()
		clearInterval(this.anim)
		this.anim = setInterval(() => {
			const p = Math.min(1, (Date.now() - start) / duration)
			if (p < 1) {
				this.s.transitionPos = p
				this._change()
				return
			}
			clearInterval(this.anim)
			this.anim = null
			this._finishTransition()
		}, 40)
	}

	// The real switcher can report "transition done" and the new program source in either order,
	// sometimes as separate messages. The demo picks an order at random to exercise the logger.
	_finishTransition() {
		const old = this.s.program
		const order = Math.random()
		const swap = () => {
			this.s.program = this.s.preview
			this.s.preview = old
		}
		if (order < 0.5) {
			swap()
			this.s.inTransition = false
			this.s.transitionPos = 0
			this._change()
		} else if (order < 0.75) {
			swap()
			this._change() // program changes while still "in transition"
			this._later(() => {
				this.s.inTransition = false
				this.s.transitionPos = 0
				this._change()
			}, 15)
		} else {
			this.s.inTransition = false
			this.s.transitionPos = 0
			this._change() // "done" first...
			this._later(() => {
				swap()
				this._change() // ...then the new program source
			}, 20)
		}
	}

	// Manual T-bar, 0..1. Reaching 1 completes the transition; going back to 0 cancels it.
	tbar(pos) {
		if (this.s.ftbInTransition) return
		pos = Math.max(0, Math.min(1, Number(pos)))
		if (!this.s.inTransition) {
			if (pos <= 0 || pos >= 1) return
			this.s.inTransition = true
		}
		if (pos >= 1) {
			clearInterval(this.anim)
			this._finishTransition()
			return
		}
		if (pos <= 0) {
			this.s.inTransition = false
			this.s.transitionPos = 0
			this._change()
			return
		}
		this.s.transitionPos = pos
		this._change()
	}

	ftb() {
		if (this.s.ftbInTransition) return
		this.s.ftbInTransition = true
		this._change()
		this._later(() => {
			this.s.ftbInTransition = false
			this.s.ftbFullyBlack = !this.s.ftbFullyBlack
			this._change()
		}, this.ftbRate * this.frameMs())
	}

	setStyle(style) {
		if (!(style in this.rates) || this.s.inTransition) return
		this.s.style = style
		this._change()
	}

	setRate(frames) {
		frames = Math.round(Number(frames))
		if (!(frames >= 1 && frames <= 250)) return
		this.rates[this.s.style] = frames
		this._change()
	}

	setRecording(on) {
		this.s.recording = !!on
		this._change()
	}

	// Network drop: the logger loses the switcher for `ms`, while the switcher carries on.
	dropConnection(ms = 4000) {
		if (!this.connected) return
		this.connected = false
		this.emit('disconnected')
		this.emit('demo', this.settings())
		this._later(() => {
			this.connected = true
			this.emit('connected')
			this.emit('demo', this.settings())
		}, ms)
	}

	// ---- auto director: picks a preview, then takes it with a cut or a transition
	setDirector(on, opts = {}) {
		if (opts.minS != null) this.director.minS = Math.max(0.5, Number(opts.minS))
		if (opts.maxS != null) this.director.maxS = Math.max(this.director.minS, Number(opts.maxS))
		this.director.on = !!on
		clearTimeout(this.director.timer)
		this.timers.delete(this.director.timer)
		if (this.director.on) this._scheduleDirector()
		this.emit('demo', this.settings())
	}

	_scheduleDirector() {
		if (!this.director.on) return
		const wait = rand(this.director.minS, this.director.maxS) * 1000
		this.director.timer = this._later(() => this._directorStep(), wait)
	}

	_directorStep() {
		if (!this.director.on) return
		if (this.busy() || this.s.ftbFullyBlack) return this._scheduleDirector()
		const cams = Object.keys(this.inputs)
			.map(Number)
			.filter((id) => this.inputs[id].camera && id !== this.s.program)
		const roll = Math.random()
		if (roll < 0.04) {
			// Occasionally roll a clip from the media player with a direct program-bus cut.
			this.setProgram(3010)
			return this._scheduleDirector()
		}
		this.setPreview(pick(cams))
		this._later(() => {
			if (!this.director.on) return
			if (this.busy()) return this._scheduleDirector()
			const r = Math.random()
			if (r < 0.62) this.cut()
			else this.auto()
			this._scheduleDirector()
		}, rand(500, 1400))
	}
}

module.exports = { DemoSwitcher, FORMATS, DEMO_INPUTS }
