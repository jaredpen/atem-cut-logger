// Turns the logged events of one session into what the timeline draws: program segments
// (one per time a source was on air), markers, switcher-recording ranges and no-data gaps.
// Loads in the window and in Node (for tests).
;(function (root, factory) {
	const api = factory()
	if (typeof module === 'object' && module.exports) module.exports = api
	else root.SessionModel = api.SessionModel
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict'
	const BLACK = 'black'

	class SessionModel {
		constructor() {
			this.reset(null)
		}

		reset(header) {
			this.header = header
			this.events = []
			this.segments = [] // { src, start, end|null, transIn: {start, end, kind, from, frames}|null }
			this.markers = [] // { t, kind: 'sync'|'note'|'drop'|'back', label }
			this.recRanges = [] // switcher's own recorder: { start, end|null }
			this.gaps = [] // connection lost: { start, end|null }
			this.program = null
			this.black = false
			this.startT = header ? header.t : null
			this.endT = null
			this.switchCount = 0
			this.tcRef = null
			this.version = 0
		}

		get effective() {
			return this.black ? BLACK : this.program
		}

		get current() {
			const s = this.segments[this.segments.length - 1]
			return s && s.end === null ? s : null
		}

		load(header, events) {
			this.reset(header)
			for (const e of events) this.add(e)
		}

		add(e) {
			this.events.push(e)
			this.version++
			if (typeof e.tcFrames === 'number') this.tcRef = { t: e.t, frames: e.tcFrames }
			if (this.startT === null) this.startT = e.t
			switch (e.type) {
				case 'initial':
					this.program = e.program
					this.black = !!e.black
					this._close(e.t)
					this.segments.push({ src: this.effective, start: e.t, end: null, transIn: null })
					if (e.recording) this.recRanges.push({ start: e.t, end: null })
					break
				case 'cut':
					this.switchCount++
					this._change(() => (this.program = e.to), e.t, e.t, { kind: 'cut', from: e.from })
					break
				case 'transition':
					this.switchCount++
					this._change(() => (this.program = e.to), e.t, e.tEnd, { kind: e.style || 'mix', from: e.from, frames: e.rateFrames })
					break
				case 'black_on':
				case 'black_off':
					this._change(() => (this.black = e.type === 'black_on'), e.t, e.tEnd ?? e.t, { kind: 'ftb' })
					break
				case 'sync':
					this.markers.push({ t: e.t, kind: 'sync', label: `SYNC ${e.n ?? ''}`.trim() })
					break
				case 'marker':
					this.markers.push({ t: e.t, kind: 'note', label: e.note || 'Marker' })
					break
				case 'record_start':
					this.recRanges.push({ start: e.t, end: null })
					break
				case 'record_stop': {
					const r = this.recRanges[this.recRanges.length - 1]
					if (r && r.end === null) r.end = e.t
					break
				}
				case 'disconnected':
					this.gaps.push({ start: e.t, end: null })
					this.markers.push({ t: e.t, kind: 'drop', label: 'Connection lost' })
					break
				case 'reconnected': {
					const g = this.gaps[this.gaps.length - 1]
					if (g && g.end === null) g.end = e.t
					this.markers.push({ t: e.t, kind: 'back', label: 'Reconnected' })
					break
				}
				case 'end':
					this.endT = e.t
					this._close(e.t)
					for (const r of this.recRanges) if (r.end === null) r.end = e.t
					for (const g of this.gaps) if (g.end === null) g.end = e.t
					break
			}
		}

		// Apply a change; if what's on air changed, end the current segment and start the next.
		// For transitions the outgoing segment runs to the end of the transition and the incoming
		// one starts at its beginning, so they overlap for the length of the transition.
		_change(apply, tStart, tEnd, how) {
			const before = this.effective
			apply()
			if (this.effective === before) return
			this._close(tEnd)
			this.segments.push({
				src: this.effective,
				start: tStart,
				end: null,
				transIn: { start: tStart, end: tEnd, ...how },
			})
		}

		_close(t) {
			const cur = this.current
			if (cur) cur.end = Math.max(t, cur.start)
		}

		// Total on-air time per source (transitions count half to each side).
		onAirTotals(nowT) {
			const totals = {}
			const segs = this.segments
			for (let i = 0; i < segs.length; i++) {
				const s = segs[i]
				const next = segs[i + 1]
				const a = s.transIn ? (s.transIn.start + s.transIn.end) / 2 : s.start
				const b = next && next.transIn ? (next.transIn.start + next.transIn.end) / 2 : s.end ?? nowT
				totals[s.src] = (totals[s.src] || 0) + Math.max(0, b - a)
			}
			return totals
		}

		// Segment on air at time t (at a transition, the incoming one once past its midpoint).
		segmentAt(t) {
			const segs = this.segments
			let lo = 0
			let hi = segs.length - 1
			let found = -1
			while (lo <= hi) {
				const mid = (lo + hi) >> 1
				if (segs[mid].start <= t) {
					found = mid
					lo = mid + 1
				} else hi = mid - 1
			}
			if (found < 0) return null
			let s = segs[found]
			if (s.transIn && t < (s.transIn.start + s.transIn.end) / 2 && found > 0) s = segs[found - 1]
			if (s.end !== null && t > s.end) return null
			return s
		}

		// Index of the first segment that might be visible from time t on.
		firstIndexFrom(t) {
			const segs = this.segments
			let lo = 0
			let hi = segs.length
			while (lo < hi) {
				const mid = (lo + hi) >> 1
				const end = segs[mid].end ?? Infinity
				if (end < t) lo = mid + 1
				else hi = mid
			}
			return Math.max(0, lo - 1)
		}
	}

	return { SessionModel, BLACK }
})
