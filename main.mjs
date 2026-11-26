// ATEM Cut Logger — Electron main process
// Owns the logging engine (switcher connection, demo switcher, log files), settings and updates.

import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { Engine } = require('./src/engine.js')
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))

let win = null
let engine = null

// ---------------------------------------------------------------- settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const defaultLogDir = () => path.join(app.getPath('documents'), 'ATEM Cut Logger Logs')
function loadSettings() {
	try {
		return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
	} catch {
		return null
	}
}
function saveSettings(s) {
	try {
		fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
		fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
		if (s?.logDir && engine && s.logDir !== engine.logDir) engine.setLogDir(s.logDir)
		return true
	} catch (e) {
		console.error('save settings failed', e)
		return false
	}
}

const send = (channel, data) => {
	if (win && !win.isDestroyed()) win.webContents.send(channel, data)
}

// ---------------------------------------------------------------- saved logs
function readLog(file) {
	const text = fs.readFileSync(file, 'utf8')
	const rows = []
	const lines = text.split(/\r?\n/).filter(Boolean)
	lines.forEach((l, i) => {
		try {
			rows.push(JSON.parse(l))
		} catch {
			// The last line can be cut short if the Mac lost power mid-write; skip it.
			if (i !== lines.length - 1) throw new Error(`Line ${i + 1} of the log is damaged.`)
		}
	})
	const header = rows.find((r) => r.type === 'session')
	if (!header) throw new Error("This file isn't an ATEM Cut Logger log.")
	return { header, events: rows.filter((r) => r.type !== 'session').sort((a, b) => a.t - b.t) }
}

async function openLog() {
	const r = await dialog.showOpenDialog(win, {
		title: 'Open a log',
		defaultPath: engine.logDir,
		properties: ['openFile'],
		filters: [{ name: 'Cut logs', extensions: ['jsonl'] }],
	})
	if (r.canceled || !r.filePaths[0]) return null
	try {
		const file = r.filePaths[0]
		return { ok: true, file, name: path.basename(file), ...readLog(file) }
	} catch (e) {
		return { ok: false, reason: e.message }
	}
}

// ---------------------------------------------------------------- updates (from a GitHub repository)
// The app checks the repo's package.json version. To update, it downloads the repo, then runs the
// same build as "Install ATEM Cut Logger" in a Terminal window and quits; the new version opens when done.
function normaliseRepo(repo) {
	return String(repo || '')
		.trim()
		.replace(/^https?:\/\/github\.com\//i, '')
		.replace(/\.git$/i, '')
		.replace(/\/+$/, '')
}
function ghHeaders(token, accept = 'application/vnd.github.raw+json') {
	const h = { 'User-Agent': 'ATEM-Cut-Logger', Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' }
	if (token) h.Authorization = `Bearer ${token.trim()}`
	return h
}
function cmpVersion(a, b) {
	const pa = String(a).split('.').map(Number)
	const pb = String(b).split('.').map(Number)
	for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
	return 0
}
async function ghFile(repo, file, token) {
	const r = await fetch(`https://api.github.com/repos/${repo}/contents/${file}`, { headers: ghHeaders(token) })
	if (!r.ok) {
		const reason =
			r.status === 404
				? 'Repository not found. Check the name, or add an access token if it is private.'
				: r.status === 401 || r.status === 403
				? 'GitHub refused access. Check the access token.'
				: `GitHub replied ${r.status}`
		throw new Error(reason)
	}
	return r.text()
}
async function checkUpdate({ repo, token }) {
	repo = normaliseRepo(repo)
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, reason: 'Enter the repository as owner/name' }
	try {
		const remote = JSON.parse(await ghFile(repo, 'package.json', token))
		let notes = ''
		try {
			const changelog = await ghFile(repo, 'CHANGELOG.md', token)
			const sections = changelog.split(/\n(?=## )/).filter((sec) => sec.startsWith('## '))
			// Notes for every version newer than this one
			notes = sections
				.filter((sec) => cmpVersion(sec.slice(3).trim().split(/\s/)[0], app.getVersion()) > 0)
				.join('\n\n')
				.trim()
		} catch {
			/* no changelog */
		}
		const current = app.getVersion()
		return { ok: true, repo, current, latest: remote.version, newer: cmpVersion(remote.version, current) > 0, notes }
	} catch (e) {
		return { ok: false, reason: e?.message ?? String(e) }
	}
}
async function installUpdate({ repo, token }) {
	if (process.platform !== 'darwin') return { ok: false, reason: 'Updating is only set up for macOS' }
	if (engine.mode === 'atem') return { ok: false, reason: 'Disconnect from the switcher first.' }
	repo = normaliseRepo(repo)
	try {
		const root = path.join(app.getPath('userData'), 'updates')
		fs.rmSync(root, { recursive: true, force: true }) // clear older downloads
		const dir = path.join(root, String(Date.now()))
		fs.mkdirSync(dir, { recursive: true })
		engine.sys(`Downloading update from github.com/${repo}…`)
		const r = await fetch(`https://api.github.com/repos/${repo}/zipball`, { headers: ghHeaders(token, 'application/vnd.github+json') })
		if (!r.ok) throw new Error(`Download failed (GitHub replied ${r.status})`)
		const zip = path.join(dir, 'src.zip')
		fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()))
		const x = spawnSync('ditto', ['-x', '-k', zip, dir])
		if (x.status !== 0) throw new Error('Could not unpack the download')
		const src = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => path.join(dir, d.name))
			.find((d) => fs.existsSync(path.join(d, 'scripts', 'build-mac-app.sh')))
		if (!src) throw new Error("The download doesn't look like an ATEM Cut Logger project")
		const runner = path.join(dir, 'Update ATEM Cut Logger.command')
		fs.writeFileSync(
			runner,
			`#!/bin/bash\necho "Updating ATEM Cut Logger… You can close this window once it says Done."\nsleep 2\ncd ${JSON.stringify(src)}\nbash scripts/build-mac-app.sh\n`,
			{ mode: 0o755 }
		)
		await engine.stop()
		spawn('open', ['-a', 'Terminal', runner], { detached: true, stdio: 'ignore' }).unref()
		engine.sys('The update is building in a Terminal window. This app will now close; the new version opens when the build finishes.')
		setTimeout(() => {
			quitting = true
			app.quit()
		}, 2500)
		return { ok: true }
	} catch (e) {
		return { ok: false, reason: e?.message ?? String(e) }
	}
}

