#!/usr/bin/env node
/**
 * setup-tools.js — expose the reverse-engineering and security CLIs on this machine
 * as slash commands in the agent harnesses that support them.
 *
 *   npm run setup:tools                # write commands for the tools that are installed
 *   npm run setup:tools -- --all       # write every entry, marking the missing ones
 *   npm run setup:tools -- --dry-run   # show what would be written
 *   npm run setup:tools -- --json      # machine readable status
 *   npm run setup:tools -- --only rea,jadx
 *
 * The command bodies are short: they name the tool, the exact invocation and the
 * rule for reading its output. Nothing heavy is copied into a prompt — the harness
 * loads one command when it is used, which is the point.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OPENCODE_HOME = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
const OPENCODE_DIR = path.join(OPENCODE_HOME, 'command');
const OPENCODE_SKILLS = path.join(OPENCODE_HOME, 'skills');
const CODEX_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'prompts');
const IDA_DIRS = [path.join(os.homedir(), 'ida'), '/opt/ida', '/opt/idapro'];

/**
 * Every entry: how to find it, how to run it, and the one sentence that says when.
 * `bin` is checked with `command -v`; `paths` are checked as files.
 */
const TOOLS = [
  {
    id: 'rea',
    label: 'REA — reverse engineer anything',
    bin: 'rea',
    when: 'a shipped binary, Electron/JS app, APK, firmware image or runtime capture has to be explained rather than guessed at',
    usage: `Run REA against the target: \`rea "$ARGUMENTS"\`. If a target is already open in an MCP session, use the rea tools directly (open_binary, analyze_function, procedure_pseudo_code, search_strings) instead of starting a second session. Report what the evidence supports and name what stayed unknown.`,
  },
  {
    id: 'jadx',
    label: 'jadx — Android decompiler',
    bin: 'jadx',
    when: 'an APK or DEX has to become readable Java',
    install: 'download the release zip from github.com/skylot/jadx and put its bin/ on PATH',
    usage: `Decompile with \`jadx -d /tmp/jadx-out "$ARGUMENTS"\`, then read the manifest first (\`AndroidManifest.xml\`), then the entry activity, then anything that handles network, crypto or storage.`,
  },
  {
    id: 'apktool',
    label: 'apktool — unpack/repack APK',
    bin: 'apktool',
    when: 'resources, smali or a modified APK is needed rather than Java source',
    install: 'grab apktool.jar from bitbucket.org/iBotPeaches/apktool plus an apktool wrapper script on PATH',
    usage: `\`apktool d -f "$ARGUMENTS" -o /tmp/apktool-out\` to decode, \`apktool b\` to rebuild. Keep the original APK untouched.`,
  },
  {
    id: 'ghidra',
    label: 'ghidra — headless decompiler',
    bin: 'analyzeHeadless',
    paths: ['/opt/ghidra/support/analyzeHeadless', path.join(os.homedir(), 'ghidra/support/analyzeHeadless')],
    when: 'a native binary needs decompilation without opening a GUI',
    install: 'download Ghidra from ghidra-sre.org and point at its support/analyzeHeadless',
    usage: `\`analyzeHeadless /tmp/ghproj proj -import "$ARGUMENTS" -postScript DecompileAll.java\` (Ghidra also ships a decompile script set). Report function names, call edges and the strings that anchor them.`,
  },
  {
    id: 'rizin',
    label: 'rizin / radare2 — binary analysis',
    bin: 'rizin',
    when: 'headers, sections, imports, symbols or a quick disassembly are enough',
    install: 'pip install rizin (or its distro package), which also provides radare2-compatible rz-* tools',
    usage: `\`rizin -q -c 'iI; ii; iz~flag; afl' "$ARGUMENTS"\`. Start from metadata, then the strings that matter, then the functions that reference them.`,
  },
  {
    id: 'ida',
    label: 'IDA Pro',
    bin: 'ida64',
    paths: IDA_DIRS.map((dir) => path.join(dir, 'ida64')),
    when: 'the licensed IDA install is the right tool for a native target',
    install: 'install Hex-Rays IDA Pro and add its directory to PATH — it is commercial, the command goes live once ida64 resolves',
    usage: `Open \`ida64 "$ARGUMENTS"\`, or drive it headless with \`ida64 -A -S"decompile_all.py" "$ARGUMENTS"\`. Note the database path; do not modify the input binary.`,
  },
  {
    id: 'frida',
    label: 'frida — dynamic instrumentation',
    bin: 'frida',
    when: 'runtime behaviour has to be observed: arguments, returns, decrypted buffers, bypassed checks',
    install: 'pip install frida-tools',
    usage: `\`frida -U -f "$ARGUMENTS" -l hook.js --no-pause\` on a device, \`frida -p <pid> -l hook.js\` on a local process. One hook per question, and say what the trace proves.`,
  },
  {
    id: 'gdb',
    label: 'gdb — native debugging',
    bin: 'gdb',
    when: 'a crash, a hang or a control-flow question needs a real debugger',
    usage: `\`gdb -q "$ARGUMENTS"\` then \`run\`, \`bt\`, \`info registers\`, \`x/16gx $rsp\`. Batch mode for a script: \`gdb -batch -ex run -ex bt ./binary\`.`,
  },
  {
    id: 'tshark',
    label: 'tshark — packet capture analysis',
    bin: 'tshark',
    when: 'a pcap has to answer what was sent, to where, and in what order',
    install: 'install the wireshark-cli / tshark package',
    usage: `\`tshark -r "$ARGUMENTS" -Y '<display filter>' -T fields -e frame.number -e ip.src -e ip.dst -e _ws.col.Protocol\`. State the filter you used; absence in a filtered view is not absence in the capture.`,
  },
  {
    id: 'nmap',
    label: 'nmap — service discovery',
    bin: 'nmap',
    when: 'a host or subnet in scope needs its open ports and versions',
    usage: `\`nmap -sV -Pn --top-ports 1000 "$ARGUMENTS"\`, then a targeted \`-p<ports> -sC\` on what answered. Only against a target you are authorised to scan.`,
  },
  {
    id: 'binwalk',
    label: 'binwalk — firmware signatures',
    bin: 'binwalk',
    when: 'an image may contain filesystems, kernels or compressed sections',
    install: 'pip install binwalk',
    usage: `\`binwalk "$ARGUMENTS"\` first for offsets, then \`binwalk -eM\` to extract. Decompressed offsets are not original-file addresses.`,
  },
  {
    id: 'unblob',
    label: 'unblob — firmware extraction',
    bin: 'unblob',
    when: 'nested or vendor formats need reliable extraction',
    install: 'pip install unblob',
    usage: `\`unblob -e /tmp/unblob "$ARGUMENTS"\`. It reports unextracted ranges; read them instead of assuming full coverage.`,
  },
  {
    id: 'stool',
    label: 'stool — OSINT / CSINT workspace',
    bin: 'stool',
    when: 'a person, handle, phone, address or document has to become a dossier, a timeline or a set of pivots',
    usage: [
      'Drive stool directly: `stool $ARGUMENTS`.',
      '',
      '| Verb | Use it for |',
      '|---|---|',
      '| `stool hunt <target>` | detect the target kind, confirm, run the chain |',
      '| `stool profile <target>` / `brief <target>` | build or refresh the dossier, or print one screen of it |',
      '| `stool note <target> <doc>` | notes out of any pdf/docx/odt/epub, then search every value in them |',
      '| `stool notescan --search` | read your notes, find the targets, search with them |',
      '| `stool entity candidates <t>` | who else looks like this target, scored |',
      '| `stool graph <target>` | identifier graph — `--dot` / `--mermaid` / `path <a> <b>` |',
      '| `stool pivot <target>` | rare identifiers plus the command that chases each |',
      '| `stool shared` / `stale` | values on more than one target; targets going cold |',
      '| `stool track <kind> <target>` | chain a whole track into one markdown file |',
      '| `stool bulk <tool> <file>` | one tool over a targets file |',
      '| `stool ask "question"` | free-router answer in the operator\'s voice |',
      '| `stool doctor` / `--selftest` / `--list` | health, self-test, the full verb list |',
      '',
      'Run `stool --list` before inventing a verb. Report the command, the artifact it wrote under `reports/`, and what the data did not support.',
    ].join('\n'),
  },
  {
    id: 'yara',
    label: 'yara — signature matching',
    bin: 'yara',
    when: 'a set of files has to be classified against one rule or a rule pack',
    install: 'pip install yara-python (provides yara)',
    usage: `\`yara -r rules.yar "$ARGUMENTS"\`. Write the rule from the evidence (strings, offsets, structure), not from the family name.`,
  },
];

