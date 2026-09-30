// Swaps package.json between the Full and Basic dependency sets.
//   node scripts/use-package.js basic   -> express, express-rate-limit, node-fetch only
//   node scripts/use-package.js full    -> everything (music videos, moderation)
// Then run `npm install` (a Basic install has no ytdl / ffmpeg / TensorFlow / nsfwjs).
// The first run saves the current file as package.full.json so nothing is lost.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const target = process.argv[2];
if (!['basic', 'full'].includes(target)) { console.error('Usage: node scripts/use-package.js basic|full'); process.exit(1); }
const cur = path.join(root, 'package.json'), full = path.join(root, 'package.full.json'), basic = path.join(root, 'package.basic.json');
if (!fs.existsSync(full)) {
    const c = JSON.parse(fs.readFileSync(cur, 'utf8'));
    if (c.dependencies && c.dependencies.nsfwjs) fs.copyFileSync(cur, full);
}
const src = target === 'basic' ? basic : full;
if (!fs.existsSync(src)) { console.error('Missing ' + path.basename(src)); process.exit(1); }
const out = JSON.parse(fs.readFileSync(src, 'utf8'));
out.scripts = Object.assign({}, out.scripts, {
    'use-basic-package': 'node scripts/use-package.js basic',
    'use-full-package': 'node scripts/use-package.js full'
});
fs.writeFileSync(cur, JSON.stringify(out, null, 2) + '\n');
console.log('package.json is now the ' + target.toUpperCase() + ' set. Run "npm install" next.');
