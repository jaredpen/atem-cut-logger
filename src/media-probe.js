'use strict'
// Reads what the timeline builder needs from a camera recording, without ffmpeg:
// start timecode, frame rate, picture size, length and audio. Works on QuickTime (.mov) and
// MP4 files, which is what Blackmagic cameras, HyperDecks and most recorders write.
// Other files (or files without a timecode track) can still be used: type the start timecode in.

const fs = require('fs')
const path = require('path')
const TC = require('./timecode')

const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.braw', '.mxf', '.avi', '.mts', '.m2ts', '.mkv'])

function readAt(fd, pos, len) {
	const buf = Buffer.alloc(len)
	const n = fs.readSync(fd, buf, 0, len, pos)
	return n === len ? buf : buf.subarray(0, n)
}

// Top-level atoms: returns [{ type, start, size, headerSize }]
function topAtoms(fd, fileSize) {
	const atoms = []
	let pos = 0
	for (let guard = 0; pos + 8 <= fileSize && guard < 10000; guard++) {
		const h = readAt(fd, pos, 16)
		if (h.length < 8) break
		let size = h.readUInt32BE(0)
		const type = h.toString('latin1', 4, 8)
		let headerSize = 8
		if (size === 1) {
			size = Number(h.readBigUInt64BE(8))
			headerSize = 16
		} else if (size === 0) size = fileSize - pos
		if (size < headerSize) break
		atoms.push({ type, start: pos, size, headerSize })
		pos += size
	}
	return atoms
}

// Children of an atom held in memory
function children(buf, start = 0, end = buf.length) {
	const out = []
	let pos = start
	while (pos + 8 <= end) {
		let size = buf.readUInt32BE(pos)
		const type = buf.toString('latin1', pos + 4, pos + 8)
		let hs = 8
		if (size === 1) {
			size = Number(buf.readBigUInt64BE(pos + 8))
			hs = 16
		} else if (size === 0) size = end - pos
		if (size < hs || pos + size > end) break
		out.push({ type, start: pos, body: pos + hs, end: pos + size })
		pos += size
	}
	return out
}
const child = (buf, atom, type) => children(buf, atom.body, atom.end).find((a) => a.type === type)
const path_ = (buf, atom, ...types) => types.reduce((a, t) => a && child(buf, a, t), atom)

// Nearest standard frame rate
function rateFromFps(fps) {
	let best = null
	for (const [label, r] of Object.entries(TC.RATES)) {
		const d = Math.abs(r.num / r.den - fps)
		if (!best || d < best.d) best = { label, d }
	}
	return best && best.d < 0.05 ? best.label : null
}

function parseTrack(buf, trak) {
	const t = {}
	const tkhd = child(buf, trak, 'tkhd')
	if (tkhd) {
		t.width = Math.round(buf.readUInt32BE(tkhd.end - 8) / 65536)
		t.height = Math.round(buf.readUInt32BE(tkhd.end - 4) / 65536)
	}
	const mdia = child(buf, trak, 'mdia')
	if (!mdia) return t
	const hdlr = child(buf, mdia, 'hdlr')
	if (hdlr) t.handler = buf.toString('latin1', hdlr.body + 8, hdlr.body + 12)
	const mdhd = child(buf, mdia, 'mdhd')
	if (mdhd) {
		const v = buf[mdhd.body]
		if (v === 1) {
			t.timescale = buf.readUInt32BE(mdhd.body + 20)
			t.duration = Number(buf.readBigUInt64BE(mdhd.body + 24))
		} else {
			t.timescale = buf.readUInt32BE(mdhd.body + 12)
			t.duration = buf.readUInt32BE(mdhd.body + 16)
		}
	}
	const stbl = path_(buf, mdia, 'minf', 'stbl')
	if (!stbl) return t
	const stsd = child(buf, stbl, 'stsd')
	if (stsd && buf.readUInt32BE(stsd.body + 4) > 0) {
		const e = stsd.body + 8
		t.format = buf.toString('latin1', e + 4, e + 8)
		if (t.format === 'tmcd' && e + 34 <= stsd.end) {
			t.tmcd = {
				flags: buf.readUInt32BE(e + 20),
				timescale: buf.readUInt32BE(e + 24),
				frameDuration: buf.readUInt32BE(e + 28),
				fps: buf[e + 32],
			}
		}
		if (t.handler === 'soun' && e + 26 <= stsd.end) t.channels = buf.readUInt16BE(e + 24)
	}
	const stts = child(buf, stbl, 'stts')
	if (stts) {
		const n = buf.readUInt32BE(stts.body + 4)
		let samples = 0
		for (let i = 0; i < n; i++) samples += buf.readUInt32BE(stts.body + 8 + i * 8)
		t.sampleCount = samples
		if (n > 0) t.sampleDelta = buf.readUInt32BE(stts.body + 12)
	}
	const stco = child(buf, stbl, 'stco')
	const co64 = child(buf, stbl, 'co64')
	if (stco && buf.readUInt32BE(stco.body + 4) > 0) t.firstChunk = buf.readUInt32BE(stco.body + 8)
	else if (co64 && buf.readUInt32BE(co64.body + 4) > 0) t.firstChunk = Number(buf.readBigUInt64BE(co64.body + 8))
	return t
}

