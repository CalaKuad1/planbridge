// Isolated data dir so tests never touch ~/.planbridge
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.PLANBRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'planbridge-test-'));
