const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
	connect: (ip, me, opts) => ipcRenderer.invoke('engine:connect', { ip, me, opts }),
	startDemo: (o) => ipcRenderer.invoke('engine:demo', o),
	disconnect: () => ipcRenderer.invoke('engine:disconnect'),
	newSession: () => ipcRenderer.invoke('engine:newSession'),
	startLogging: (name) => ipcRenderer.invoke('engine:startLogging', name),
	stopLogging: () => ipcRenderer.invoke('engine:stopLogging'),
	revealFile: (file) => ipcRenderer.invoke('log:reveal', file),
	marker: (text) => ipcRenderer.invoke('engine:marker', text),
	sync: () => ipcRenderer.invoke('engine:sync'),
	demo: (cmd, arg) => ipcRenderer.invoke('engine:demoCmd', { cmd, arg }),
	getState: () => ipcRenderer.invoke('engine:getState'),
	getSession: () => ipcRenderer.invoke('engine:getSession'),
	openLog: () => ipcRenderer.invoke('log:open'),
	chooseLogDir: () => ipcRenderer.invoke('log:chooseDir'),
	openLogDir: () => ipcRenderer.invoke('log:openDir'),
	appInfo: () => ipcRenderer.invoke('app:info'),
	copyText: (text) => ipcRenderer.invoke('app:copy', text),
	checkUpdate: (o) => ipcRenderer.invoke('update:check', o),
	installUpdate: (o) => ipcRenderer.invoke('update:install', o),
	loadSettings: () => ipcRenderer.invoke('settings:load'),
	saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
	onState: (cb) => ipcRenderer.on('engine:state', (_e, s) => cb(s)),
	onSession: (cb) => ipcRenderer.on('engine:session', (_e, s) => cb(s)),
	onEvent: (cb) => ipcRenderer.on('engine:event', (_e, ev) => cb(ev)),
	onSys: (cb) => ipcRenderer.on('engine:sys', (_e, s) => cb(s)),
	resolveOpen: (file) => ipcRenderer.invoke('resolve:open', file),
	resolvePickLog: () => ipcRenderer.invoke('resolve:pickLog'),
	resolveChooseFiles: (title) => ipcRenderer.invoke('resolve:chooseFiles', title),
	resolveProbe: (paths) => ipcRenderer.invoke('resolve:probe', paths),
	resolveAnalyze: (file, config) => ipcRenderer.invoke('resolve:analyze', { file, config }),
	resolveMake: (file, config) => ipcRenderer.invoke('resolve:make', { file, config }),
	pathForFile: (f) => {
		try {
			return webUtils.getPathForFile(f)
		} catch {
			return null
		}
	},
	onSessionEnd: (cb) => ipcRenderer.on('engine:sessionEnd', (_e, s) => cb(s)),
})
