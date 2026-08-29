const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const token = crypto.randomBytes(32).toString('hex');
const env = {
  ...process.env,
  VIDEO_TRIMMER_AUTH_TOKEN: token,
  VIDEO_TRIMMER_PARENT_PID: String(process.pid),
  VITE_BACKEND_TOKEN: token
};
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const frontend = spawn(npmCommand, ['run', 'dev', '--prefix', 'video-editor-frontend'], {
  cwd: rootDir,
  env,
  stdio: 'inherit'
});
// Keep a single backend process. Node's --watch supervisor intentionally
// recreates its child when that child is ended from Task Manager, which makes
// a manually stopped server appear to reopen itself.
const backend = spawn(process.execPath, ['server.cjs'], {
  cwd: rootDir,
  env,
  stdio: 'inherit'
});

let stopping = false;

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const taskkill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      const timeout = setTimeout(resolve, 5000);
      timeout.unref();
      taskkill.once('error', () => {
        clearTimeout(timeout);
        resolve();
      });
      taskkill.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  child.kill('SIGTERM');
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  Promise.allSettled([
    terminateProcessTree(frontend),
    terminateProcessTree(backend)
  ]).finally(() => process.exit(exitCode));
}

frontend.on('exit', (code) => {
  if (!stopping) stop(code ?? 0);
});
backend.on('exit', (code) => {
  if (!stopping) stop(code ?? 0);
});
frontend.on('error', () => stop(1));
backend.on('error', () => stop(1));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('SIGHUP', () => stop(0));
