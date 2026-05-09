const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src', 'main', 'services', 'remoteShare', 'web');
const destDir = path.join(__dirname, '..', 'out', 'main', 'web');

if (!fs.existsSync(srcDir)) {
  console.log('[copy-web-assets] Source directory not found, skipping:', srcDir);
  process.exit(0);
}

// Create dest directory
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

// Copy all files from src to dest
for (const file of fs.readdirSync(srcDir)) {
  const srcFile = path.join(srcDir, file);
  const destFile = path.join(destDir, file);
  if (fs.statSync(srcFile).isFile()) {
    fs.copyFileSync(srcFile, destFile);
    console.log(`[copy-web-assets] Copied: ${file}`);
  }
}

console.log('[copy-web-assets] Done');
