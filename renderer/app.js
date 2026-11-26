// ATEM Cut Logger — window logic: header, console, demo switcher panel, settings and updates.
// The engine (in the main process) does the logging; this only shows it.
;(function () {
	'use strict'
	const api = window.api
	const $ = (id) => document.getElementById(id)
	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

	const DEFAULT_SETTINGS = { ip: '', me: 1, logDir: '', demoFormat: '2160p29.97', consoleWidth: 440, conFilter: 'all', autoLog: false, lastName: '', update: { repo: '', token: '' } }
	let S = { ...DEFAULT_SETTINGS }
	let state = { mode: 'idle', conn: 'idle', inputs: {} }
	const liveModel = new SessionModel()
	const liveEntries = [] // everything shown in the live console: { ev } or { sys } or { sep }
	let viewing = null // { model, entries, header, file } when looking at a saved log
	let inputsKey = ''
	const timeline = new Timeline($('tl'), $('tooltip'))
	const MAX_DOM_LINES = 4000
	const MAX_ENTRIES = 50000

	// ---------------------------------------------------------------- settings
	async function loadSettings() {
		const s = (await api.loadSettings()) || {}
		S = { ...DEFAULT_SETTINGS, ...s, update: { ...DEFAULT_SETTINGS.update, ...(s.update || {}) } }
	}
	let saveTimer = null
	function saveSettings() {
		clearTimeout(saveTimer)
		saveTimer = setTimeout(() => api.saveSettings(S), 250)
	}

	// ---------------------------------------------------------------- names
	function inputsFor() {
		return viewing ? viewing.inputs : state.inputs || {}
	}
	function srcName(id, inputs = inputsFor()) {
		if (id === 'black') return 'Black'
		const i = inputs[id]
		if (i) return i.name
		const h = viewing ? viewing.model.header : liveModel.header
		return h?.inputs?.[id] || `Input ${id}`
	}
	function inputsFromHeader(h) {
		const inputs = {}
		const cams = new Set((h.cameras || []).map(String))
		for (const [id, name] of Object.entries(h.inputs || {})) {
			const n = Number(id)
			inputs[id] = { name, short: '', camera: cams.size ? cams.has(String(id)) : n >= 1 && n <= 40 }
		}
		return inputs
	}

	// ---------------------------------------------------------------- console
	const conBody = $('conBody')
	let autoScroll = true
	const TAGS = { mix: 'MIX', dip: 'DIP', wipe: 'WIPE', dve: 'DVE', sting: 'STING' }

	function timeLabel(entry, model) {
		const e = entry.ev
		if (e && e.tc) return e.tc
		const t = e ? e.t : entry.sys ? entry.sys.t : null
		if (t == null) return ''
		if (!viewing && state.tcAnchor) {
			try {
				const rate = TC.getRate(state.tcAnchor.fps)
				return TC.framesToTc(Math.floor(state.tcAnchor.frames + TC.msToFrames(t - state.tcAnchor.ms, rate)), rate, state.tcAnchor.dropFrame)
			} catch {
				/* fall through */
			}
		}
		const d = new Date(t)
		return d.toLocaleTimeString([], { hour12: false })
	}

	function describe(e, inputs) {
		const n = (id) => esc(srcName(id, inputs))
		const arrow = ' <span class="arrow">→</span> '
		switch (e.type) {
			case 'initial':
				return { k: 'start', c: 'switch', tag: 'START', msg: `On air: ${n(e.program)}${e.black ? ' <span class="dim">(faded to black)</span>' : ''} <span class="dim">· preview ${n(e.preview)}</span>` }
			case 'cut':
				return { k: 'cut', c: 'switch', tag: 'CUT', msg: n(e.from) + arrow + n(e.to) }
			case 'transition': {
				const ms = e.tEnd - e.t
				return {
					k: e.style || 'mix',
					c: 'switch',
					tag: TAGS[e.style] || String(e.style || 'MIX').toUpperCase(),
					msg: `${n(e.from)}${arrow}${n(e.to)} <span class="dim">${e.rateFrames ? e.rateFrames + 'f · ' : ''}${(ms / 1000).toFixed(2)} s</span>`,
				}
			}
			case 'black_on':
				return { k: 'ftb', c: 'switch', tag: 'FTB', msg: 'Fade to black' }
			case 'black_off':
				return { k: 'ftb', c: 'switch', tag: 'FTB', msg: 'Fade up from black' }
			case 'sync':
				return { k: 'sync', c: 'notes', tag: 'SYNC', msg: `Sync point #${e.n}` }
			case 'marker':
				return { k: 'marker', c: 'notes', tag: 'MARK', msg: esc(e.note) }
			case 'record_start':
				return { k: 'rec', c: 'notes', tag: 'REC', msg: "Switcher's recorder started" }
			case 'record_stop':
				return { k: 'rec', c: 'notes', tag: 'REC', msg: "Switcher's recorder stopped" }
			case 'disconnected':
				return { k: 'err', c: 'sys', tag: 'LOST', msg: 'Connection to the switcher lost' }
			case 'reconnected':
				return { k: 'warn', c: 'sys', tag: 'BACK', msg: 'Reconnected to the switcher' }
			case 'end':
				return { k: 'sys', c: 'sys', tag: 'END', msg: 'Log closed' }
			default:
				return null
		}
	}

	function lineFor(entry, inputs) {
		const div = document.createElement('div')
		if (entry.sep) {
			div.className = 'ln sep c-switch c-notes c-sys'
			div.textContent = entry.sep
			return div
		}
		if (entry.saved) {
			div.className = 'ln k-start c-sys c-notes c-switch'
			div.innerHTML = `<span class="ts">${esc(timeLabel({ sys: { t: entry.saved.t } }))}</span><span class="tag">SAVED</span><span class="msg">${esc(entry.saved.name)}<span class="act">Show in Finder</span></span>`
			div.querySelector('.act').onclick = (e) => {
				e.stopPropagation()
				api.revealFile(entry.saved.file)
			}
			return div
		}
		if (entry.sys) {
			const lvl = entry.sys.level === 'error' ? 'err' : entry.sys.level === 'warn' ? 'warn' : 'sys'
			div.className = `ln k-${lvl} c-sys`
			div.innerHTML = `<span class="ts">${esc(timeLabel(entry))}</span><span class="tag">${lvl === 'err' ? 'ERROR' : lvl === 'warn' ? 'WARN' : 'SYS'}</span><span class="msg">${esc(entry.sys.msg)}</span>`
			return div
		}
		const d = describe(entry.ev, inputs)
		if (!d) return null
		div.className = `ln k-${d.k} c-${d.c}`
		div.dataset.t = entry.ev.type === 'transition' ? (entry.ev.t + entry.ev.tEnd) / 2 : entry.ev.t
		div.innerHTML = `<span class="ts">${esc(timeLabel(entry))}</span><span class="tag">${d.tag}</span><span class="msg">${d.msg}</span>`
		return div
	}

	function appendEntry(entry) {
		const div = lineFor(entry, inputsFor())
		if (!div) return
		const stick = autoScroll
		conBody.appendChild(div)
		while (conBody.childElementCount > MAX_DOM_LINES) conBody.firstElementChild.remove()
		if (stick) conBody.scrollTop = conBody.scrollHeight
		else $('conJump').hidden = false
		updateCount()
	}

	function renderConsole(entries) {
		conBody.textContent = ''
		const frag = document.createDocumentFragment()
		const inputs = inputsFor()
		for (const e of entries.slice(-MAX_DOM_LINES)) {
			const div = lineFor(e, inputs)
			if (div) frag.appendChild(div)
		}
		conBody.appendChild(frag)
		autoScroll = true
		$('conJump').hidden = true
		conBody.scrollTop = conBody.scrollHeight
		updateCount()
	}

	function updateCount() {
		const m = viewing ? viewing.model : liveModel
		const n = m.switchCount
		$('conCount').textContent = m.events.length ? `${n} switch${n === 1 ? '' : 'es'} · ${m.markers.filter((k) => k.kind === 'note' || k.kind === 'sync').length} markers` : ''
	}

	conBody.addEventListener('scroll', () => {
		const atBottom = conBody.scrollTop + conBody.clientHeight >= conBody.scrollHeight - 24
		autoScroll = atBottom
		if (atBottom) $('conJump').hidden = true
	})
	$('conJump').onclick = () => {
		autoScroll = true
		conBody.scrollTop = conBody.scrollHeight
		$('conJump').hidden = true
	}
	conBody.addEventListener('click', (e) => {
		const ln = e.target.closest('.ln')
		if (!ln || !ln.dataset.t) return
		for (const x of conBody.querySelectorAll('.ln.hl')) x.classList.remove('hl')
		ln.classList.add('hl')
		timeline.reveal(Number(ln.dataset.t))
	})
	function applyFilter() {
		conBody.classList.remove('f-switch', 'f-notes', 'f-sys')
		if (S.conFilter !== 'all') conBody.classList.add(`f-${S.conFilter}`)
		$('conFilter').value = S.conFilter
	}
	$('conFilter').onchange = () => {
		S.conFilter = $('conFilter').value
		applyFilter()
		saveSettings()
		conBody.scrollTop = conBody.scrollHeight
	}
	$('conCopy').onclick = async () => {
		const lines = [...conBody.querySelectorAll('.ln')].filter((l) => l.offsetParent !== null).map((l) => (l.classList.contains('sep') ? l.textContent : [...l.children].map((c) => c.textContent).join('  ')))
		await api.copyText(lines.join('\n'))
		const b = $('conCopy')
		b.textContent = 'Copied'
		setTimeout(() => (b.textContent = 'Copy'), 1200)
	}

	function pushLive(entry) {
		liveEntries.push(entry)
		if (liveEntries.length > MAX_ENTRIES) liveEntries.splice(0, liveEntries.length - MAX_ENTRIES)
		if (!viewing) appendEntry(entry)
	}

	// ---------------------------------------------------------------- markers
	function dropNote() {
		const v = $('noteInput').value.trim()
		if (!v) return
		api.marker(v)
		$('noteInput').value = ''
	}
	$('noteInput').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') dropNote()
		if (e.key === 'Escape') $('noteInput').blur()
	})
	$('syncBtn').onclick = () => api.sync()

	// ---------------------------------------------------------------- header / state
	function setPill(el, text, cls) {
		el.textContent = text
		el.className = `pill ${cls}`
	}

	function applyState(s) {
		state = s
		const demo = s.mode === 'demo'
		// connection pill
		const model = s.info?.model || 'switcher'
		const fmt = s.info ? TC.prettyVideoMode(s.info.videoMode) : ''
		if (s.mode === 'idle') setPill($('connPill'), 'Not connected', 'off')
		else if (s.conn === 'connecting') setPill($('connPill'), demo ? 'Starting demo…' : `Connecting to ${s.ip}…`, 'warn')
		else if (s.conn === 'reconnecting') setPill($('connPill'), 'Connection lost · reconnecting…', 'err')
		else setPill($('connPill'), demo ? `DEMO switcher · ${fmt}` : `${model} · ${fmt}`, demo ? 'demo' : 'ok')
		$('connPill').title = s.ip ? `Switcher at ${s.ip}` : ''
		// buttons
		const atem = s.mode === 'atem'
		$('connectBtn').textContent = atem ? 'Disconnect' : 'Connect'
		$('connectBtn').classList.toggle('ghost', atem)
		$('ip').disabled = atem
		$('demoBtn').textContent = demo ? 'Stop demo' : 'Demo'
		$('demoBtn').classList.toggle('on', demo)
		const connected = s.conn === 'connected' || (s.conn === 'reconnecting' && !!s.session)
		const logging = !!s.session
		$('startLogBtn').hidden = logging
		$('startLogBtn').disabled = s.conn !== 'connected'
		$('startLogBtn').classList.toggle('attn', s.conn === 'connected' && !logging)
		$('stopLogBtn').hidden = !logging
		$('newLogBtn').hidden = !logging
		$('newLogBtn').disabled = s.conn !== 'connected'
		timeline.emptyText =
			s.mode === 'idle'
				? 'Connect to your switcher (top right), or click Demo to try it with a simulated switcher.'
				: connected
				? 'Connected. Click ● Start logging (top right) to record switches.'
				: 'Waiting for the switcher…'
		// on air
		const live = s.live
		const inputs = s.inputs || {}
		$('pgmName').textContent = live ? (live.ftbFullyBlack ? `${srcName(live.program, inputs)} (black)` : srcName(live.program, inputs)) : '—'
		$('pvwName').textContent = live ? srcName(live.preview, inputs) : '—'
		// inputs changed -> rebuild tracks
		const key = JSON.stringify(inputs)
		if (key !== inputsKey) {
			inputsKey = key
			if (!viewing) timeline.setInputs(inputs)
			buildDemoButtons(inputs)
		}
		timeline.setLive(viewing ? null : live, s.tcAnchor)
		if (!viewing && s.info) timeline.setFps(s.info.fps)
		updateLogPill()
		// demo panel
		$('demoPanel').hidden = !demo || !!viewing
		if (demo && s.demo) applyDemo(s.demo, live)
		$('viewLiveNote').textContent = viewing && s.session ? 'Still logging live in the background.' : ''
	}

	function updateLogPill() {
		const s = state.session
		if (!s) {
			setPill($('logPill'), 'Not logging', 'off')
			$('logPill').title = state.lastFile ? `Last log: ${state.lastFile}\nClick to show it in Finder` : 'Click to open the logs folder'
			return
		}
		const dur = TC.fmtDuration(Date.now() - s.startedAt)
		setPill($('logPill'), `LOGGING ${dur} · ${s.name}`, 'rec')
		$('logPill').title = `Saving to ${s.file}\nClick to show it in Finder`
	}
	$('logPill').onclick = () => api.revealFile(state.session?.file || state.lastFile || null)
	setInterval(updateLogPill, 1000)

	$('connectBtn').onclick = async () => {
		if (state.mode === 'atem') {
			if (!confirm('Disconnect from the switcher? This closes the current log file.')) return
			return api.disconnect()
		}
		const ip = $('ip').value.trim()
		if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !/^[\w.-]+$/.test(ip)) {
			$('ip').focus()
			return pushLive({ sys: { msg: 'Enter the switcher\'s IP address first (for example 192.168.10.240).', level: 'warn', t: Date.now() } })
		}
		S.ip = ip
		saveSettings()
		if (viewing) closeViewer()
		api.connect(ip, S.me, { autoLog: S.autoLog, name: S.lastName })
	}
	$('ip').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') $('connectBtn').click()
	})
	$('demoBtn').onclick = () => {
		if (state.mode === 'demo') return api.disconnect()
		if (state.mode === 'atem' && !confirm('Stop logging the real switcher and start the demo instead?')) return
		if (viewing) closeViewer()
		api.startDemo({ format: S.demoFormat, autoLog: S.autoLog, name: S.lastName || 'Demo' })
	}

	// ---------------------------------------------------------------- start / stop logging
	function nameDialog(isNew) {
		const dlg = $('nameDlg')
		$('nameTitle').textContent = isNew ? 'New log file' : 'Start logging'
		$('nameIntro').textContent = isNew
			? `"${state.session?.name}" is saved and closed, and switches go into a new file from now on.`
			: 'Give this log a name, for example the show or segment.'
		$('nameGo').textContent = isNew ? 'Save and start new file' : 'Start logging'
		const def = state.mode === 'demo' ? S.lastName || 'Demo' : S.lastName || ''
		$('nameInput').value = def
		updateNamePreview()
		dlg.returnValue = ''
		dlg.showModal()
		$('nameInput').select()
		dlg.onclose = async () => {
			if (dlg.returnValue !== 'go') return
			const name = $('nameInput').value.trim()
			S.lastName = name
			saveSettings()
			if (viewing) closeViewer()
			const r = await api.startLogging(name)
			if (r && !r.ok && r.reason !== 'not-connected') alert(r.reason)
		}
	}
	function updateNamePreview() {
		const d = new Date()
		const pad = (x) => String(x).padStart(2, '0')
		const name = $('nameInput').value.trim() || (state.mode === 'demo' ? 'Demo' : 'Show')
		const dir = state.logDir || ''
		const tag = state.mode === 'demo' && !/demo/i.test(name) ? ' (demo)' : ''
		$('namePreview').textContent = `${dir ? dir + '/' : ''}${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())} ${name}${tag}.jsonl`
	}
	$('nameInput').addEventListener('input', updateNamePreview)
	$('startLogBtn').onclick = () => nameDialog(false)
	$('newLogBtn').onclick = () => nameDialog(true)
	$('stopLogBtn').onclick = () => {
		if (!confirm(`Stop logging "${state.session?.name}"? The file is saved and closed. Switches after this are not recorded until you start logging again.`)) return
		api.stopLogging()
	}

	// ---------------------------------------------------------------- live data
	function startSession(header) {
		liveModel.reset(header)
		pushLive({ sep: `── logging "${header.name || 'Show'}" · ${new Date(header.t).toLocaleTimeString([], { hour12: false })} ──` })
		if (!viewing) {
			timeline.setModel(liveModel, { isLive: true })
			timeline.setFps(header.fps)
			timeline.goLive()
			$('liveBtn').disabled = false
		}
		updateCount()
	}

	// ---------------------------------------------------------------- saved logs
	$('openLogBtn').onclick = async () => {
		const r = await api.openLog()
		if (!r) return
		if (!r.ok) return alert(r.reason)
		const m = new SessionModel()
		m.load(r.header, r.events)
		const inputs = inputsFromHeader(r.header)
		const entries = [{ sep: `── saved log · ${r.name} ──` }, ...r.events.map((ev) => ({ ev }))]
		viewing = { model: m, inputs, entries, file: r.file }
		$('viewName').textContent = r.name
		$('viewInfo').textContent = ` · ${r.header.model || ''} · ${TC.prettyVideoMode(r.header.videoMode)} · ${m.switchCount} switches · ${TC.fmtDuration((m.endT ?? r.events[r.events.length - 1]?.t ?? r.header.t) - r.header.t)}${r.events.some((e) => e.type === 'end') ? '' : ' · not closed (app stopped or still logging)'}`
		$('viewBanner').hidden = false
		$('liveBtn').disabled = true
		timeline.setInputs(inputs)
		timeline.setFps(r.header.fps)
		timeline.setModel(m, { isLive: false })
		renderConsole(entries)
		applyState(state)
	}
	function closeViewer() {
		viewing = null
		$('viewBanner').hidden = true
		const live = !!state.session
		$('liveBtn').disabled = !live
		timeline.setInputs(state.inputs || {})
		timeline.setFps(state.info?.fps || liveModel.header?.fps)
		timeline.setModel(liveModel, { isLive: live })
		if (live) timeline.goLive()
		renderConsole(liveEntries)
		applyState(state)
	}
	$('backLive').onclick = closeViewer

	// ---------------------------------------------------------------- timeline controls
	$('zoomIn').onclick = () => timeline.zoom(1.6)
	$('zoomOut').onclick = () => timeline.zoom(1 / 1.6)
	$('fitBtn').onclick = () => timeline.fit()
	$('liveBtn').onclick = () => timeline.goLive()
	timeline.onFollowChange = (on) => $('liveBtn').classList.toggle('on', on)

	// splitter
	;(() => {
		const sp = $('splitter')
		const con = $('console')
		con.style.width = `${S.consoleWidth}px`
		let drag = null
		sp.addEventListener('mousedown', (e) => {
			drag = { x: e.clientX, w: con.offsetWidth }
			sp.classList.add('on')
			e.preventDefault()
		})
		window.addEventListener('mousemove', (e) => {
			if (!drag) return
			const w = Math.max(300, Math.min(window.innerWidth * 0.6, drag.w - (e.clientX - drag.x)))
			con.style.width = `${w}px`
		})
		window.addEventListener('mouseup', () => {
			if (!drag) return
			drag = null
			sp.classList.remove('on')
			S.consoleWidth = $('console').offsetWidth
			saveSettings()
		})
	})()

	// ---------------------------------------------------------------- demo switcher panel
	function demoButtonIds(inputs) {
		const ids = Object.keys(inputs).map(Number)
		const cams = ids.filter((id) => inputs[id].camera).sort((a, b) => a - b)
		const others = [3010, 1000, 0].filter((id) => ids.includes(id))
		return [...cams, ...others]
	}
	function buildDemoButtons(inputs) {
		for (const [busId, cmd] of [
			['pgmBus', 'program'],
			['pvwBus', 'preview'],
		]) {
			const bus = $(busId)
			bus.textContent = ''
			for (const id of demoButtonIds(inputs)) {
				const b = document.createElement('button')
				b.dataset.id = id
				b.innerHTML = `${esc(inputs[id].short || id)}<small>${esc(inputs[id].name)}</small>`
				b.title = `${inputs[id].name} (input ${id})`
				b.onclick = () => api.demo(cmd, id)
				bus.appendChild(b)
			}
		}
	}
	function applyDemo(d, live) {
		for (const b of $('pgmBus').children) b.classList.toggle('on', live && Number(b.dataset.id) === live.program)
		for (const b of $('pvwBus').children) b.classList.toggle('on', live && Number(b.dataset.id) === live.preview)
		for (const b of $('styleBtns').children) b.classList.toggle('on', b.dataset.style === d.style)
		if (document.activeElement !== $('rateIn')) $('rateIn').value = d.rateFrames
		$('autoBtn').classList.toggle('running', !!live?.inTransition)
		$('ftbBtn').classList.toggle('black', !!live?.ftbFullyBlack)
		$('recBtn').classList.toggle('on', !!d.recording)
		$('recBtn').textContent = d.recording ? '■ Stop switcher REC' : '● Switcher REC'
		$('dropBtn').disabled = !d.connected
		$('dirOn').checked = !!d.director.on
		$('dirSpeed').value = `${d.director.minS},${d.director.maxS}`
		if (!tbarHeld && live && !live.inTransition) $('tbar').value = 0
		else if (!tbarHeld && live?.inTransition) $('tbar').value = Math.round((live.transitionPos || 0) * 1000)
	}
	for (const b of $('styleBtns').children) b.onclick = () => api.demo('style', b.dataset.style)
	$('rateIn').onchange = () => api.demo('rate', Number($('rateIn').value))
	$('cutBtn').onclick = () => api.demo('cut')
	$('autoBtn').onclick = () => api.demo('auto')
	$('ftbBtn').onclick = () => api.demo('ftb')
	$('recBtn').onclick = () => api.demo('record', !state.demo?.recording)
	$('dropBtn').onclick = () => api.demo('drop', 4000)
	function sendDirector() {
		const [minS, maxS] = $('dirSpeed').value.split(',').map(Number)
		api.demo('director', { on: $('dirOn').checked, minS, maxS })
	}
	$('dirOn').onchange = sendDirector
	$('dirSpeed').onchange = sendDirector
	let tbarHeld = false
	$('tbar').addEventListener('pointerdown', () => (tbarHeld = true))
	$('tbar').addEventListener('input', () => api.demo('tbar', Number($('tbar').value) / 1000))
	$('tbar').addEventListener('change', () => {
		tbarHeld = false
		if (Number($('tbar').value) >= 1000) $('tbar').value = 0
	})

	// ---------------------------------------------------------------- keyboard
	document.addEventListener('keydown', (e) => {
		const tag = e.target.tagName
		if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || $('settings').open || e.metaKey || e.ctrlKey || e.altKey) return
		const k = e.key
		if (k === 's' || k === 'S') return api.sync()
		if (k === 'n' || k === 'N') {
			e.preventDefault()
			return $('noteInput').focus()
		}
		if (k === 'l' || k === 'L') return timeline.goLive()
		if (k === 'f' || k === 'F') return timeline.fit()
		if (k === '+' || k === '=') return timeline.zoom(1.6)
		if (k === '-' || k === '_') return timeline.zoom(1 / 1.6)
		if (state.mode !== 'demo' || viewing) return
		const digit = /^Digit([1-9])$/.exec(e.code)
		if (digit) {
			const ids = demoButtonIds(state.inputs || {})
			const id = ids[Number(digit[1]) - 1]
			if (id != null) api.demo(e.shiftKey ? 'program' : 'preview', id)
			return
		}
		if (k === ' ') {
			e.preventDefault()
			return api.demo('cut')
		}
		if (k === 'Enter') {
			e.preventDefault()
			return api.demo('auto')
		}
		if (k === 'b' || k === 'B') return api.demo('ftb')
	})

	// ---------------------------------------------------------------- settings dialog
	const FORMATS = ['2160p23.976', '2160p25', '2160p29.97', '2160p50', '2160p59.94', '1080p25', '1080p29.97', '1080p50', '1080p59.94']
	$('demoFormat').innerHTML = FORMATS.map((f) => `<option>${f}</option>`).join('')
	$('settingsBtn').onclick = () => {
		$('logDir').textContent = state.logDir || S.logDir
		$('meSel').value = String(S.me)
		$('demoFormat').value = S.demoFormat
		$('updRepo').value = S.update.repo
		$('updToken').value = S.update.token
		$('autoLog').checked = !!S.autoLog
		$('settings').showModal()
	}
	$('autoLog').onchange = () => {
		S.autoLog = $('autoLog').checked
		saveSettings()
	}
	$('meSel').onchange = () => {
		S.me = Number($('meSel').value)
		saveSettings()
	}
	$('demoFormat').onchange = () => {
		S.demoFormat = $('demoFormat').value
		saveSettings()
	}
	$('logDirChange').onclick = async () => {
		const dir = await api.chooseLogDir()
		if (!dir) return
		S.logDir = dir
		$('logDir').textContent = dir
		saveSettings()
	}
	$('logDirOpen').onclick = () => api.openLogDir()

	// ---------------------------------------------------------------- updates
	let update = null
	$('updRepo').onchange = () => {
		S.update.repo = $('updRepo').value.trim()
		saveSettings()
	}
	$('updToken').onchange = () => {
		S.update.token = $('updToken').value.trim()
		saveSettings()
	}
	$('updCheck').onclick = () => checkUpdates(true)
	$('updPill').onclick = () => {
		$('settingsBtn').click()
		$('updInstall').scrollIntoView()
	}
	async function checkUpdates(manual) {
		const st = $('updStatus')
		if (!S.update.repo) return manual && (st.textContent = 'Enter the GitHub repository first.')
		if (manual) st.textContent = 'Checking…'
		const r = await api.checkUpdate({ repo: S.update.repo, token: S.update.token })
		$('updInstall').textContent = 'Install update'
		$('updInstall').dataset.armed = ''
		if (!r.ok) {
			if (manual) st.textContent = `Couldn't check: ${r.reason}`
			return
		}
		update = r
		$('updPill').hidden = !r.newer
		$('updInstall').hidden = !r.newer
		$('updNotes').hidden = !(r.newer && r.notes)
		$('updNotes').textContent = r.notes || ''
		st.textContent = r.newer ? `Version ${r.latest} is available (you have ${r.current}).` : `You have the latest version (${r.current}).`
	}
	$('updInstall').onclick = async () => {
		const b = $('updInstall')
		if (state.mode === 'atem') {
			$('updStatus').textContent = 'Disconnect from the switcher first. The app closes while it updates, so do this between shows.'
			return
		}
		if (!b.dataset.armed) {
			b.dataset.armed = '1'
			b.textContent = 'Click again to update now (app will close)'
			$('updStatus').textContent = 'The app closes, rebuilds itself in a Terminal window (a few minutes), then reopens. Your logs and settings are kept.'
			return
		}
		b.disabled = true
		b.textContent = 'Downloading…'
		const r = await api.installUpdate({ repo: S.update.repo, token: S.update.token })
		if (!r.ok) {
			b.disabled = false
			b.textContent = 'Install update'
			b.dataset.armed = ''
			$('updStatus').textContent = `Update failed: ${r.reason}`
		}
	}

	// ---------------------------------------------------------------- start
	;(async function init() {
		await loadSettings()
		const info = await api.appInfo()
		if (!S.update.repo && info.updateRepo) {
			S.update.repo = info.updateRepo
			saveSettings()
		}
		$('verLabel').textContent = `· you have ${info.version}`
		document.title = `ATEM Cut Logger ${info.version}`
		$('ip').value = S.ip
		$('console').style.width = `${S.consoleWidth}px`
		applyFilter()

		api.onState(applyState)
		api.onSession(({ header }) => startSession(header))
		api.onEvent((ev) => {
			liveModel.add(ev)
			pushLive({ ev })
			if (!viewing) updateCount()
		})
		api.onSys((sys) => pushLive({ sys }))
		api.onSessionEnd(({ file, header }) => {
			const name = file.split(/[\\/]/).pop()
			pushLive({ saved: { file, name, t: Date.now() } })
			// The finished log stays on the timeline (no longer live) until the next one starts.
			if (!viewing) {
				timeline.setModel(liveModel, { isLive: false })
				$('liveBtn').disabled = true
			}
		})

		const s = await api.getState()
		applyState(s)
		timeline.setModel(liveModel, { isLive: true })
		const sess = await api.getSession()
		if (sess) {
			startSession(sess.header)
			for (const ev of sess.events) {
				liveModel.add(ev)
				liveEntries.push({ ev })
			}
			renderConsole(liveEntries)
		} else {
			pushLive({ sys: { msg: `ATEM Cut Logger ${info.version}. Enter your switcher's IP address and click Connect, or click Demo to try it.`, level: 'info', t: Date.now() } })
		}
		if (S.update.repo) setTimeout(() => checkUpdates(false), 3000)
	})()
})()