/**
 * Bundled plugins are different from single CLIs: they ship a skill plus scripts.
 * Their root is resolved here so the harness gets a real path instead of
 * `${CLAUDE_PLUGIN_ROOT}`, which only the tool it came from understands.
 */
const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGINS = [
  {
    id: 'pentest',
    root: path.join(REPO_ROOT, 'plugins', 'hackingtool', 'plugins', 'hackingtool'),
    when: 'a target needs recon, scanning, enumeration, fuzzing, secret hunting or username/email OSINT and a real tool should do it instead of a curl loop',
    entry: 'plugin.json',
  },
];

function pluginStatus(plugin) {
  const scripts = path.join(plugin.root, 'scripts');
  const missing = ['ht_preflight.py', 'ht_run.py', 'ht_search.py'].filter((f) => !fs.existsSync(path.join(scripts, f)));
  return { root: plugin.root, present: fs.existsSync(plugin.root) && missing.length === 0, missing };
}

function renderPluginCommand(plugin) {
  const skill = path.join(plugin.root, 'skills', plugin.id, 'SKILL.md');
  return `---\ndescription: Pentest / OSINT — 183+ tools (nmap, nuclei, subfinder, httpx, ffuf, sqlmap, sherlock, holehe, trufflehog) behind one wrapper\nargument-hint: <target or task>\n---\n\nRead \`${skill}\` and follow it. Its scripts live in \`${path.join(plugin.root, 'scripts')}\`; the \`${'${CLAUDE_PLUGIN_ROOT}'}\` placeholders there mean \`${plugin.root}\`.\n\nStart with \`python3 ${path.join(plugin.root, 'scripts', 'ht_preflight.py')}\` and act on its verdict — if it says \`blocked\`, say what is missing instead of substituting a weaker probe.\n\nThen run the request: $ARGUMENTS\n`;
}

