// Editor-style timeline of what the logger recorded. A PROGRAM track shows the cut as it went out;
// one track per camera shows when that camera was on air; "Other sources" holds media players,
// bars, black and so on. It only visualises the session model; it never changes the log.
;(function () {
	'use strict'
	const { BLACK } = { BLACK: 'black' }

	const PALETTE = ['#3d7be0', '#2fae84', '#e08a2e', '#9b62db', '#cfae24', '#de5b8a', '#36abc9', '#86b83a', '#c46b3f', '#6f7fe0']
	const OTHER_COLOR = '#5b6270'
	const BLACK_COLOR = '#07080a'
	const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400]
	const KIND_LABEL = { cut: 'CUT', mix: 'MIX', dip: 'DIP', wipe: 'WIPE', dve: 'DVE', sting: 'STING', ftb: 'FTB' }

	class Timeline {
		constructor(canvas, tooltip) {
			this.c = canvas
			this.ctx = canvas.getContext('2d')
			this.tip = tooltip
			this.model = null
			this.live = null
			this.inputs = {}
			this.isLive = false
			this.tcAnchor = null
			this.fpsLabel = '25'
			this.pxPerSec = 14
			this.follow = true
			this.viewEnd = Date.now()
			this.headerW = 184
			this.rulerH = 40
			this.tracks = []
			this.mouse = null
			this.flash = null // { t, until }
			this.liveTransStart = null
			this.onFollowChange = null
			this.colorCache = {}
			this.dpr = 1
			this.w = 0
			this.h = 0
			this._bind()
			const ro = new ResizeObserver(() => this._resize())
			ro.observe(canvas.parentElement)
			this._resize()
			const loop = () => {
				this.draw()
				requestAnimationFrame(loop)
			}
			requestAnimationFrame(loop)
		}

		// ---------------------------------------------------------------- data in
		setModel(model, { isLive }) {
			this.model = model
			this.isLive = isLive
			if (!isLive) this.fit()
		}

		setInputs(inputs) {
			this.inputs = inputs || {}
			const cams = Object.keys(this.inputs)
				.filter((id) => this.inputs[id].camera)
				.map(Number)
				.sort((a, b) => a - b)
			this.colorCache = {}
			cams.forEach((id, i) => (this.colorCache[id] = PALETTE[i % PALETTE.length]))
			this.tracks = [
				{ kind: 'pgm', label: 'PROGRAM' },
				...cams.map((id) => ({ kind: 'cam', src: id, label: this.inputs[id].name, tag: this.inputs[id].short || `Input ${id}`, sub: `${this.inputs[id].short ? this.inputs[id].short + ' · ' : ''}input ${id}` })),
				{ kind: 'other', label: 'Other sources', sub: 'media, bars, black…' },
			]
		}

		setLive(live, tcAnchor) {
			const wasIn = this.live?.inTransition || this.live?.ftbInTransition
			const nowIn = live?.inTransition || live?.ftbInTransition
			if (nowIn && !wasIn) this.liveTransStart = Date.now()
			if (!nowIn) this.liveTransStart = null
			this.live = live
			if (tcAnchor) {
				this.tcAnchor = { t: tcAnchor.ms, frames: tcAnchor.frames, dropFrame: tcAnchor.dropFrame }
				this.fpsLabel = tcAnchor.fps
			}
		}

		setFps(label) {
			if (label) this.fpsLabel = label
		}

		// ---------------------------------------------------------------- time helpers
		rate() {
			try {
				return TC.getRate(this.fpsLabel)
			} catch {
				return TC.getRate('25')
			}
		}

		anchor() {
			if (this.isLive && this.tcAnchor) return this.tcAnchor
			if (this.model?.tcRef) return { t: this.model.tcRef.t, frames: this.model.tcRef.frames, dropFrame: this.tcAnchor?.dropFrame }
			return { t: this.model?.startT ?? Date.now(), frames: 0, elapsed: true }
		}

		tcFramesAt(t) {
			const a = this.anchor()
			return a.frames + TC.msToFrames(t - a.t, this.rate())
		}

		tcAt(t) {
			const a = this.anchor()
			return TC.framesToTc(Math.floor(this.tcFramesAt(t)), this.rate(), !!a.dropFrame)
		}

		now() {
			if (this.isLive) return Date.now()
			return this.model?.endT ?? this.model?.events[this.model.events.length - 1]?.t ?? Date.now()
		}

		span() {
			return ((this.w - this.headerW) / this.pxPerSec) * 1000
		}

		viewStart() {
			return this.viewEnd - this.span()
		}

		x(t) {
			return this.headerW + ((t - this.viewStart()) / 1000) * this.pxPerSec
		}

		tAtX(x) {
			return this.viewStart() + ((x - this.headerW) / this.pxPerSec) * 1000
		}

		color(src) {
			if (src === BLACK) return BLACK_COLOR
			return this.colorCache[src] || OTHER_COLOR
		}

		name(src) {
			if (src === BLACK) return 'Black (fade to black)'
			const i = this.inputs[src]
			return i ? i.name : `Input ${src}`
		}

		isCamera(src) {
			return src !== BLACK && !!this.inputs[src]?.camera
		}

		// ---------------------------------------------------------------- view control
		setFollow(on) {
			if (this.follow === !!on) return
			this.follow = !!on
			this.onFollowChange?.(this.follow)
		}

		zoom(factor, atX) {
			const ax = atX ?? (this.follow ? this.x(this.now()) : this.headerW + (this.w - this.headerW) / 2)
			const tAt = this.tAtX(ax)
			this.pxPerSec = Math.min(400, Math.max(0.01, this.pxPerSec * factor))
			if (!this.follow) this.viewEnd = tAt + ((this.w - ax) / this.pxPerSec) * 1000
		}

		fit() {
			const start = this.model?.startT
			if (start == null || !this.w) return
			const dur = Math.max(10000, this.now() - start)
			this.pxPerSec = Math.min(400, Math.max(0.01, (this.w - this.headerW - 40) / ((dur * 1.04) / 1000)))
			this.viewEnd = start + this.span() - 20 / this.pxPerSec * 1000
			if (this.isLive) this.setFollow(true)
		}

		reveal(t) {
			this.setFollow(false)
			this.viewEnd = t + this.span() / 2
			this.flash = { t, until: performance.now() + 2200 }
		}

		goLive() {
			this.setFollow(true)
		}

		// ---------------------------------------------------------------- input
		_bind() {
			const c = this.c
			c.addEventListener(
				'wheel',
				(e) => {
					e.preventDefault()
					const r = c.getBoundingClientRect()
					const mx = e.clientX - r.left
					if (e.ctrlKey || e.metaKey || e.altKey) {
						this.zoom(Math.exp(-e.deltaY * 0.01), mx)
						return
					}
					const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
					this._pan(d)
				},
				{ passive: false }
			)
			let drag = null
			c.addEventListener('mousedown', (e) => {
				const r = c.getBoundingClientRect()
				if (e.clientX - r.left < this.headerW) return
				drag = { x: e.clientX, end: this.viewEnd }
				if (this.follow) {
					drag.end = this.viewEnd
					this.setFollow(false)
				}
				c.classList.add('dragging')
			})
			window.addEventListener('mousemove', (e) => {
				const r = c.getBoundingClientRect()
				this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY, inside: e.target === c }
				if (drag) {
					this.viewEnd = drag.end - ((e.clientX - drag.x) / this.pxPerSec) * 1000
					this._clampToLive()
				}
			})
			window.addEventListener('mouseup', () => {
				drag = null
				c.classList.remove('dragging')
			})
			c.addEventListener('mouseleave', () => {
				if (this.mouse) this.mouse.inside = false
			})
			c.addEventListener('dblclick', () => (this.isLive ? this.goLive() : this.fit()))
		}

		_pan(deltaPx) {
			if (this.follow) this.setFollow(false)
			this.viewEnd += (deltaPx / this.pxPerSec) * 1000
			this._clampToLive()
		}

		// Scrolling back to the live edge picks up "follow live" again.
		_clampToLive() {
			const liveEnd = this.now() + this.span() * 0.12
			if (this.viewEnd >= liveEnd) {
				this.viewEnd = liveEnd
				if (this.isLive) this.setFollow(true)
			}
		}

		_resize() {
			const p = this.c.parentElement
			this.dpr = window.devicePixelRatio || 1
			this.w = p.clientWidth
			this.h = p.clientHeight
			this.c.width = Math.round(this.w * this.dpr)
			this.c.height = Math.round(this.h * this.dpr)
			this.c.style.width = this.w + 'px'
			this.c.style.height = this.h + 'px'
		}

		layout() {
			const top = this.rulerH
			const avail = this.h - top - 8
			const n = Math.max(1, this.tracks.length - 1)
			const pgmH = Math.max(40, Math.min(64, avail * 0.17))
			const gap = 8
			const th = Math.max(22, Math.min(54, (avail - pgmH - gap) / n))
			let y = top + 4
			for (const tr of this.tracks) {
				tr.y = y
				tr.h = tr.kind === 'pgm' ? pgmH : th
				y += tr.h + (tr.kind === 'pgm' ? gap : 0)
			}
			return y
		}

		trackFor(src) {
			if (src === BLACK) return null
			if (this.isCamera(src)) return this.tracks.find((t) => t.src === src)
			return this.tracks.find((t) => t.kind === 'other')
		}

		// ---------------------------------------------------------------- drawing
		draw() {
			const ctx = this.ctx
			if (!this.w || !this.h) return
			if (this.follow) this.viewEnd = this.now() + this.span() * 0.12
			ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
			ctx.clearRect(0, 0, this.w, this.h)
			ctx.fillStyle = '#12151b'
			ctx.fillRect(0, 0, this.w, this.h)
			const bottom = this.layout()
			const L = this.headerW

			// lanes
			for (const tr of this.tracks) {
				ctx.fillStyle = tr.kind === 'pgm' ? '#171b23' : this.tracks.indexOf(tr) % 2 ? '#151820' : '#14171e'
				ctx.fillRect(L, tr.y, this.w - L, tr.h)
			}

			ctx.save()
			ctx.beginPath()
			ctx.rect(L, 0, this.w - L, this.h)
			ctx.clip()
			const hasData = !!(this.model && this.model.events.length)
			const ticks = hasData ? this._ticks() : { major: [], minor: [], step: 1 }
			this._drawGrid(ticks, bottom)
			if (this.model) {
				this._drawGaps(bottom)
				this._drawSegments()
				this._drawLiveTransition()
				this._drawMarkers(bottom)
			}
			this._drawRuler(ticks)
			if (hasData) this._drawPlayhead(bottom)
			this._drawFlash(bottom)
			ctx.restore()

			this._drawHeaders()
			this._drawEmpty()
			this._tooltip()
		}

		_ticks() {
			const rate = this.rate()
			const fpsReal = rate.num / rate.den
			let step = TICK_STEPS[TICK_STEPS.length - 1]
			for (const s of TICK_STEPS) {
				if (s * this.pxPerSec >= 96) {
					step = s
					break
				}
			}
			const stepFrames = step * rate.nominal
			const t0 = this.viewStart()
			const t1 = this.viewEnd
			const f0 = this.tcFramesAt(t0)
			const a = this.anchor()
			const first = Math.ceil(f0 / stepFrames) * stepFrames
			const out = []
			for (let f = first, i = 0; i < 400; f += stepFrames, i++) {
				const t = a.t + ((f - a.frames) / fpsReal) * 1000
				if (t > t1) break
				if (f >= 0) out.push({ t, f, major: true })
			}
			const minor = []
			const sub = step >= 60 && step % 5 === 0 ? 5 : step % 2 === 0 ? 2 : 5
			for (const tk of out.concat([{ t: out.length ? out[0].t - step * 1000 : t0, f: 0 }])) {
				for (let k = 1; k < sub; k++) minor.push(tk.t + (k * step * 1000) / sub)
			}
			return { major: out, minor, step }
		}

		_drawGrid(ticks, bottom) {
			const ctx = this.ctx
			ctx.strokeStyle = 'rgba(255,255,255,0.045)'
			ctx.lineWidth = 1
			ctx.beginPath()
			for (const tk of ticks.major) {
				const x = Math.round(this.x(tk.t)) + 0.5
				ctx.moveTo(x, this.rulerH)
				ctx.lineTo(x, bottom)
			}
			ctx.stroke()
		}

		_drawRuler(ticks) {
			const ctx = this.ctx
			const L = this.headerW
			ctx.fillStyle = '#1a1e27'
			ctx.fillRect(L, 0, this.w - L, this.rulerH)
			ctx.fillStyle = '#262b36'
			ctx.fillRect(L, this.rulerH - 1, this.w - L, 1)

			// switcher's own recording
			if (this.model) {
				for (const r of this.model.recRanges) {
					const x1 = this.x(r.start)
					const x2 = this.x(r.end ?? this.now())
					if (x2 < L || x1 > this.w) continue
					ctx.fillStyle = 'rgba(229,72,77,0.85)'
					ctx.fillRect(x1, this.rulerH - 4, Math.max(2, x2 - x1), 3)
					ctx.font = '600 9px -apple-system, system-ui, sans-serif'
					ctx.fillText('SWITCHER REC', Math.max(x1, L) + 3, this.rulerH - 7)
				}
			}

			ctx.strokeStyle = '#4a5163'
			ctx.beginPath()
			for (const t of ticks.minor) {
				const x = Math.round(this.x(t)) + 0.5
				ctx.moveTo(x, this.rulerH - 6)
				ctx.lineTo(x, this.rulerH - 1)
			}
			ctx.stroke()
			ctx.strokeStyle = '#7d8598'
			ctx.beginPath()
			ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
			ctx.fillStyle = '#aab1c0'
			const showFrames = ticks.step < 2
			for (const tk of ticks.major) {
				const x = Math.round(this.x(tk.t)) + 0.5
				ctx.moveTo(x, this.rulerH - 13)
				ctx.lineTo(x, this.rulerH - 1)
				let label = TC.framesToTc(tk.f, this.rate(), !!this.anchor().dropFrame)
				if (!showFrames) label = label.slice(0, 8)
				ctx.fillText(label, x + 4, 14)
			}
			ctx.stroke()
		}

		_drawGaps(bottom) {
			const ctx = this.ctx
			for (const g of this.model.gaps) {
				const x1 = this.x(g.start)
				const x2 = this.x(g.end ?? this.now())
				if (x2 < this.headerW || x1 > this.w) continue
				ctx.save()
				ctx.beginPath()
				ctx.rect(x1, this.rulerH, Math.max(1, x2 - x1), bottom - this.rulerH)
				ctx.clip()
				ctx.fillStyle = 'rgba(229,72,77,0.08)'
				ctx.fillRect(x1, this.rulerH, x2 - x1, bottom - this.rulerH)
				ctx.strokeStyle = 'rgba(229,72,77,0.25)'
				ctx.lineWidth = 6
				ctx.beginPath()
				for (let x = x1 - bottom; x < x2 + bottom; x += 16) {
					ctx.moveTo(x, bottom)
					ctx.lineTo(x + bottom, 0)
				}
				ctx.stroke()
				ctx.restore()
				if (x2 - x1 > 70) {
					ctx.fillStyle = '#ff9a9d'
					ctx.font = '600 10px -apple-system, system-ui, sans-serif'
					ctx.fillText('NO CONNECTION', Math.max(x1, this.headerW) + 6, this.rulerH + 14)
				}
			}
		}

		_clip(x1, x2, y, h, color, label, opts = {}) {
			const ctx = this.ctx
			const L = this.headerW
			if (x2 < L - 2 || x1 > this.w + 2) return
			const w = Math.max(1.5, x2 - x1)
			const r = Math.min(4, w / 2, h / 4)
			ctx.save()
			ctx.globalAlpha = opts.alpha ?? 1
			ctx.fillStyle = color
			ctx.beginPath()
			ctx.roundRect(x1, y + 1, w, h - 2, r)
			ctx.fill()
			// bevel like an editor clip
			ctx.fillStyle = 'rgba(255,255,255,0.16)'
			ctx.fillRect(x1 + 1, y + 1, Math.max(0, w - 2), 2)
			ctx.fillStyle = 'rgba(0,0,0,0.22)'
			ctx.fillRect(x1 + 1, y + h - 4, Math.max(0, w - 2), 2)
			if (opts.hatch) {
				ctx.beginPath()
				ctx.roundRect(x1, y + 1, w, h - 2, r)
				ctx.clip()
				ctx.strokeStyle = 'rgba(255,255,255,0.07)'
				ctx.lineWidth = 4
				ctx.beginPath()
				for (let x = x1 - h; x < x1 + w + h; x += 12) {
					ctx.moveTo(x, y + h)
					ctx.lineTo(x + h, y)
				}
				ctx.stroke()
			}
			ctx.restore()
			ctx.strokeStyle = opts.outline || 'rgba(0,0,0,0.45)'
			ctx.lineWidth = opts.outline ? 2 : 1
			ctx.beginPath()
			ctx.roundRect(x1 + 0.5, y + 1.5, w - 1, h - 3, r)
			ctx.stroke()
			if (label && w > 26) {
				const lx = Math.max(x1, L) + 7
				const maxW = x1 + w - lx - 6
				if (maxW > 14) {
					ctx.save()
					ctx.beginPath()
					ctx.rect(lx, y, maxW, h)
					ctx.clip()
					ctx.fillStyle = opts.textColor || '#fff'
					ctx.font = `${opts.bold ? 600 : 500} ${h >= 40 ? 13 : 11.5}px -apple-system, system-ui, sans-serif`
					ctx.textBaseline = 'middle'
					ctx.fillText(label, lx, y + h / 2 + (opts.sub && h >= 40 ? -7 : 0))
					if (opts.sub && h >= 40) {
						ctx.fillStyle = 'rgba(255,255,255,0.72)'
						ctx.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace'
						ctx.fillText(opts.sub, lx, y + h / 2 + 9)
					}
					ctx.restore()
				}
			}
		}

		// Transition band on the PROGRAM track: blend from the outgoing to the incoming colour.
		_transition(x1, x2, y, h, fromColor, toColor, kind, live) {
			const ctx = this.ctx
			if (x2 < this.headerW || x1 > this.w) return
			const w = Math.max(2, x2 - x1)
			const g = ctx.createLinearGradient(x1, 0, x1 + w, 0)
			g.addColorStop(0, fromColor)
			g.addColorStop(1, toColor)
			ctx.fillStyle = g
			ctx.fillRect(x1, y + 1, w, h - 2)
			ctx.strokeStyle = 'rgba(255,255,255,0.55)'
			ctx.lineWidth = 1
			ctx.beginPath()
			ctx.moveTo(x1, y + h - 2)
			ctx.lineTo(x1 + w, y + 2)
			if (!live) {
				ctx.moveTo(x1, y + 2)
				ctx.lineTo(x1 + w, y + h - 2)
			}
			ctx.stroke()
			if (live) {
				ctx.strokeStyle = '#fff'
				ctx.setLineDash([4, 3])
				ctx.strokeRect(x1 + 0.5, y + 1.5, w - 1, h - 3)
				ctx.setLineDash([])
			}
			const label = KIND_LABEL[kind] || String(kind || '').toUpperCase()
			if (w > 34) {
				ctx.font = '700 9.5px -apple-system, system-ui, sans-serif'
				const tw = ctx.measureText(label).width
				const cx = x1 + w / 2
				ctx.fillStyle = 'rgba(0,0,0,0.65)'
				ctx.beginPath()
				ctx.roundRect(cx - tw / 2 - 4, y + h / 2 - 7, tw + 8, 14, 3)
				ctx.fill()
				ctx.fillStyle = '#fff'
				ctx.textBaseline = 'middle'
				ctx.fillText(label, cx - tw / 2, y + h / 2)
			}
		}

		_drawSegments() {
			const m = this.model
			const segs = m.segments
			if (!segs.length) return
			const pgm = this.tracks[0]
			const t0 = this.viewStart()
			const t1 = this.viewEnd
			const nowT = this.now()
			const start = m.firstIndexFrom(t0)
			const hovering = this._hoverSegment()
			for (let i = start; i < segs.length; i++) {
				const s = segs[i]
				if (s.start > t1) break
				const next = segs[i + 1]
				const end = s.end ?? nowT
				const color = this.color(s.src)
				const label = this.name(s.src)
				const isBlack = s.src === BLACK
				const hl = hovering === s ? '#ffffff' : null
				// PROGRAM track: solid between transitions
				const a = s.transIn && s.transIn.end > s.transIn.start ? s.transIn.end : s.start
				const b = next && next.transIn && next.transIn.end > next.transIn.start ? next.transIn.start : end
				const inLabel = s.transIn ? KIND_LABEL[s.transIn.kind] || s.transIn.kind : 'START'
				this._clip(this.x(a), this.x(Math.max(a, b)), pgm.y, pgm.h, color, isBlack ? 'Black' : label, {
					bold: true,
					hatch: isBlack,
					textColor: isBlack ? '#8a92a3' : '#fff',
					sub: `${this.tcAt(s.transIn ? (s.transIn.start + s.transIn.end) / 2 : s.start)} · ${String(inLabel).toUpperCase()}`,
					outline: hl,
				})
				if (s.transIn && s.transIn.end > s.transIn.start && i > 0) {
					this._transition(this.x(s.transIn.start), this.x(s.transIn.end), pgm.y, pgm.h, this.color(segs[i - 1].src), color, s.transIn.kind)
				} else if (s.transIn && i > 0) {
					// cut: thin line marking the edit
					const x = Math.round(this.x(s.start)) + 0.5
					if (x > this.headerW && x < this.w) {
						this.ctx.fillStyle = 'rgba(0,0,0,0.75)'
						this.ctx.fillRect(x - 1, pgm.y + 1, 2, pgm.h - 2)
					}
				}
				// Source track
				const tr = this.trackFor(s.src)
				if (tr) this._clip(this.x(s.start), this.x(end), tr.y + 3, tr.h - 6, color, label, { outline: hl })
			}
		}

		_drawLiveTransition() {
			const live = this.live
			if (!this.isLive || !live || !this.liveTransStart) return
			const cur = this.model.current
			if (!cur) return
			const pgm = this.tracks[0]
			const nowT = this.now()
			const from = this.color(cur.src)
			if (live.ftbInTransition) {
				const to = live.ftbFullyBlack ? this.color(live.program) : BLACK_COLOR
				this._transition(this.x(this.liveTransStart), this.x(nowT), pgm.y, pgm.h, from, to, 'ftb', true)
			} else if (live.inTransition) {
				this._transition(this.x(this.liveTransStart), this.x(nowT), pgm.y, pgm.h, from, this.color(live.preview), live.style, true)
				const tr = this.trackFor(live.preview)
				if (tr) this._clip(this.x(this.liveTransStart), this.x(nowT), tr.y + 3, tr.h - 6, this.color(live.preview), '', { alpha: 0.55 })
			}
		}

		_drawMarkers(bottom) {
			const ctx = this.ctx
			const colors = { sync: '#f5a524', note: '#e9d758', drop: '#e5484d', back: '#30a46c' }
			for (const mk of this.model.markers) {
				const x = Math.round(this.x(mk.t)) + 0.5
				if (x < this.headerW - 200 || x > this.w + 4) continue
				const col = colors[mk.kind] || '#fff'
				ctx.strokeStyle = col
				ctx.globalAlpha = 0.7
				ctx.setLineDash(mk.kind === 'note' || mk.kind === 'sync' ? [3, 3] : [])
				ctx.beginPath()
				ctx.moveTo(x, this.rulerH)
				ctx.lineTo(x, bottom)
				ctx.stroke()
				ctx.setLineDash([])
				ctx.globalAlpha = 1
				// flag in the ruler
				ctx.font = '600 10px -apple-system, system-ui, sans-serif'
				const text = mk.label.length > 28 ? mk.label.slice(0, 27) + '…' : mk.label
				const tw = ctx.measureText(text).width
				ctx.fillStyle = col
				ctx.beginPath()
				ctx.roundRect(x, 18, tw + 10, 14, [0, 3, 3, 0])
				ctx.fill()
				ctx.fillStyle = '#111'
				ctx.textBaseline = 'middle'
				ctx.fillText(text, x + 5, 25)
				ctx.textBaseline = 'alphabetic'
			}
		}

		_drawPlayhead(bottom) {
			if (!this.isLive) return
			const ctx = this.ctx
			const x = Math.round(this.x(this.now())) + 0.5
			if (x < this.headerW || x > this.w) return
			ctx.strokeStyle = '#ff4d55'
			ctx.lineWidth = 1.5
			ctx.beginPath()
			ctx.moveTo(x, 0)
			ctx.lineTo(x, bottom)
			ctx.stroke()
			ctx.fillStyle = '#ff4d55'
			ctx.beginPath()
			ctx.moveTo(x - 6, 0)
			ctx.lineTo(x + 6, 0)
			ctx.lineTo(x, 8)
			ctx.fill()
		}

		_drawFlash(bottom) {
			if (!this.flash) return
			const left = this.flash.until - performance.now()
			if (left <= 0) return (this.flash = null)
			const ctx = this.ctx
			const x = Math.round(this.x(this.flash.t)) + 0.5
			ctx.globalAlpha = Math.min(1, left / 600)
			ctx.strokeStyle = '#5ed1ff'
			ctx.lineWidth = 2
			ctx.beginPath()
			ctx.moveTo(x, 0)
			ctx.lineTo(x, bottom)
			ctx.stroke()
			ctx.globalAlpha = 1
		}

		_drawHeaders() {
			const ctx = this.ctx
			const L = this.headerW
			ctx.fillStyle = '#171a21'
			ctx.fillRect(0, 0, L, this.h)
			ctx.fillStyle = '#2a2f3a'
			ctx.fillRect(L - 1, 0, 1, this.h)
			// corner: live timecode
			ctx.fillStyle = '#1a1e27'
			ctx.fillRect(0, 0, L - 1, this.rulerH)
			ctx.fillStyle = '#262b36'
			ctx.fillRect(0, this.rulerH - 1, L, 1)
			ctx.font = '600 10px -apple-system, system-ui, sans-serif'
			ctx.fillStyle = '#8a92a3'
			ctx.fillText(this.anchor().elapsed ? 'ELAPSED' : 'SWITCHER TIMECODE', 10, 14)
			ctx.font = '600 14px ui-monospace, SFMono-Regular, Menlo, monospace'
			ctx.fillStyle = '#e6e8ee'
			if (this.model?.events.length) ctx.fillText(this.tcAt(this.now()), 10, 32)
			else ctx.fillText('--:--:--:--', 10, 32)

			const totals = this.model ? this.model.onAirTotals(this.now()) : {}
			const live = this.live
			for (const tr of this.tracks) {
				const y = tr.y
				const h = tr.h
				ctx.fillStyle = tr.kind === 'pgm' ? '#1d2230' : '#1b1f28'
				ctx.fillRect(4, y + 1, L - 9, h - 2)
				let sw = tr.kind === 'pgm' ? '#ff4d55' : tr.kind === 'cam' ? this.color(tr.src) : OTHER_COLOR
				ctx.fillStyle = sw
				ctx.fillRect(4, y + 1, 4, h - 2)
				const compact = h < 32
				ctx.textBaseline = 'middle'
				ctx.fillStyle = '#e6e8ee'
				ctx.font = `600 ${compact ? 11.5 : 12.5}px -apple-system, system-ui, sans-serif`
				const nameMax = L - 70
				let name = tr.label
				while (ctx.measureText(name).width > nameMax && name.length > 3) name = name.slice(0, -2)
				if (name !== tr.label) name += '…'
				ctx.fillText(name, 15, compact ? y + h / 2 : y + h / 2 - 7)
				if (!compact) {
					ctx.font = '10.5px -apple-system, system-ui, sans-serif'
					ctx.fillStyle = '#8a92a3'
					let sub = tr.sub || ''
					if (tr.kind === 'pgm') {
						const cur = this.model?.current
						sub = cur ? `on air: ${this.name(cur.src)}` : 'not logging'
						if (this.model) sub += ` · ${this.model.switchCount} switches`
					} else if (tr.kind === 'cam' && totals[tr.src]) sub = `${tr.tag} · ${TC.fmtDuration(totals[tr.src])} on air`
					while (ctx.measureText(sub).width > L - 26 && sub.length > 3) sub = sub.slice(0, -2)
					ctx.fillText(sub, 15, y + h / 2 + 8)
				}
				// tally
				if (live && tr.kind !== 'pgm') {
					const onPgm = tr.kind === 'cam' ? live.program === tr.src && !live.ftbFullyBlack : !this.isCamera(live.program) && !live.ftbFullyBlack
					const onPvw = tr.kind === 'cam' ? live.preview === tr.src : !this.isCamera(live.preview)
					const tag = onPgm ? ['PGM', '#e5484d'] : onPvw ? ['PVW', '#30a46c'] : null
					if (tag) {
						ctx.font = '700 9.5px -apple-system, system-ui, sans-serif'
						ctx.fillStyle = tag[1]
						ctx.beginPath()
						ctx.roundRect(L - 46, y + h / 2 - 8, 36, 16, 3)
						ctx.fill()
						ctx.fillStyle = '#fff'
						ctx.fillText(tag[0], L - 46 + (36 - ctx.measureText(tag[0]).width) / 2, y + h / 2)
					}
				}
				ctx.textBaseline = 'alphabetic'
			}
		}

		_drawEmpty() {
			if (this.model && this.model.events.length) return
			const ctx = this.ctx
			ctx.fillStyle = '#8a92a3'
			ctx.font = '14px -apple-system, system-ui, sans-serif'
			ctx.textAlign = 'center'
			ctx.fillText(this.emptyText || 'Connect to your switcher (top right), or click Demo to try it with a simulated switcher.', this.headerW + (this.w - this.headerW) / 2, this.h / 2)
			ctx.textAlign = 'start'
		}

		_hoverSegment() {
			const m = this.mouse
			if (!m || !m.inside || !this.model || m.x < this.headerW) return null
			const tr = this.tracks.find((t) => m.y >= t.y && m.y < t.y + t.h)
			if (!tr) return null
			const t = this.tAtX(m.x)
			if (tr.kind === 'pgm') return this.model.segmentAt(t)
			// source track: find a segment of a matching source covering t (they can overlap in transitions)
			const segs = this.model.segments
			const nowT = this.now()
			for (let i = this.model.firstIndexFrom(t); i < segs.length && segs[i].start <= t; i++) {
				const s = segs[i]
				if (t <= (s.end ?? nowT) && this.trackFor(s.src) === tr) return s
			}
			return null
		}

		_tooltip() {
			const s = this._hoverSegment()
			const tip = this.tip
			if (!s) {
				if (!tip.hidden) tip.hidden = true
				return
			}
			const segs = this.model.segments
			const i = segs.indexOf(s)
			const next = segs[i + 1]
			const a = s.transIn ? (s.transIn.start + s.transIn.end) / 2 : s.start
			const b = next?.transIn ? (next.transIn.start + next.transIn.end) / 2 : s.end ?? this.now()
			const how = s.transIn
				? s.transIn.kind === 'cut'
					? `Cut from ${this.name(s.transIn.from)}`
					: s.transIn.kind === 'ftb'
					? 'Fade to / from black'
					: `${(KIND_LABEL[s.transIn.kind] || s.transIn.kind).toUpperCase()} from ${this.name(s.transIn.from)} · ${Math.round(TC.msToFrames(s.transIn.end - s.transIn.start, this.rate()))} frames`
				: 'On air when logging started'
			const key = `${i}|${Math.floor(b / 100)}|${how}`
			if (tip.dataset.key !== key) {
				tip.dataset.key = key
				tip.innerHTML = `<b style="color:${this.color(s.src) === BLACK_COLOR ? '#aaa' : this.color(s.src)}">${esc(this.name(s.src))}</b>
					<div class="tt-row"><span>In</span><code>${this.tcAt(a)}</code></div>
					<div class="tt-row"><span>Out</span><code>${s.end === null ? 'on air now' : this.tcAt(b)}</code></div>
					<div class="tt-row"><span>Length</span><code>${TC.fmtDuration(b - a)}</code></div>
					<div class="tt-how">${esc(how)}</div>`
			}
			tip.hidden = false
			const r = tip.getBoundingClientRect()
			let left = this.mouse.cx + 14
			let top = this.mouse.cy + 14
			if (left + r.width > window.innerWidth - 8) left = this.mouse.cx - r.width - 14
			if (top + r.height > window.innerHeight - 8) top = this.mouse.cy - r.height - 14
			tip.style.left = left + 'px'
			tip.style.top = top + 'px'
		}
	}

	function esc(s) {
		return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
	}

	window.Timeline = Timeline
})()
