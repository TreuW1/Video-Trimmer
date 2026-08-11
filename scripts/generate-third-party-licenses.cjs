const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const rootDir = path.resolve(__dirname, '..');
const licensesDir = path.join(rootDir, 'licenses');
const nodeLicensePath = path.join(licensesDir, 'NODE_LICENSE.txt');
const nodeVersionPath = path.join(licensesDir, 'NODE_VERSION.txt');
const noticesPath = path.join(rootDir, 'THIRD_PARTY_LICENSES.txt');
const cargoDir = path.join(process.env.USERPROFILE || '', '.cargo');
const licenseNamePattern = /^(?:licen[cs]e|copying|notice)(?:[-_.].*)?$/i;

function normalizeText(value) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim() + '\n';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listLicenseFiles(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseNamePattern.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function readManifestField(manifest, field) {
  const match = manifest.match(new RegExp(`^\\s*${field}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return match ? match[1] : '';
}

function componentKey(component) {
  return `${component.ecosystem}:${component.name}@${component.version}`;
}

function addComponent(components, component) {
  const key = componentKey(component);
  const current = components.get(key);
  if (!current) {
    components.set(key, component);
    return;
  }

  const knownTexts = new Set(current.licenseFiles.map((file) => file.text));
  for (const file of component.licenseFiles) {
    if (!knownTexts.has(file.text)) current.licenseFiles.push(file);
  }
}

function collectNpmPackages(lockFile, label, components) {
  const packageRoot = path.dirname(lockFile);
  const lock = readJson(lockFile);

  for (const location of Object.keys(lock.packages || {}).sort()) {
    if (!location || !location.includes('node_modules')) continue;
    const packageDir = path.resolve(packageRoot, location);
    const manifestPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = readJson(manifestPath);
    const licenseFiles = listLicenseFiles(packageDir).map((filePath) => ({
      name: path.basename(filePath),
      text: normalizeText(fs.readFileSync(filePath, 'utf8'))
    }));

    addComponent(components, {
      ecosystem: `npm (${label})`,
      name: manifest.name || path.basename(packageDir),
      version: manifest.version || lock.packages[location].version || 'unknown',
      license: manifest.license || lock.packages[location].license || 'Not declared',
      source: manifest.repository?.url || manifest.repository || manifest.homepage || '',
      licenseFiles
    });
  }
}

function getCargoPackages() {
  const output = execFileSync('cargo', [
    'tree', '--locked', '--target', 'x86_64-pc-windows-gnu',
    '--prefix', 'none', '--format', '{p}'
  ], {
    cwd: path.join(rootDir, 'src-tauri'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const packages = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([^\s]+) v([^\s]+)(?:\s|$)/);
    if (!match || match[1] === 'VideoTrimmer') continue;
    packages.set(`${match[1]}@${match[2]}`, { name: match[1], version: match[2] });
  }
  return [...packages.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function buildCargoManifestIndex() {
  const index = new Map();
  const registrySrc = path.join(cargoDir, 'registry', 'src');
  if (fs.existsSync(registrySrc)) {
    for (const registry of fs.readdirSync(registrySrc, { withFileTypes: true })) {
      if (!registry.isDirectory()) continue;
      const registryDir = path.join(registrySrc, registry.name);
      for (const crate of fs.readdirSync(registryDir, { withFileTypes: true })) {
        if (!crate.isDirectory()) continue;
        const manifestPath = path.join(registryDir, crate.name, 'Cargo.toml');
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = fs.readFileSync(manifestPath, 'utf8');
        const name = readManifestField(manifest, 'name');
        const version = readManifestField(manifest, 'version');
        if (name && version) index.set(`${name}@${version}`, manifestPath);
      }
    }
  }

  const gitCheckouts = path.join(cargoDir, 'git', 'checkouts');
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'target') continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name === 'Cargo.toml') {
        const manifest = fs.readFileSync(entryPath, 'utf8');
        const name = readManifestField(manifest, 'name');
        const version = readManifestField(manifest, 'version');
        if (name && version) index.set(`${name}@${version}`, entryPath);
      }
    }
  }
  visit(gitCheckouts);
  return index;
}

function collectCargoPackages(components) {
  const manifestIndex = buildCargoManifestIndex();
  for (const pkg of getCargoPackages()) {
    const manifestPath = manifestIndex.get(`${pkg.name}@${pkg.version}`);
    if (!manifestPath) {
      addComponent(components, {
        ecosystem: 'Cargo (Windows runtime)',
        ...pkg,
        license: 'Manifest not found in the local Cargo cache',
        source: '',
        licenseFiles: []
      });
      continue;
    }

    const manifestDir = path.dirname(manifestPath);
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    const licenseFileName = readManifestField(manifest, 'license-file');
    const candidates = listLicenseFiles(manifestDir);
    if (licenseFileName) {
      const declaredFile = path.resolve(manifestDir, licenseFileName);
      if (fs.existsSync(declaredFile) && !candidates.includes(declaredFile)) candidates.push(declaredFile);
    }

    // Workspace crates often keep their shared licenses above the crate directory.
    let parent = path.dirname(manifestDir);
    for (let depth = 0; candidates.length === 0 && depth < 3 && parent.startsWith(cargoDir); depth += 1) {
      candidates.push(...listLicenseFiles(parent));
      parent = path.dirname(parent);
    }

    addComponent(components, {
      ecosystem: 'Cargo (Windows runtime)',
      ...pkg,
      license: readManifestField(manifest, 'license') || 'Not declared',
      source: readManifestField(manifest, 'repository') || readManifestField(manifest, 'homepage'),
      licenseFiles: candidates.map((filePath) => ({
        name: path.basename(filePath),
        text: normalizeText(fs.readFileSync(filePath, 'utf8'))
      }))
    });
  }
}

async function ensureNodeLicense() {
  fs.mkdirSync(licensesDir, { recursive: true });
  const cachedVersion = fs.existsSync(nodeVersionPath)
    ? fs.readFileSync(nodeVersionPath, 'utf8').trim()
    : '';

  if (cachedVersion === process.version && fs.existsSync(nodeLicensePath)) {
    return normalizeText(fs.readFileSync(nodeLicensePath, 'utf8'));
  }

  const url = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the Node.js license (${response.status} ${response.statusText})`);
  const text = normalizeText(await response.text());
  if (!text.includes('Node.js is licensed for use as follows:')) {
    throw new Error('The downloaded Node.js license did not contain the expected heading.');
  }

  fs.writeFileSync(nodeLicensePath, text, 'utf8');
  fs.writeFileSync(nodeVersionPath, `${process.version}\n`, 'utf8');
  return text;
}

function renderNotices(components, nodeLicenseText) {
  const sortedComponents = [...components.values()].sort((a, b) =>
    a.ecosystem.localeCompare(b.ecosystem) ||
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version));

  const textGroups = new Map();
  for (const component of sortedComponents) {
    for (const file of component.licenseFiles) {
      const hash = crypto.createHash('sha256').update(file.text).digest('hex');
      const group = textGroups.get(hash) || { text: file.text, packages: [] };
      group.packages.push(`${component.name}@${component.version} (${component.ecosystem}; ${file.name})`);
      textGroups.set(hash, group);
    }
  }

  const lines = [
    'THIRD-PARTY SOFTWARE NOTICES AND LICENSES',
    '=========================================',
    '',
    'VideoTrimmer includes third-party software. The project MIT License does not',
    'replace the licenses below. Each component remains licensed by its respective',
    'copyright holder under the terms identified here.',
    '',
    `Generated for Node.js ${process.version} and the Windows x86_64 GNU Rust target.`,
    '',
    'COMPONENT INDEX',
    '---------------',
    ''
  ];

  for (const component of sortedComponents) {
    lines.push(`${component.name} ${component.version}`);
    lines.push(`  Ecosystem: ${component.ecosystem}`);
    lines.push(`  Declared license: ${component.license}`);
    if (component.source) lines.push(`  Source: ${component.source}`);
    if (component.licenseFiles.length === 0) {
      lines.push('  Notice: no standalone license file was found in the local package cache.');
    }
    lines.push('');
  }

  lines.push('NODE.JS RUNTIME LICENSE', '-----------------------', '', nodeLicenseText.trim(), '');
  lines.push('PACKAGE LICENSE TEXTS', '---------------------', '');

  for (const group of [...textGroups.values()].sort((a, b) => a.packages[0].localeCompare(b.packages[0]))) {
    lines.push('Applies to:');
    for (const packageName of [...new Set(group.packages)].sort()) lines.push(`  - ${packageName}`);
    lines.push('', group.text.trim(), '', '================================================================', '');
  }

  return `${lines.join('\n').trim()}\n`;
}

async function main() {
  const components = new Map();
  collectNpmPackages(path.join(rootDir, 'package-lock.json'), 'backend/build', components);
  collectNpmPackages(path.join(rootDir, 'video-editor-frontend', 'package-lock.json'), 'frontend', components);
  collectCargoPackages(components);
  const nodeLicenseText = await ensureNodeLicense();
  fs.writeFileSync(noticesPath, renderNotices(components, nodeLicenseText), 'utf8');

  const withoutFiles = [...components.values()].filter((component) => component.licenseFiles.length === 0);
  console.log(`Generated ${path.relative(rootDir, noticesPath)} for ${components.size} components.`);
  if (withoutFiles.length > 0) {
    console.warn(`${withoutFiles.length} components had no standalone license file; review their declared licenses in the notice.`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