function renderPluginSkill(plugin, resolved) {
  const skillFile = path.join(plugin.root, 'skills', plugin.id, 'SKILL.md');
  let body;
  try {
    body = fs.readFileSync(skillFile, 'utf8').replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.root);
  } catch (_) {
    return null;
  }
  return body;
}

function which(bin) {
  try {
    return execFileSync('sh', ['-c', `command -v ${JSON.stringify(bin)}`], { encoding: 'utf8', timeout: 4000 }).trim();
  } catch (_) {
    return '';
  }
}

function locate(tool) {
  const found = tool.bin ? which(tool.bin) : '';
  if (found) return found;
  for (const candidate of tool.paths || []) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) { /* not there */ }
  }
  return '';
}

function render(tool, { harness, resolved }) {
  const body = [
    tool.usage,
    '',
    resolved
      ? `Installed at: \`${resolved}\``
      : `Not installed. To enable this command: ${tool.install || `put \`${tool.bin}\` on PATH`}. Until then it stays inert.`,
    '',
    resolved
      ? 'Report the command you ran, the output that decided the answer, and what stayed unknown.'
      : 'Do not pretend to have run it.',
  ].join('\n');
  const description = tool.when.length > 120 ? `${tool.when.slice(0, 117)}...` : tool.when;
  // Both harnesses read YAML frontmatter with a description and pass the rest as the
  // prompt; OpenCode substitutes $ARGUMENTS, Codex substitutes $ARGUMENTS too.
  return `---\ndescription: ${tool.label} — ${description}\n${harness === 'codex' ? 'argument-hint: <target>\n' : ''}---\n\n${body}\n`;
}

function plan({ all = false, only = [] } = {}) {
  const wanted = only.length ? TOOLS.filter((t) => only.includes(t.id)) : TOOLS;
  return wanted.map((tool) => {
    const resolved = locate(tool);
    return { ...tool, resolved, available: Boolean(resolved), write: Boolean(resolved) || all };
  });
}

/**
 * A skill entry is the awareness half: one line of description the harness can see,
 * so the model knows the tool exists and when to reach for it. The invocation itself
 * stays in the palette entry, which is only loaded when the command is actually used.
 */
function renderSkill(tool, resolved) {
  return `---\nname: ${tool.id}\ndescription: ${tool.label} available at ${resolved}. Use when ${tool.when}. Run \`/${tool.id}\` for the exact invocation.\n---\n\n# ${tool.label}\n\nInstalled at \`${resolved}\`.\n\nUse it when ${tool.when}.\n\nThe palette entry \`/${tool.id}\` carries the invocation and the reporting rule; this skill exists so the tool is discoverable without loading that text into every turn.\n`;
}

