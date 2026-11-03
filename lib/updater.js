'use strict';

// Self-update for a git checkout of FreeDeepseekAPI.
//
// Two channels are branches on origin: `latest` gets every release, `stable` gets a
// release once the maintainer has promoted it. An update only ever fast-forwards:
// local edits, a channel branch with its own commits, or a copy without .git block the
// install and the caller gets the command to run by hand instead. Nothing is reset.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CHANNELS = ['stable', 'latest'];
// Exit code that asks scripts/start.js to start the server again (EX_TEMPFAIL).
const RESTART_EXIT_CODE = 75;
const GIT_TIMEOUT_MS = 60000;
const MAX_CHANGES = 30;

function updateError(status, type, message) {
    return Object.assign(new Error(message), { status, type });
}

function runGit(root) {
    return (args) => new Promise((resolve, reject) => {
        execFile('git', args, { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                const detail = String(stderr || err.message || '').trim();
                return reject(Object.assign(new Error(`git ${args.join(' ')} failed: ${detail}`), { code: err.code }));
            }
            resolve(String(stdout));
        });
    });
}

function readVersion(root) {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null; } catch (e) { return null; }
}

function manualCommand(channel) {
    return `git fetch origin && git switch ${channel} && git merge --ff-only origin/${channel}`;
}

