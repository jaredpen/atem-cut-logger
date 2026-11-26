// Frame-rate and timecode helpers. Shared by the app's engine (Node) and the window (browser),
// so it is written to load in both.
;(function (root, factory) {
	const api = factory()
	if (typeof module === 'object' && module.exports) module.exports = api
	else root.TC = api
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict'

	// Exact frame rates as fractions. `nominal` is the frames-per-second used to count timecode.
	const RATES = {
		'23.976': { num: 24000, den: 1001, nominal: 24 },
		'24': { num: 24, den: 1, nominal: 24 },
		'25': { num: 25, den: 1, nominal: 25 },
		'29.97': { num: 30000, den: 1001, nominal: 30 },
		'30': { num: 30, den: 1, nominal: 30 },
		'50': { num: 50, den: 1, nominal: 50 },
		'59.94': { num: 60000, den: 1001, nominal: 60 },
		'60': { num: 60, den: 1, nominal: 60 },
	}

	function getRate(label) {
		const r = RATES[String(label)]
		if (!r) throw new Error(`Unsupported frame rate "${label}". Use one of: ${Object.keys(RATES).join(', ')}`)
		return { label: String(label), ...r }
	}

	// ATEM video mode names look like N1080p5994, P4KHDp25, P1080i50, N4KHDp2398.
	function rateLabelFromVideoModeName(name) {
		const m = /([pi])(\d+)$/.exec(name || '')
		if (!m) return null
		const table = { '2398': '23.976', '24': '24', '25': '25', '2997': '29.97', '30': '30', '50': '50', '5000': '50', '5994': '59.94', '60': '60' }
		let label = table[m[2]]
		if (!label) return null
		// Interlaced modes are named by field rate; the frame rate is half.
		if (m[1] === 'i') label = { '50': '25', '59.94': '29.97', '60': '30' }[label] || label
		return label
	}

	function resolutionFromVideoModeName(name) {
		if (/8KHD/.test(name)) return { width: 7680, height: 4320 }
		if (/4KHD/.test(name)) return { width: 3840, height: 2160 }
		if (/1080/.test(name)) return { width: 1920, height: 1080 }
		if (/720/.test(name)) return { width: 1280, height: 720 }
		if (/625/.test(name)) return { width: 720, height: 576 }
		if (/525/.test(name)) return { width: 720, height: 486 }
		return { width: 1920, height: 1080 }
	}

	// Human name for an ATEM video mode, e.g. N4KHDp2997 -> "2160p29.97"
	function prettyVideoMode(name) {
		const fps = rateLabelFromVideoModeName(name)
		const res = resolutionFromVideoModeName(name || '')
		const scan = /i\d+$/.test(name || '') ? 'i' : 'p'
		return fps ? `${res.height}${scan}${fps}` : String(name || '')
	}

	const isDropFrameCapable = (rate) => rate.den === 1001 && (rate.nominal === 30 || rate.nominal === 60)

	// Timecode -> absolute frame count (frames since 00:00:00:00).
	function tcToFrames(tc, rate, dropFrame = false) {
		let h, m, s, f
		if (typeof tc === 'string') {
			const parts = tc.trim().split(/[:;.]/).map(Number)
			if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) throw new Error(`Bad timecode "${tc}" (expected HH:MM:SS:FF)`)
			;[h, m, s, f] = parts
			if (tc.includes(';')) dropFrame = true
		} else {
			;({ hour: h, minute: m, second: s, frame: f } = tc)
		}
		const fps = rate.nominal
		let frames = ((h * 60 + m) * 60 + s) * fps + f
		if (dropFrame && isDropFrameCapable(rate)) {
			const drop = fps === 60 ? 4 : 2
			const totalMinutes = h * 60 + m
			frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10))
		}
		return frames
	}

	// Absolute frame count -> "HH:MM:SS:FF" (or HH:MM:SS;FF for drop frame).
	function framesToTc(frames, rate, dropFrame = false) {
		const fps = rate.nominal
		let n = Math.round(frames)
		const neg = n < 0
		if (neg) n = -n
		const df = dropFrame && isDropFrameCapable(rate)
		if (df) {
			const drop = fps === 60 ? 4 : 2
			const framesPer10Min = Math.round((rate.num / rate.den) * 600)
			const framesPerMin = fps * 60 - drop
			const d = Math.floor(n / framesPer10Min)
			const mod = n % framesPer10Min
			n += drop * 9 * d + (mod > drop ? drop * Math.floor((mod - drop) / framesPerMin) : 0)
		}
		const f = n % fps
		const totalSeconds = Math.floor(n / fps)
		const s = totalSeconds % 60
		const m = Math.floor(totalSeconds / 60) % 60
		const h = Math.floor(totalSeconds / 3600) % 24
		const pad = (x) => String(x).padStart(2, '0')
		return `${neg ? '-' : ''}${pad(h)}:${pad(m)}:${pad(s)}${df ? ';' : ':'}${pad(f)}`
	}

	// Milliseconds of real time -> frames at this rate (not rounded), and back.
	const msToFrames = (ms, rate) => (ms * rate.num) / (rate.den * 1000)
	const framesToMs = (frames, rate) => (frames * rate.den * 1000) / rate.num

	function gcd(a, b) {
		a = Math.abs(a)
		b = Math.abs(b)
		while (b) [a, b] = [b, a % b]
		return a || 1
	}

	// Frame count -> FCPXML rational time string, e.g. "3003/30000s" or "12s".
	function fcpTime(frames, rate) {
		let num = Math.round(frames) * rate.den
		let den = rate.num
		if (num === 0) return '0s'
		const g = gcd(num, den)
		num /= g
		den /= g
		return den === 1 ? `${num}s` : `${num}/${den}s`
	}

	// Plain duration, e.g. 75500 ms -> "1:15" or "1:02:03"
	function fmtDuration(ms) {
		const s = Math.max(0, Math.round(ms / 1000))
		const h = Math.floor(s / 3600)
		const m = Math.floor(s / 60) % 60
		const sec = s % 60
		const pad = (x) => String(x).padStart(2, '0')
		return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
	}

	return {
		RATES,
		getRate,
		rateLabelFromVideoModeName,
		resolutionFromVideoModeName,
		prettyVideoMode,
		tcToFrames,
		framesToTc,
		msToFrames,
		framesToMs,
		fcpTime,
		fmtDuration,
		isDropFrameCapable,
	}
})
