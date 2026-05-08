const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');

const PORT = 3000;
let mainWindow;
let serverProcess;

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
    backgroundColor: '#f0ede8',
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
    await createWindow();
  } catch (e) {
    console.error('Kon server niet starten:', e.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});
