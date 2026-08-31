const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'src-tauri', 'backend-dist');
const sourceNodeModules = path.join(rootDir, 'node_modules');
const targetNodeModules = path.join(distDir, 'node_modules');

const entryDependencies = [
  'compression',
  'cors',
  'express',
  'multer'
];

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (src) => {
      const name = path.basename(src);
      return name !== '.bin' && name !== '.cache';
    }
  });
}

function packageDir(packageName) {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    return path.join(sourceNodeModules, scope, name);
  }
  return path.join(sourceNodeModules, packageName);
}

function targetPackageDir(packageName) {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    return path.join(targetNodeModules, scope, name);
  }
  return path.join(targetNodeModules, packageName);
}

function readPackageJson(packageName) {
  const manifestPath = path.join(packageDir(packageName), 'package.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function collectDependencies(packageName, seen = new Set()) {
  if (seen.has(packageName)) return seen;

  const source = packageDir(packageName);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing dependency "${packageName}" in ${sourceNodeModules}. Run npm install first.`);
  }

  seen.add(packageName);
  const manifest = readPackageJson(packageName);
  const dependencies = {
    ...(manifest.dependencies || {}),
    ...(manifest.optionalDependencies || {})
  };

  for (const dependencyName of Object.keys(dependencies)) {
    collectDependencies(dependencyName, seen);
  }

  return seen;
}

removeDir(distDir);
fs.mkdirSync(targetNodeModules, { recursive: true });
fs.copyFileSync(path.join(rootDir, 'server.cjs'), path.join(distDir, 'server.cjs'));
fs.copyFileSync(path.join(rootDir, 'time-ranges.cjs'), path.join(distDir, 'time-ranges.cjs'));
fs.copyFileSync(path.join(rootDir, 'update-check.cjs'), path.join(distDir, 'update-check.cjs'));
fs.copyFileSync(path.join(rootDir, 'VERSION'), path.join(distDir, 'VERSION'));
fs.copyFileSync(path.join(rootDir, 'upload-limits.json'), path.join(distDir, 'upload-limits.json'));
fs.copyFileSync(path.join(rootDir, 'compression-presets.json'), path.join(distDir, 'compression-presets.json'));

if (process.platform === 'win32') {
  fs.copyFileSync(process.execPath, path.join(distDir, 'node-runtime'));
} else {
  fs.copyFileSync(process.execPath, path.join(distDir, 'node-runtime'));
}

const packages = new Set();
for (const dependencyName of entryDependencies) {
  collectDependencies(dependencyName, packages);
}

for (const packageName of packages) {
  const source = packageDir(packageName);
  const target = targetPackageDir(packageName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  copyDir(source, target);
}

console.log(`Bundled backend with Node and ${packages.size} packages at ${path.relative(rootDir, distDir)}`);