/**
 * @returns {{ ok: boolean, path: string, name: string, reason?: string, fps?: string|null,
 *   width?: number, height?: number, durationFrames?: number|null, startFrames?: number|null,
 *   startTc?: string|null, dropFrame?: boolean, hasAudio?: boolean, audioChannels?: number }}
 */
function probe(file) {
	const info = { ok: false, path: file, name: path.basename(file) }
	let fd
	try {
		fd = fs.openSync(file, 'r')
		const size = fs.fstatSync(fd).size
		info.bytes = size
		const moovAtom = topAtoms(fd, size).find((a) => a.type === 'moov')
		if (!moovAtom) {
			info.reason = VIDEO_EXT.has(path.extname(file).toLowerCase())
				? "Can't read this file's timecode. Type its start timecode in."
				: "This doesn't look like a video file."
			info.unknown = true
			return info
		}
		if (moovAtom.size > 512 * 1024 * 1024) throw new Error('File header is too large')
		const buf = readAt(fd, moovAtom.start, moovAtom.size)
		const moov = { body: moovAtom.headerSize, end: buf.length }
		const tracks = children(buf, moov.body, moov.end)
			.filter((a) => a.type === 'trak')
			.map((a) => parseTrack(buf, a))
		const video = tracks.find((t) => t.handler === 'vide')
		const audio = tracks.filter((t) => t.handler === 'soun')
		const tc = tracks.find((t) => t.tmcd)
		if (video) {
			info.width = video.width
			info.height = video.height
			if (video.timescale && video.sampleDelta) {
				const fps = video.timescale / video.sampleDelta
				info.fpsExact = fps
				info.fps = rateFromFps(fps)
			}
			if (video.sampleCount) info.durationFrames = video.sampleCount
			else if (video.duration && video.sampleDelta) info.durationFrames = Math.floor(video.duration / video.sampleDelta)
		}
		info.hasAudio = audio.length > 0
		info.audioChannels = audio.reduce((n, a) => n + (a.channels || 0), 0) || (audio.length ? 2 : 0)
		info.startFrames = null
		info.startTc = null
		if (tc && tc.firstChunk != null) {
			const b = readAt(fd, tc.firstChunk, 4)
			if (b.length === 4) {
				const frameNo = b.readUInt32BE(0)
				info.dropFrame = !!(tc.tmcd.flags & 1)
				const label = info.fps || rateFromFps(tc.tmcd.timescale / tc.tmcd.frameDuration) || '25'
				const rate = TC.getRate(label)
				info.startFrames = frameNo
				info.startTc = TC.framesToTc(frameNo, rate, info.dropFrame)
				if (!info.fps) info.fps = label
			}
		}
		if (!video) {
			info.reason = 'No picture in this file.'
			return info
		}
		info.ok = true
		if (info.startFrames === null) info.reason = 'No timecode in this file. Type its start timecode in (or use clap sync).'
		return info
	} catch (e) {
		info.reason = `Couldn't read this file: ${e.message}`
		return info
	} finally {
		if (fd !== undefined) fs.closeSync(fd)
	}
}

module.exports = { probe, VIDEO_EXT }
