// Development preview: runs the real logging engine and serves the app's window in a normal web
// browser, without Electron. `npm run preview`, then open http://localhost:5178
// (Settings dialogs that need macOS, like choosing a folder or updating, are simplified here.)

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { Engine } = require('../src/engine.js')
const rx = require('../src/resolve-service.js')
const mediaDir = process.env.PREVIEW_MEDIA || ''
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const port = Number(process.env.PORT || 5178)
const logDir = process.env.LOG_DIR || path.join(os.tmpdir(), 'atem-cut-logger-preview-logs')

const engine = new Engine({ logDir, appVersion: pkg.version })
let settings = { logDir }
const clients = new Set()
const broadcast = (type, data) => {
	const msg = `data: ${JSON.stringify({ type, data })}\n\n`
	for (const res of clients) res.write(msg)
}
engine.on('state', (s) => broadcast('state', s))
engine.on('session', (s) => broadcast('session', s))
engine.on('event', (e) => broadcast('event', e))
engine.on('sys', (s) => broadcast('sys', s))
engine.on('sessionEnd', (s) => broadcast('sessionEnd', s))

function readLog(file) {
	const rows = fs
		.readFileSync(file, 'utf8')
		.split(/\r?\n/)
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l)
			} catch {
				return null
			}
		})
		.filter(Boolean)
	const header = rows.find((r) => r.type === 'session')
	return { header, events: rows.filter((r) => r.type !== 'session').sort((a, b) => a.t - b.t) }
}

const calls = {
	connect: ([ip, me, opts]) => engine.connectAtem(ip, me, opts || {}),
	startDemo: ([o]) => engine.startDemo(o || {}),
	disconnect: () => engine.stop(),
	newSession: () => engine.newSession(),
	startLogging: ([name]) => engine.startLogging(name),
	stopLogging: () => engine.stopLogging(),
	revealFile: () => null,
	marker: ([t]) => engine.marker(t),
	sync: () => engine.sync(),
	demo: ([cmd, arg]) => engine.demoCommand(cmd, arg),
	getState: () => engine.getState(),
	getSession: () => engine.getSession(),
	// Preview only: opens the newest closed log in the log folder (or LOG_FILE if set).
	openLog: () => {
		let file = process.env.LOG_FILE
		if (!file) {
			const cur = engine.session?.file
			const files = fs.existsSync(engine.logDir) ? fs.readdirSync(engine.logDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(engine.logDir, f)) : []
			file = files.filter((f) => f !== cur).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
		}
		if (!file) return { ok: false, reason: 'No saved logs yet.' }
		return { ok: true, file, name: path.basename(file), ...readLog(file) }
	},
	chooseLogDir: () => null,
	resolveOpen: ([file]) => (file ? rx.openForResolve(file, { liveFile: engine.session?.file }) : null),
	resolvePickLog: () => {
		const r = calls.openLog()
		return r.ok ? rx.openForResolve(r.file) : null
	},
	// Preview only: "Add files…" picks files in PREVIEW_MEDIA whose name contains CAM<n> for that camera.
	resolveChooseFiles: ([title]) => {
		if (!mediaDir) return []
		const m = /Recordings from (.*)/.exec(title || '')
		const ids = Object.entries(engine.info?.inputs || {}).filter(([, i]) => m && i.name === m[1]).map(([id]) => id)
		const files = fs.readdirSync(mediaDir).filter((f) => ids.some((id) => f.toUpperCase().includes(`CAM${id}`)))
		return rx.probeAll(files.map((f) => path.join(mediaDir, f)))
	},
	resolveProbe: ([paths]) => rx.probeAll(paths || []),
	resolveAnalyze: ([file, config]) => rx.analyze(file, config),
	resolveMake: ([file, config]) => {
		try {
			const r = rx.build(file, config)
			return rx.writeTimeline(r, path.join(path.dirname(file), `${r.summary.name}.fcpxml`))
		} catch (e) {
			return { ok: false, reason: e.message }
		}
	},
	pathForFile: () => null,
	openLogDir: () => null,
	appInfo: () => ({ version: pkg.version, updateRepo: pkg.updateRepo || '' }),
	copyText: () => true,
	checkUpdate: () => ({ ok: true, current: pkg.version, latest: pkg.version, newer: false, notes: '' }),
	installUpdate: () => ({ ok: false, reason: 'Not available in the browser preview.' }),
	loadSettings: () => settings,
	saveSettings: ([s]) => ((settings = s), true),
}

const shim = `
(function () {
	const call = (name, ...args) => fetch('/__call/' + name, { method: 'POST', body: JSON.stringify(args) }).then((r) => r.json()).then((r) => r.result)
	const subs = { state: [], session: [], event: [], sys: [], sessionEnd: [] }
	const es = new EventSource('/__events')
	es.onmessage = (m) => { const { type, data } = JSON.parse(m.data); for (const cb of subs[type] || []) cb(data) }
	const api = {}
	for (const n of ${JSON.stringify(Object.keys(calls))}) api[n] = (...a) => call(n, ...a)
	api.onState = (cb) => subs.state.push(cb)
	api.onSession = (cb) => subs.session.push(cb)
	api.onEvent = (cb) => subs.event.push(cb)
	api.onSys = (cb) => subs.sys.push(cb)
	api.onSessionEnd = (cb) => subs.sessionEnd.push(cb)
	window.prompt = (q, d) => d
	window.api = api
	window.confirm = () => true
})()
`

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' }
http
	.createServer(async (req, res) => {
		const url = new URL(req.url, 'http://x')
		if (url.pathname === '/__events') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
			res.write(': hi\n\n')
			clients.add(res)
			req.on('close', () => clients.delete(res))
			return
		}
		if (url.pathname.startsWith('/__call/')) {
			let body = ''
			for await (const c of req) body += c
			try {
				const result = await calls[url.pathname.slice(8)](JSON.parse(body || '[]'))
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ result: result ?? null }))
			} catch (e) {
				res.writeHead(500)
				res.end(JSON.stringify({ error: e.message }))
			}
			return
		}
		if (url.pathname === '/__shim.js') {
			res.writeHead(200, { 'Content-Type': 'text/javascript' })
			return res.end(shim)
		}
		if (url.pathname === '/') {
			res.writeHead(302, { Location: '/renderer/index.html' })
			return res.end()
		}
		const p = decodeURIComponent(url.pathname)
		const file = path.join(root, p)
		if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404)
			return res.end('not found')
		}
		let data = fs.readFileSync(file)
		if (p.endsWith('index.html')) data = data.toString().replace('<script src="../src/timecode.js">', '<script src="/__shim.js"></script>\n\t\t<script src="../src/timecode.js">')
		res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
		res.end(data)
	})
	.listen(port, () => console.log(`Preview: http://localhost:${port}  (logs in ${logDir})`))
