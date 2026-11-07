const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('api', {
  sendAudio: (buf) => ipcRenderer.send('audio', buf),
  sendMicAudio: (buf) => ipcRenderer.send('audio:mic', buf),
  setListening: (on) => ipcRenderer.send('listen:set', !!on),
  onUtterance: on('utterance'),
  onTranslation: on('translation'),
  onRepliesWait: on('replies-wait'),
  onRepliesStart: on('replies-start'),
  onReply: on('reply'),
  onRepliesEnd: on('replies-end'),
  onStatus: on('stt-status'),
  onClickThrough: on('click-through'),
  onBanner: on('banner'),
  onSpeakerMe: on('speaker-me'),
  setMeSpeaker: (spk) => ipcRenderer.send('speaker:me', spk),
  onLogState: on('log-state'),
  toggleLog: () => ipcRenderer.invoke('log:toggle'),
  logState: () => ipcRenderer.invoke('log:state'),
  openLogFolder: () => ipcRenderer.send('log:open-folder'),
  logEvent: (type, data) => ipcRenderer.send('log:event', type, data),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  ollamaModels: () => ipcRenderer.invoke('ollama:models'),
  clearHistory: () => ipcRenderer.send('history:clear'),
  toggleClickThrough: () => ipcRenderer.send('window:click-through'),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
});
