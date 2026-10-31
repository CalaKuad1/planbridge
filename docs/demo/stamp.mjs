// timestamps every stdout chunk of a child command
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const t0 = performance.now(); const chunks = [];
const p = spawn(process.execPath, [process.argv[2]], { env: process.env });
p.stdout.on('data', (d) => chunks.push({ t: Math.round(performance.now() - t0), d: String(d) }));
p.on('close', () => { fs.writeFileSync('recording.json', JSON.stringify(chunks, null, 1)); console.log(chunks.map((c) => c.d).join('')); console.log('\nfirst output ms:', chunks[0]?.t, 'end:', chunks.at(-1)?.t, 'chunks:', chunks.length); });
