import audit from './support.cjs';
const { repo: auditRepo, scratch: auditScratch, build: auditBuild, dsh: auditDsh, path: auditPath, url: auditUrl } = audit;
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const { runDoctor } = await import(auditUrl.pathToFileURL(auditPath.join(auditRepo,"paseo-plugin/lib/doctor.mjs")).href);

const base = mkdtempSync(auditPath.join(auditScratch,"doctor-extra-"));
const bin = join(base, 'bin'); mkdirSync(bin);
for (const [name, script] of Object.entries({
  dsh: '#!/bin/sh\necho 0.2.1-rc.5\n',
  paseo: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.14.0; else echo "dsh-paseo running"; fi\n',
})) { writeFileSync(join(bin,name), script); chmodSync(join(bin,name),0o755); }
process.env.PATH = bin + ':' + process.env.PATH;
process.env.DSH_PASEO_PROFILE = 'audit';
// Same split as templates/cordis.patch.yml: llm-pi-ai owns providers;
// agent-default-model only selects the provider/model.
const providerBlock = '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      route:\n        displayName: Audit\n        apiKeyEnv: EXAMPLE_KEY\n        api: openai-completions\n        baseURL: https://synthetic.invalid/v1\n        models:\n          - id: example\n            name: example\n            reasoningEfforts: false\n';
const defaultBlock = '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: route\n    model: example\n';
const normal = providerBlock + defaultBlock;
const goodCreds = 'refs:\n  EXAMPLE_KEY: synthetic-only\n';
const cases = [
  ['positive-control',normal,goodCreds],
  ['quoted-empty-route',normal.replace('provider: route','provider: ""').replace('model: example','model: ""'),goodCreds],
  ['route-from-later-block',providerBlock+'- id: agent-default-model\n  config: {}\n- id: unrelated\n  config:\n    provider: route\n    model: example\n',goodCreds],
  ['quoted-empty-credential',normal,'refs:\n  EXAMPLE_KEY: ""\n'],
  ['comment-only-credential',normal,'refs:\n  EXAMPLE_KEY: # no value\n'],
  ['credential-after-refs-block',normal,'refs:\n  ANOTHER_KEY: synthetic-only\nunrelated:\n  EXAMPLE_KEY: synthetic-only\n'],
  ['disabled-route',providerBlock+defaultBlock.replace('  config:','  disabled: true\n  config:'),goodCreds],
];
function walk(dir,prefix='') {return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);}
const files=walk(auditPath.join(auditRepo,"dsh-bridge")).filter(f=>f.endsWith('.js')||f.endsWith('package.json')||f.endsWith('cordis.patch.yml'));
for(const [label,patch,credentials] of cases) {
  const root=join(base,label); const profile=join(root,'profiles','audit'); const bridge=join(profile,'node_modules','dsh-paseo-bridge');
  for (const file of files) {mkdirSync(dirname(join(bridge,file)),{recursive:true});writeFileSync(join(bridge,file),'');}
  writeFileSync(join(profile,'cordis.patch.yml'),patch);writeFileSync(join(root,'.credentials.yaml'),credentials);
  process.env.DSH_HOME=root;process.exitCode=0;
  let output='';const old=process.stdout.write;
  process.stdout.write=(chunk)=>{output+=chunk;return true;};
  try {runDoctor();} finally {process.stdout.write=old;}
  output=output.replace(/\u001b\[[0-9;]*m/g,'');
  console.log(JSON.stringify({label,exitCode:process.exitCode??0,allPassed:output.includes('All checks passed'),verdicts:output.split('\n').filter(x=>x.includes('route')||x.includes('credential')||x.includes('blocking'))}));
}
process.exitCode=0;