// ---------------------------------------------------------------- window
let quitting = false
function createWindow() {
	win = new BrowserWindow({
		width: 1600,
		height: 960,
		minWidth: 1100,
		minHeight: 640,
		backgroundColor: '#0f1115',
		title: 'ATEM Cut Logger',
		icon: path.join(__dirname, 'build', 'icon.png'),
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	})
	win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
	// Don't let a stray click close the window in the middle of logging a show.
	win.on('close', (e) => {
		if (quitting || !engine.session || engine.mode !== 'atem') return
		const choice = dialog.showMessageBoxSync(win, {
			type: 'warning',
			buttons: ['Keep logging', 'Stop logging and quit'],
			defaultId: 0,
			cancelId: 0,
			message: 'Still logging the switcher',
			detail: 'Quitting stops logging. Everything logged so far is already saved.',
		})
		if (choice === 0) e.preventDefault()
	})
	win.on('closed', () => (win = null))
}

app.whenReady().then(() => {
	const settings = loadSettings() || {}
	engine = new Engine({ logDir: settings.logDir || defaultLogDir(), appVersion: app.getVersion() })
	engine.on('state', (s) => send('engine:state', s))
	engine.on('session', (s) => send('engine:session', s))
	engine.on('event', (e) => send('engine:event', e))
	engine.on('sys', (s) => send('engine:sys', s))
	engine.on('sessionEnd', (s) => send('engine:sessionEnd', s))

	ipcMain.handle('engine:connect', (_e, { ip, me, opts }) => engine.connectAtem(String(ip), Number(me) || 1, opts || {}))
	ipcMain.handle('engine:demo', (_e, o) => engine.startDemo(o || {}))
	ipcMain.handle('engine:disconnect', () => engine.stop())
	ipcMain.handle('engine:newSession', () => engine.newSession())
	ipcMain.handle('engine:startLogging', (_e, name) => engine.startLogging(name))
	ipcMain.handle('engine:stopLogging', () => engine.stopLogging())
	ipcMain.handle('log:reveal', (_e, file) => {
		if (file && fs.existsSync(file)) shell.showItemInFolder(file)
		else shell.openPath(engine.logDir)
	})
	ipcMain.handle('engine:marker', (_e, text) => engine.marker(text))
	ipcMain.handle('engine:sync', () => engine.sync())
	ipcMain.handle('engine:demoCmd', (_e, { cmd, arg }) => engine.demoCommand(cmd, arg))
	ipcMain.handle('engine:getState', () => engine.getState())
	ipcMain.handle('engine:getSession', () => engine.getSession())
	ipcMain.handle('log:open', () => openLog())
	ipcMain.handle('log:chooseDir', async () => {
		const r = await dialog.showOpenDialog(win, { title: 'Folder for log files', defaultPath: engine.logDir, properties: ['openDirectory', 'createDirectory'] })
		if (r.canceled || !r.filePaths[0]) return null
		engine.setLogDir(r.filePaths[0])
		return r.filePaths[0]
	})
	ipcMain.handle('log:openDir', () => {
		fs.mkdirSync(engine.logDir, { recursive: true })
		return shell.openPath(engine.logDir)
	})
	ipcMain.handle('app:info', () => ({ version: app.getVersion(), updateRepo: pkg.updateRepo || '' }))
	ipcMain.handle('app:copy', (_e, text) => clipboard.writeText(String(text)))
	ipcMain.handle('update:check', (_e, o) => checkUpdate(o ?? {}))
	ipcMain.handle('update:install', (_e, o) => installUpdate(o ?? {}))
	ipcMain.handle('settings:load', () => loadSettings())
	ipcMain.handle('settings:save', (_e, s) => saveSettings(s))

	createWindow()
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

app.on('before-quit', () => (quitting = true))
app.on('window-all-closed', async () => {
	await engine?.stop()
	app.quit()
})