function writeCommands(entries, { dryRun = false, skills = false, opencodeDir = OPENCODE_DIR, codexDir = CODEX_DIR, skillsDir = OPENCODE_SKILLS } = {}) {
  const written = [];
  for (const dir of [opencodeDir, codexDir]) {
    const harness = dir === codexDir ? 'codex' : 'opencode';
    if (!dryRun) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      if (!entry.write) continue;
      const file = path.join(dir, `${entry.id}.md`);
      if (!dryRun) fs.writeFileSync(file, render(entry, { harness, resolved: entry.resolved }), { mode: 0o600 });
      written.push({ harness, file, id: entry.id, available: entry.available });
    }
  }
  if (skills) {
    for (const entry of entries) {
      if (!entry.available) continue;
      const dir = path.join(skillsDir, `tool-${entry.id}`);
      const file = path.join(dir, 'SKILL.md');
      if (!dryRun) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, renderSkill(entry, entry.resolved), { mode: 0o600 });
      }
      written.push({ harness: 'opencode-skill', file, id: `tool-${entry.id}`, available: true });
    }
  }
  return written;
}

function writePlugins({ dryRun = false, skills = true, opencodeDir = OPENCODE_DIR, codexDir = CODEX_DIR, skillsDir = OPENCODE_SKILLS } = {}) {
  const written = [];
  for (const plugin of PLUGINS) {
    const status = pluginStatus(plugin);
    if (!status.present) continue;
    for (const dir of [opencodeDir, codexDir]) {
      if (!dryRun) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${plugin.id}.md`);
      if (!dryRun) fs.writeFileSync(file, renderPluginCommand(plugin), { mode: 0o600 });
      written.push({ harness: dir === codexDir ? 'codex' : 'opencode', file, id: plugin.id, available: true });
    }
    if (skills) {
      const body = renderPluginSkill(plugin);
      if (body) {
        const dir = path.join(skillsDir, plugin.id);
        const file = path.join(dir, 'SKILL.md');
        if (!dryRun) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(file, body, { mode: 0o600 });
        }
        written.push({ harness: 'opencode-skill', file, id: plugin.id, available: true });
      }
    }
  }
  return written;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: setup-tools.js [--all] [--only id,id] [--dry-run] [--json]');
    console.log(`tools:   ${TOOLS.map((t) => t.id).join(', ')}`);
    console.log(`plugins: ${PLUGINS.map((p) => p.id).join(', ')}`);
    console.log('--no-skills skips the opencode skill entries; --all writes stubs for missing tools.');
    return 0;
  }
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 && argv[onlyAt + 1] ? argv[onlyAt + 1].split(',').map((v) => v.trim()).filter(Boolean) : [];
  const dryRun = argv.includes('--dry-run');
  const withSkills = !argv.includes('--no-skills');
  const entries = plan({ all: argv.includes('--all'), only });
  const written = writeCommands(entries, { dryRun, skills: withSkills });
  const plugins = PLUGINS.map((p) => ({ id: p.id, ...pluginStatus(p) }));
  const pluginFiles = plugins.some((p) => p.present) ? writePlugins({ dryRun, skills: withSkills }) : [];
  const all = [...written, ...pluginFiles];

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ opencode: OPENCODE_DIR, opencode_skills: OPENCODE_SKILLS, codex: CODEX_DIR, tools: entries, plugins, written: all }, null, 2));
    return 0;
  }
  for (const entry of entries) {
    const state = entry.available ? 'ready' : (entry.write ? 'stub ' : 'skip ');
    const note = entry.available ? entry.resolved : `missing ${entry.bin}${entry.install ? ` — ${entry.install}` : ''}`;
    console.log(`${state} /${entry.id.padEnd(8)} ${note}`);
  }
  for (const plugin of plugins) {
    console.log(`${plugin.present ? 'ready' : 'skip '} /${plugin.id.padEnd(8)} ${plugin.present ? plugin.root : 'plugin not vendored'}`);
  }
  const ready = entries.filter((e) => e.available).length;
  console.log(`\n${ready}/${entries.length} tools · ${plugins.filter((p) => p.present).length}/${plugins.length} plugins · ${all.length} file(s) ${dryRun ? 'planned' : 'written'}`);
  console.log(`opencode ${OPENCODE_DIR}`);
  console.log(`codex    ${CODEX_DIR}`);
  if (ready < entries.length) console.log('install the missing ones, then re-run; --all writes stubs for them now.');
  return 0;
}

module.exports = { TOOLS, PLUGINS, plan, render, renderSkill, renderPluginCommand, pluginStatus, writeCommands, writePlugins, OPENCODE_DIR, OPENCODE_SKILLS, CODEX_DIR };

if (require.main === module) process.exit(main());
