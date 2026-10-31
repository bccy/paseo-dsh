// Audit evidence support only. The runner supplies a frozen private checkout.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const url = require('node:url');

if (!process.env.PASEO_AUDIT_REPO || !process.env.PASEO_AUDIT_BUILD || !process.env.PASEO_AUDIT_SCRATCH) {
  throw new Error('Prepare the isolated audit environment with reproductions/run.py first.');
}

const scratch = process.env.PASEO_AUDIT_SCRATCH;
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
module.exports = {
  repo: process.env.PASEO_AUDIT_REPO,
  build: process.env.PASEO_AUDIT_BUILD,
  scratch,
  dsh: process.env.DSH_INSTALL_DIR || path.join(os.homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh'),
  path,
  url,
};
