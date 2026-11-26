'use strict'
// Turns a stream of switcher state snapshots into cut / transition events.
// Kept free of any network code so it can be tested with simulated states.

const STYLE_NAMES = ['mix', 'dip', 'wipe', 'dve', 'sting']
const JUST_ENDED_MS = 250

// Pull the fields we care about out of an atem-connection state object.
function snapshotFromAtemState(state, me = 0) {
	const mix = state?.video?.mixEffects?.[me]
	if (!mix) return null
	const style = mix.transitionProperties?.style
	const settings = mix.transitionSettings || {}
	const rateByStyle = [settings.mix?.rate, settings.dip?.rate, settings.wipe?.rate, settings.DVE?.rate, settings.stinger?.mixRate]
	const rec = state.recording?.status?.state
	return {
		program: mix.programInput,
		preview: mix.previewInput,
		inTransition: !!mix.transitionPosition?.inTransition,
		transitionPos: (mix.transitionPosition?.handlePosition ?? 0) / 10000,
		style: STYLE_NAMES[style] ?? String(style),
		rateFrames: rateByStyle[style] ?? null,
		ftbInTransition: !!mix.fadeToBlack?.inTransition,
		ftbFullyBlack: !!mix.fadeToBlack?.isFullyBlack,
		recording: rec === 1 ? true : rec === 0 ? false : null,
	}
}

class CutTracker {
	/** @param {(event: object) => void} emit */
	constructor(emit) {
		this.emit = emit
		this.prev = null
		this.pendingTransition = null
		this.pendingFtb = null
		this.justEnded = null
	}

	update(snap, t) {
		if (!snap) return
		const prev = this.prev
		this.prev = { ...snap }
		if (!prev) {
			this.emit({ type: 'initial', t, program: snap.program, preview: snap.preview, black: snap.ftbFullyBlack, recording: snap.recording })
			if (snap.inTransition) this.pendingTransition = this._startTransition(snap, t)
			return
		}

		// 1. Transition starts. The incoming source is whatever was on preview at that moment.
		if (!prev.inTransition && snap.inTransition) {
			this.pendingTransition = this._startTransition({ ...snap, program: prev.program }, t)
		}

		// 2. Transition ends. Only count it if program actually changed (a key-only transition,
		//    or a T-bar pulled back to the start, leaves program where it was).
		if (prev.inTransition && !snap.inTransition && this.pendingTransition) {
			const p = this.pendingTransition
			this.pendingTransition = null
			if (snap.program !== p.from) {
				this._emitTransition(p, t, snap.program)
			} else {
				// The switcher may report "transition finished" a moment before the new program
				// source. Remember it briefly so that program change still counts as this transition.
				this.justEnded = { p, t }
			}
		} else if (snap.program !== prev.program && !snap.inTransition && !this.pendingTransition) {
			const j = this.justEnded
			if (j && t - j.t <= JUST_ENDED_MS && j.p.from === prev.program) {
				this._emitTransition(j.p, t, snap.program)
			} else {
				// 3. Program changed with no transition running: a cut.
				this.emit({ type: 'cut', t, from: prev.program, to: snap.program })
			}
			this.justEnded = null
		}
		if (this.justEnded && t - this.justEnded.t > JUST_ENDED_MS) this.justEnded = null
		// (Program changes while a transition is still running are picked up when it ends.)

		// Fade to black
		if (!prev.ftbInTransition && snap.ftbInTransition) this.pendingFtb = { t, toBlack: !prev.ftbFullyBlack }
		if (prev.ftbInTransition && !snap.ftbInTransition) {
			const start = this.pendingFtb?.t ?? t
			this.pendingFtb = null
			this.emit({ type: snap.ftbFullyBlack ? 'black_on' : 'black_off', t: start, tEnd: t })
		} else if (!snap.ftbInTransition && !prev.ftbInTransition && snap.ftbFullyBlack !== prev.ftbFullyBlack) {
			this.emit({ type: snap.ftbFullyBlack ? 'black_on' : 'black_off', t, tEnd: t })
		}

		// Switcher's own recorder starting/stopping (useful to trim the timeline later)
		if (snap.recording !== null && prev.recording !== null && snap.recording !== prev.recording) {
			this.emit({ type: snap.recording ? 'record_start' : 'record_stop', t })
		}
	}

	_emitTransition(p, tEnd, to) {
		this.emit({ type: 'transition', t: p.t, tEnd, style: p.style, from: p.from, to, rateFrames: p.rateFrames })
	}

	_startTransition(snap, t) {
		return { t, from: snap.program, style: snap.style, rateFrames: snap.rateFrames }
	}
}

module.exports = { CutTracker, snapshotFromAtemState, STYLE_NAMES }