function createUpdater({ root, exec = runGit(root), env = process.env } = {}) {
    const git = (...args) => exec(args);
    const ok = async (...args) => { try { await git(...args); return true; } catch (e) { return false; } };
    const restart = env.FDSA_LAUNCHER === '1' ? 'auto' : 'manual';
    const isCheckout = () => fs.existsSync(path.join(root, '.git'));

    // Which repository this checkout actually follows. The dashboard shows it, so an
    // update never installs code from a fork the operator has forgotten about.
    async function repoSlug() {
        try {
            const url = (await git('remote', 'get-url', 'origin')).trim();
            const match = url.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/);
            return match ? match[1] : null;
        } catch (e) { return null; }
    }

    // Branches that exist on origin. A repo with only `main` is the normal case for a
    // personal fork, and the channel list is built from this rather than from a constant.
    async function remoteHeads() {
        try {
            const out = await git('ls-remote', '--heads', 'origin');
            return out.split('\n').filter(Boolean)
                .map((line) => (line.split('\t')[1] || '').replace('refs/heads/', ''))
                .filter(Boolean);
        } catch (e) { return []; }
    }

    async function defaultBranch() {
        try {
            const out = await git('ls-remote', '--symref', 'origin', 'HEAD');
            const match = out.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
            if (match) return match[1];
        } catch (e) { /* older git, or the network is down */ }
        const heads = await remoteHeads();
        for (const name of ['main', 'master', ...CHANNELS]) if (heads.includes(name)) return name;
        return 'main';
    }

    // Turn whatever channel the caller asked for into one origin actually publishes. A
    // renamed repository, a fork with no release branches, or a checkout on a feature
    // branch all update from the branch that exists instead of failing on a constant.
    async function resolveChannel(requested) {
        const heads = await remoteHeads();
        if (!requested) return { channel: await defaultBranch(), requested: null, fellBack: false, heads };
        if (!heads.length || heads.includes(requested)) {
            return { channel: String(requested).trim(), requested, fellBack: false, heads };
        }
        const fallback = await defaultBranch();
        return { channel: fallback, requested, fellBack: fallback !== requested, heads };
    }

    async function status() {
        const version = readVersion(root);
        if (!isCheckout()) {
            return { version, commit: null, branch: null, channel: null, method: 'unavailable', reason: 'not_a_git_checkout', restart };
        }
        const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
        const commit = (await git('rev-parse', 'HEAD')).trim().slice(0, 7);
        const heads = await remoteHeads();
        const resolved = await resolveChannel(null);
        return {
            version, commit, branch,
            // Any branch origin publishes is a channel: a personal repo that only has
            // `main` must still be updatable from the dashboard.
            channel: (heads.includes(branch) || CHANNELS.includes(branch)) ? branch : null,
            default_channel: resolved.channel,
            branches: heads,
            repo: await repoSlug(),
            method: 'git', reason: null, restart,
        };
    }

    async function check(requested) {
        // No channel means "whatever this repo publishes". A named one only has to be a
        // safe branch name: whether it exists on origin is a question for origin, and a
        // missing one falls back to the default branch instead of blocking the update.
        const name = requested == null ? '' : String(requested).trim();
        const safe = /^[A-Za-z0-9._/-]{1,120}$/.test(name)
            && !name.startsWith('-') && !name.startsWith('/') && !name.endsWith('/')
            && !name.includes('..');
        if (name && !safe) {
            throw updateError(400, 'invalid_channel', `Unknown update channel ${JSON.stringify(requested)}. Use a branch name such as ${CHANNELS.join(' or ')}.`);
        }
        const resolved = await resolveChannel(name || null);
        const channel = resolved.channel;
        const current = await status();
        if (current.method !== 'git') {
            throw updateError(409, 'update_unavailable', 'This copy was not installed with git clone (a container image or a downloaded archive), so it cannot update itself. Pull a new image or download the new release.');
        }
        const remote = `origin/${channel}`;
        try {
            await git('fetch', '--quiet', 'origin', `+refs/heads/${channel}:refs/remotes/origin/${channel}`);
        } catch (e) {
            if (/couldn't find remote ref/i.test(e.message)) {
                throw updateError(404, 'channel_missing', `The ${channel} channel is not published on GitHub yet, so there is nothing to update to.`);
            }
            throw updateError(502, 'fetch_failed', `Could not reach GitHub to check for updates: ${e.message}`);
        }
        const remoteCommit = (await git('rev-parse', remote)).trim();
        const headCommit = (await git('rev-parse', 'HEAD')).trim();
        let remoteVersion = null;
        try { remoteVersion = JSON.parse(await git('show', `${remote}:package.json`)).version || null; } catch (e) { remoteVersion = null; }
        const changes = (await git('log', '--format=%h%x09%s', `--max-count=${MAX_CHANGES}`, `HEAD..${remote}`))
            .split('\n').filter(Boolean).map((line) => {
                const tab = line.indexOf('\t');
                return { commit: line.slice(0, tab), subject: line.slice(tab + 1) };
            });
        // Up to date: already on this channel and nothing on it that HEAD lacks.
        const upToDate = current.channel === channel && await ok('merge-base', '--is-ancestor', remote, 'HEAD');

        let blockedReason = null;
        if ((await git('status', '--porcelain', '--untracked-files=no')).trim()) blockedReason = 'local_changes';
        else if (await ok('rev-parse', '--verify', '--quiet', `refs/heads/${channel}`)
            && !await ok('merge-base', '--is-ancestor', `refs/heads/${channel}`, remote)) blockedReason = 'diverged';

        return {
            channel,
            // What was asked for, and whether origin had it. A dashboard that silently
            // updates from `main` when `stable` was chosen would be lying about the source.
            channel_requested: resolved.requested,
            fell_back: resolved.fellBack,
            branches: resolved.heads,
            repo: await repoSlug(),
            default_channel: await defaultBranch(),
            // Same code, another branch (main, a feature branch): installing only moves this copy onto the channel.
            switchOnly: !upToDate && remoteCommit === headCommit,
            current: { version: current.version, commit: current.commit, channel: current.channel },
            available: { version: remoteVersion, commit: remoteCommit.slice(0, 7) },
            upToDate,
            changes,
            canInstall: !upToDate && !blockedReason,
            blockedReason: upToDate ? null : blockedReason,
            manualCommand: manualCommand(channel),
            restart,
        };
    }

    async function install(channel) {
        const result = await check(channel);
        channel = result.channel;
        if (result.upToDate) throw updateError(409, 'up_to_date', `Already on the newest ${channel} release.`);
        if (result.blockedReason === 'local_changes') {
            throw updateError(409, 'local_changes', `This copy has uncommitted changes to tracked files, so the update would overwrite them. Commit or stash them, or update by hand: ${result.manualCommand}`);
        }
        if (result.blockedReason === 'diverged') {
            throw updateError(409, 'diverged', `The local ${channel} branch has commits that are not on origin/${channel}, so it cannot be fast-forwarded. Update by hand after deciding what to keep.`);
        }
        if (await ok('rev-parse', '--verify', '--quiet', `refs/heads/${channel}`)) {
            await git('switch', channel);
            await git('merge', '--ff-only', `origin/${channel}`);
        } else {
            await git('switch', '-c', channel, '--track', `origin/${channel}`);
        }
        return { installed: { version: result.available.version || readVersion(root), commit: result.available.commit, channel }, switched: result.switchOnly, restart };
    }

    return { status, check, install };
}

module.exports = { createUpdater, CHANNELS, RESTART_EXIT_CODE, manualCommand };
