// Stand-in for ffmpeg so the turned-copy plumbing can be tested on a machine without it.
// "-version" succeeds; otherwise the output file receives the arguments it was called
// with as JSON, which lets a test check that the right turn was requested.
const fs = require('fs');
const args = process.argv.slice(2);
if (args.indexOf('-version') !== -1) { console.log('ffmpeg version fake'); process.exit(0); }
if (process.env.FAKE_FFMPEG_FAIL) { console.error('fake ffmpeg: asked to fail'); process.exit(1); }
const input = args[args.indexOf('-i') + 1];
const output = args[args.length - 1];
if (!fs.existsSync(input)) { console.error('fake ffmpeg: no such input ' + input); process.exit(1); }
fs.writeFileSync(output, JSON.stringify(args));
