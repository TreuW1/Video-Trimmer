import { readFileSync, writeFileSync } from 'fs';

const version = process.argv[2] || readFileSync('VERSION', 'utf-8').trim();

console.log(`Updating version to ${version}...`);

// Update root package.json (if it has a version field)
try {
  const rootPkg = JSON.parse(readFileSync('package.json', 'utf-8'));
  if (rootPkg.version !== undefined) {
    rootPkg.version = version;
    writeFileSync('package.json', JSON.stringify(rootPkg, null, 2) + '\n');
    console.log('✓ Updated root package.json');
  }
} catch (e) {
  console.log('⚠ Root package.json has no version field');
}

// Update frontend package.json
const frontendPkg = JSON.parse(readFileSync('video-editor-frontend/package.json', 'utf-8'));
frontendPkg.version = version;
writeFileSync('video-editor-frontend/package.json', JSON.stringify(frontendPkg, null, 2) + '\n');
console.log('✓ Updated video-editor-frontend/package.json');

// Update tauri.conf.json
const tauriConf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf-8'));
tauriConf.version = version;
writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(tauriConf, null, 2) + '\n');
console.log('✓ Updated src-tauri/tauri.conf.json');

// Update Cargo.toml
const cargoToml = readFileSync('src-tauri/Cargo.toml', 'utf-8');
const updatedCargoToml = cargoToml.replace(/^version = ".*"$/m, `version = "${version}"`);
writeFileSync('src-tauri/Cargo.toml', updatedCargoToml);
console.log('✓ Updated src-tauri/Cargo.toml');

// Update VERSION file
writeFileSync('VERSION', version + '\n');
console.log('✓ Updated VERSION file');

console.log(`\n✅ All version numbers updated to ${version}`);

