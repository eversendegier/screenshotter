const { app, BrowserWindow, dialog, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');

const PORT = 3000;
let mainWindow;
let serverProcess;

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let updateDialogShown = false;

autoUpdater.on('update-downloaded', () => {
  if (updateDialogShown) return;
  updateDialogShown = true;
  dialog.showMessageBox({
    type: 'info',
    title: 'Update beschikbaar',
    message: 'Er is een nieuwe versie van Screenshotter gedownload. De app herstart om de update te installeren.',
    buttons: ['Nu herstarten', 'Later'],
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall();
  });
});

function checkForUpdatesManually() {
  autoUpdater.once('update-available', () => {
    dialog.showMessageBox({ type: 'info', title: 'Update gevonden', message: 'Er is een nieuwe versie beschikbaar. Die wordt nu gedownload.', buttons: ['OK'] });
  });
  autoUpdater.once('update-not-available', () => {
    dialog.showMessageBox({ type: 'info', title: 'Geen update', message: 'Je gebruikt al de nieuwste versie.', buttons: ['OK'] });
  });
  autoUpdater.once('error', (err) => {
    dialog.showMessageBox({ type: 'error', title: 'Update mislukt', message: `Kon niet controleren op updates: ${err.message}`, buttons: ['OK'] });
  });
  autoUpdater.checkForUpdates();
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { label: `Over Screenshotter`, role: 'about' },
        { label: 'Zoek naar updates…', click: checkForUpdatesManually },
        { type: 'separator' },
        { label: 'Verberg Screenshotter', role: 'hide' },
        { label: 'Verberg andere', role: 'hideOthers' },
        { type: 'separator' },
        { label: 'Stop Screenshotter', role: 'quit' },
      ],
    },
    {
      label: 'Bewerken',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function waitForServer(retries = 30) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`http://localhost:${PORT}`, () => resolve())
        .on('error', () => {
          if (n <= 0) return reject(new Error('Server kon niet starten'));
          setTimeout(() => attempt(n - 1), 200);
        });
    };
    attempt(retries);
  });
}

function startServer() {
  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'server.js')
    : path.join(__dirname, 'server.js');

  serverProcess = fork(serverPath, [], {
    env: { ...process.env, ELECTRON_APP: '1' },
    silent: true,
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#FAF7F2',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer();
    buildMenu();
    await createWindow();
    if (app.isPackaged) autoUpdater.checkForUpdates();
  } catch (e) {
    console.error('Kon server niet starten:', e.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});
