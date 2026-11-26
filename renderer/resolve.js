// "Make Resolve timeline" window: pick a log, add each camera's recordings, check that they cover
// the on-air time, choose options, and save an FCPXML that DaVinci Resolve (free or Studio)
// imports with File → Import → Timeline.
;(function () {
	'use strict'
	const api = window.api
	const $ = (id) => document.getElementById(id)
	const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
	const PALETTE = ['#3d7be0', '#2fae84', '#e08a2e', '#9b62db', '#cfae24', '#de5b8a', '#36abc9', '#86b83a', '#c46b3f', '#6f7fe0']

	let log = null // result of resolveOpen
	let cfg = null // { sync, clapNumber, audioFrom, range, unmapped, dissolves, timelineName, cameras: { id: { files, clapAt, offsetFrames } } }
	let analysis = null
	let analyzeTimer = null

	function defaults(l) {
		const cameras = {}
		for (const id of Object.keys(l.cameras)) cameras[id] = { files: [], clapAt: '', offsetFrames: 0 }
		return {
			sync: l.hasTc ? 'timecode' : 'clap',
			clapNumber: l.syncMarks[0]?.n ?? 1,
			audioFrom: null,
			range: 'all',
			unmapped: 'gap',
			dissolves: true,
			timelineName: l.header.name || l.name.replace(/\.jsonl$/, ''),
			cameras,
		}
	}

	async function open(file) {
		const dlg = $('resolveDlg')
		$('rxResult').hidden = true
		if (!dlg.open) dlg.showModal()
		let r = file ? await api.resolveOpen(file) : null
		if (!r) r = await api.resolvePickLog()
		if (!r) {
			if (!log) dlg.close()
			return
		}
		if (!r.ok) {
			alert(r.reason)
			if (!log) dlg.close()
			return
		}
		log = r
		cfg = { ...defaults(r), ...(r.saved || {}) }
		for (const id of Object.keys(r.cameras)) cfg.cameras[id] ??= { files: [], clapAt: '', offsetFrames: 0 }
		if (!r.hasTc) cfg.sync = 'clap'
		renderAll()
		analyze()
	}

	// ---------------------------------------------------------------- render
	function renderAll() {
		const h = log.header
		$('rxLogName').textContent = h.name || log.name
		$('rxLogInfo').textContent = ` · ${log.name} · ${TC.prettyVideoMode(h.videoMode)}${log.stillLogging ? ' · still logging (uses the switches so far)' : log.closed ? '' : ' · not closed properly (app stopped?)'}`
		$('rxTimeline').value = cfg.timelineName
		for (const r of document.querySelectorAll('input[name=rxSync]')) {
			r.checked = r.value === cfg.sync
			r.disabled = r.value === 'timecode' && !log.hasTc
		}
		$('rxTcHint').textContent = log.hasTc ? '' : " (this log has no switcher timecode)"
		const sm = $('rxSyncMark')
		sm.innerHTML = log.syncMarks.length
			? log.syncMarks.map((m) => `<option value="${m.n}">Sync point #${m.n}${m.tc ? ` at ${m.tc}` : ''}</option>`).join('')
			: '<option value="">No sync point in this log</option>'
		sm.value = String(cfg.clapNumber ?? '')
		$('rxClapBox').hidden = cfg.sync !== 'clap'
		$('rxAudio').innerHTML =
			'<option value="">Cut the audio with the picture</option>' +
			Object.values(log.cameras)
				.map((c) => `<option value="${c.id}">Keep ${esc(c.name)}'s audio all the way through</option>`)
				.join('')
		$('rxAudio').value = cfg.audioFrom == null ? '' : String(cfg.audioFrom)
		$('rxDissolves').value = cfg.dissolves ? 'yes' : 'no'
		$('rxRange').value = cfg.range
		$('rxRange').querySelector('[value=recording]').disabled = !log.recorded
		$('rxUnmapped').value = cfg.unmapped
		renderCams()
	}

	const ids = () =>
		Object.keys(log.cameras)
			.map(Number)
			.sort((a, b) => a - b)
			.map(String)

	function renderCams() {
		const box = $('rxCams')
		box.textContent = ''
		const all = ids()
		// cameras that were on air first
		const order = [...all.filter((id) => log.cameras[id].onAirMs > 0), ...all.filter((id) => !(log.cameras[id].onAirMs > 0))]
		for (const id of order) {
			const c = log.cameras[id]
			const cc = cfg.cameras[id]
			const used = c.onAirMs > 0
			const div = document.createElement('div')
			div.className = `rxCam${used ? '' : ' unused'}`
			div.dataset.id = id
			const color = PALETTE[all.indexOf(id) % PALETTE.length]
			const files = [...cc.files].sort((a, b) => (a.startFrames ?? 0) - (b.startFrames ?? 0))
			div.innerHTML = `
				<div class="rxCamHead">
					<span class="sw" style="background:${color}"></span>
					<b>${esc(c.name)}</b>
					<span class="muted">input ${id} · ${used ? `on air ${TC.fmtDuration(c.onAirMs)}, ${c.times}×` : 'not on air in this log'}</span>
					<span class="spacer"></span>
					<span class="rxCov" data-cov></span>
					<button type="button" class="ghost small" data-add>Add files…</button>
				</div>
				<div class="rxFiles">${
					files.length
						? files.map((f) => fileRow(f, cc.files.indexOf(f))).join('')
						: `<div class="rxDrop">${used ? 'Drag this camera\'s recording(s) here, or click Add files…' : 'No file needed (drag one here if you want its audio)'}</div>`
				}</div>
				<div class="rxCamOpts">
					<label class="rxClap" ${cfg.sync === 'clap' ? '' : 'hidden'}>Clap is at <input data-clap placeholder="HH:MM:SS:FF" value="${esc(cc.clapAt || '')}" spellcheck="false" /> <span class="muted">in this camera's recording (as Resolve shows it)</span></label>
					<label>Nudge <input data-nudge type="number" step="1" value="${Number(cc.offsetFrames) || 0}" /> frames</label>
				</div>`
			div.querySelector('[data-add]').onclick = async () => addFiles(id, await api.resolveChooseFiles(`Recordings from ${c.name}`))
			div.querySelector('[data-clap]').onchange = (e) => {
				cc.clapAt = e.target.value.trim()
				analyze()
			}
			div.querySelector('[data-nudge]').onchange = (e) => {
				cc.offsetFrames = Math.round(Number(e.target.value) || 0)
				analyze()
			}
			for (const b of div.querySelectorAll('[data-remove]')) {
				b.onclick = () => {
					cc.files.splice(Number(b.dataset.remove), 1)
					renderCams()
					analyze()
				}
			}
			for (const inp of div.querySelectorAll('[data-start]')) {
				inp.onchange = () => {
					cc.files[Number(inp.dataset.start)].startTcOverride = inp.value.trim()
					analyze()
				}
			}
			div.addEventListener('dragover', (e) => {
				e.preventDefault()
				div.classList.add('over')
			})
			div.addEventListener('dragleave', () => div.classList.remove('over'))
			div.addEventListener('drop', async (e) => {
				e.preventDefault()
				div.classList.remove('over')
				const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
				if (paths.length) addFiles(id, await api.resolveProbe(paths))
			})
			box.appendChild(div)
		}
		paintCoverage()
	}

	function fileRow(f, idx) {
		const tc = f.startTcOverride || f.startTc
		const rate = (() => {
			try {
				return TC.getRate(f.fps || log.header.fps)
			} catch {
				return TC.getRate('25')
			}
		})()
		let range = ''
		if (tc && f.durationFrames) {
			try {
				range = ` → ${TC.framesToTc(TC.tcToFrames(tc, rate) + f.durationFrames, rate, tc.includes(';'))}`
			} catch {
				/* bad timecode typed */
			}
		}
		const meta = [f.width ? `${f.width}×${f.height}` : null, f.fps ? `${f.fps} fps` : null, f.durationFrames ? TC.fmtDuration(TC.framesToMs(f.durationFrames, rate)) : null, f.hasAudio ? 'audio' : f.ok ? 'no audio' : null]
			.filter(Boolean)
			.join(' · ')
		const needTc = !tc && cfg.sync === 'timecode'
		return `<div class="rxFile${f.ok === false && !f.unknown ? ' bad' : ''}">
			<span class="fname" title="${esc(f.path)}">${esc(f.name)}</span>
			<span class="muted">${esc(meta || f.reason || '')}</span>
			<span class="spacer"></span>
			<label class="tcIn${needTc ? ' need' : ''}" title="Start timecode of this file${f.startTc ? ' (read from the file)' : ''}">TC <input data-start="${idx}" value="${esc(tc || '')}" placeholder="HH:MM:SS:FF" spellcheck="false" /></label>
			<span class="muted range">${esc(range)}</span>
			<button type="button" class="ghost small x" data-remove="${idx}" title="Remove">×</button>
		</div>`
	}

	function addFiles(id, probes) {
		if (!probes || !probes.length) return
		const cc = cfg.cameras[id]
		for (const p of probes) {
			if (cc.files.some((f) => f.path === p.path)) continue
			// a file can belong to one camera only
			for (const other of Object.values(cfg.cameras)) other.files = other.files.filter((f) => f.path !== p.path)
			cc.files.push(p)
		}
		renderCams()
		analyze()
	}

	function paintCoverage() {
		for (const div of document.querySelectorAll('.rxCam')) {
			const id = div.dataset.id
			const el = div.querySelector('[data-cov]')
			const st = analysis?.cameras?.[id]
			const has = cfg.cameras[id].files.length > 0
			const used = log.cameras[id].onAirMs > 0
			el.className = 'rxCov'
			if (!used) el.textContent = has ? 'audio only' : ''
			else if (!has) {
				el.textContent = 'needs a recording'
				el.classList.add('warn')
			} else if (!st) el.textContent = ''
			else if (st.coveredFrames >= st.neededFrames) {
				el.textContent = '✓ covers all its on-air time'
				el.classList.add('ok')
			} else {
				const pct = Math.floor((100 * st.coveredFrames) / Math.max(1, st.neededFrames))
				el.textContent = `⚠ ${pct}% covered${st.missingTc?.[0] ? ` · nothing at ${st.missingTc[0][0]}` : ''}`
				el.classList.add('warn')
			}
		}
	}

	// ---------------------------------------------------------------- analyse (dry run) on every change
	function analyze() {
		clearTimeout(analyzeTimer)
		analyzeTimer = setTimeout(async () => {
			const r = await api.resolveAnalyze(log.file, cfg)
			analysis = r.ok ? r : null
			const s = $('rxSummary')
			const w = $('rxWarnings')
			if (!r.ok) {
				s.className = 'rxSummary err'
				s.textContent = r.reason
				w.hidden = true
				$('rxMake').disabled = true
			} else {
				const x = r.summary
				s.className = 'rxSummary'
				s.innerHTML = `<b>${esc(x.name)}</b> · ${x.length} long · starts at ${x.startTc} · ${x.clips} clips · ${x.dissolves} dissolves${x.gaps ? ` · ${x.gaps} gaps` : ''} · ${x.files} file${x.files === 1 ? '' : 's'}`
				w.hidden = !r.warnings.length
				w.innerHTML = r.warnings.map((m) => `<li>${esc(m)}</li>`).join('')
				$('rxMake').disabled = x.files === 0
				if (x.files === 0) s.innerHTML += ' · <span class="warnText">add at least one camera recording</span>'
			}
			paintCoverage()
		}, 150)
	}

	// ---------------------------------------------------------------- controls
	function bind() {
		$('rxPickLog').onclick = () => open(null)
		$('rxTimeline').onchange = () => {
			cfg.timelineName = $('rxTimeline').value.trim()
			analyze()
		}
		for (const r of document.querySelectorAll('input[name=rxSync]')) {
			r.onchange = () => {
				cfg.sync = r.value
				renderAll()
				analyze()
			}
		}
		$('rxSyncMark').onchange = () => {
			cfg.clapNumber = Number($('rxSyncMark').value) || 1
			analyze()
		}
		$('rxAudio').onchange = () => {
			cfg.audioFrom = $('rxAudio').value || null
			analyze()
		}
		$('rxDissolves').onchange = () => {
			cfg.dissolves = $('rxDissolves').value === 'yes'
			analyze()
		}
		$('rxRange').onchange = () => {
			cfg.range = $('rxRange').value
			analyze()
		}
		$('rxUnmapped').onchange = () => {
			cfg.unmapped = $('rxUnmapped').value
			analyze()
		}
		$('rxMake').onclick = async () => {
			$('rxMake').disabled = true
			const r = await api.resolveMake(log.file, cfg)
			$('rxMake').disabled = false
			if (!r.ok) {
				if (!r.canceled) alert(r.reason)
				return
			}
			const box = $('rxResult')
			box.hidden = false
			box.innerHTML = `<b>✓ Saved ${esc(r.file.split(/[\\/]/).pop())}</b> <a href="#" data-reveal>Show in Finder</a>
				<ol>
					<li>In DaVinci Resolve, open your project and choose <b>File → Import → Timeline…</b></li>
					<li>Choose this <b>.fcpxml</b> file.</li>
					<li>Leave <b>"Automatically import source clips into media pool"</b> ticked and click <b>OK</b>. The timeline appears already cut.</li>
				</ol>
				<span class="muted">Also saved: a cut list you can open in a spreadsheet (${esc(r.csvFile.split(/[\\/]/).pop())}).</span>`
			box.querySelector('[data-reveal]').onclick = (e) => {
				e.preventDefault()
				api.revealFile(r.file)
			}
			box.scrollIntoView({ block: 'nearest' })
		}
		// Dropping a file anywhere else must not navigate the window away.
		for (const t of ['dragover', 'drop']) document.addEventListener(t, (e) => e.preventDefault())
	}
	bind()

	window.openResolve = open
})()
