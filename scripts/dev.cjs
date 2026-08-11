const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const token = crypto.randomBytes(32).toString('hex');
const env = {
  ...process.env,
  VIDEO_TRIMMER_AUTH_TOKEN: token,
  VITE_BACKEND_TOKEN: token
};
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const frontend = spawn(npmCommand, ['run', 'dev', '--prefix', 'video-editor-frontend'], {
  cwd: rootDir,
  env,
  stdio: 'inherit'
});
const backend = spawn(process.execPath, ['--watch', 'server.cjs'], {
  cwd: rootDir,
  env,
  stdio: 'inherit'
});

function stop(exitCode = 0) {
  frontend.kill();
  backend.kill();
  process.exit(exitCode);
}

frontend.on('exit', (code) => stop(code ?? 0));
backend.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
