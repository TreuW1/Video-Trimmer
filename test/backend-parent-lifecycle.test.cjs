const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function readFirstLine(stream) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline === -1) return;
      cleanup();
      resolve(output.slice(0, newline).trim());
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`Launcher ended before reporting the backend PID: ${output}`));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processExists(pid);
}

async function waitForBackendReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { 'X-Video-Trimmer-Token': 'lifecycle-test-token' }
      });
      if (response.ok) return;
    } catch {
      // The bundled backend can take a moment to start on Windows.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend did not begin listening on port ${port}`);
}

test('backend exits after its desktop parent is terminated', { timeout: 15000 }, async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'video-trimmer-lifecycle-'));
  const port = await reservePort();
  const launcherSource = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['server.cjs'], {
      cwd: ${JSON.stringify(projectRoot)},
      env: {
        ...process.env,
        PORT: ${JSON.stringify(String(port))},
        VIDEO_TRIMMER_AUTH_TOKEN: 'lifecycle-test-token',
        VIDEO_TRIMMER_DATA_DIR: ${JSON.stringify(dataDirectory)},
        VIDEO_TRIMMER_PARENT_PID: String(process.pid)
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.stdout.pipe(process.stderr);
    child.stderr.pipe(process.stderr);
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
  const launcher = spawn(process.execPath, ['-e', launcherSource], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let launcherDiagnostics = '';
  launcher.stderr.on('data', (chunk) => {
    launcherDiagnostics = `${launcherDiagnostics}${chunk}`.slice(-12000);
  });

  let backendPid = null;
  try {
    backendPid = Number.parseInt(await readFirstLine(launcher.stdout), 10);
    assert.ok(Number.isSafeInteger(backendPid) && backendPid > 0);
    assert.equal(processExists(backendPid), true);
    try {
      await waitForBackendReady(port, 6000);
    } catch (error) {
      throw new Error(`${error.message}\n${launcherDiagnostics}`);
    }

    const launcherClosed = new Promise((resolve) => launcher.once('close', resolve));
    launcher.kill();
    await launcherClosed;

    assert.equal(
      await waitForProcessExit(backendPid, 6000),
      true,
      `backend process ${backendPid} survived its parent`
    );
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
    if (backendPid && processExists(backendPid)) {
      try {
        process.kill(backendPid, 'SIGKILL');
      } catch {
        // It may have exited between the existence check and the signal.
      }
    }
    await fs.rm(dataDirectory, { recursive: true, force: true });
  }
});
