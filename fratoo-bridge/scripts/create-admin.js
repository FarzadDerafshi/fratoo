#!/usr/bin/env node
/**
 * Interactive admin setup: prompts for a username/password, hashes the
 * password with bcrypt, and writes ADMIN_USERNAME + ADMIN_PASSWORD_HASH
 * (and a fresh JWT_SECRET, if one isn't already set) directly into the
 * right .env file -- no manual hash-password.js + hand-editing required.
 *
 * This is still a SINGLE-admin dashboard by design (see
 * ProjectDocs/DECISIONS.md) -- this script makes setting up that one
 * account easier, it doesn't add multi-user support.
 *
 * Usage: npm run create-admin
 *
 * Auto-detects which .env to write to:
 *   - ../.env (repo root)  -- if running the stack via `docker compose up`
 *   - ./.env (fratoo-bridge/.env) -- if running the bridge directly
 * Pass an explicit path to override: npm run create-admin -- /path/to/.env
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function resolveEnvPath() {
  const argPath = process.argv[2];
  if (argPath) return path.resolve(argPath);

  const rootEnv = path.resolve(__dirname, '..', '..', '.env');
  if (fs.existsSync(rootEnv)) return rootEnv;

  return path.resolve(__dirname, '..', '.env'); // may not exist yet -- fine, we create it
}

/**
 * A minimal line prompter built directly on stdin instead of `readline`.
 *
 * `readline.question()` registers a ONE-SHOT 'line' listener per call. If
 * several lines arrive in the same chunk -- always true for piped/batch
 * input, and just as possible with a real terminal if someone pastes
 * username+password+confirmation together from a password manager -- every
 * line after the first fires before the awaited call that would consume it
 * has even resumed (that only happens on the next microtask), so it's
 * silently dropped and the next `await question()` hangs forever. Caught
 * via a piped non-interactive test of this exact script.
 *
 * Fix: a persistent 'data' listener parses characters into lines itself and
 * pushes every completed line into a queue; `prompt()` drains the queue
 * first and only registers a waiter if it's empty. No line can ever arrive
 * before there's somewhere for it to go.
 */
function createPrompter() {
  const isTTY = !!process.stdin.isTTY;
  const queue = [];
  let waiting = null;
  let masked = false;
  let buffer = '';
  // 0 = normal, 1 = just saw ESC, 2 = inside a CSI escape sequence.
  let escapeState = 0;

  function emitLine(line) {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  }

  if (isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk) => {
    for (const ch of chunk) {
      const code = ch.codePointAt(0) ?? 0;

      // --- ANSI/CSI escape sequences (arrow keys, Home/End, Delete, a
      // terminal's bracketed-paste markers, etc.) are swallowed entirely
      // rather than treated as literal input. A REAL bug hit in
      // production: pressing an arrow key at a prompt appended its raw
      // escape bytes (ESC '[' 'C' for Right, for example) straight into
      // the username, and the corrupted value shipped to a live .env
      // before anyone noticed. See ProjectDocs/DECISIONS.md.
      if (escapeState === 1) {
        if (ch === '[') {
          escapeState = 2;
          continue;
        }
        escapeState = 0; // bare ESC, not a CSI sequence -- drop it, fall through to handle `ch` normally below
      } else if (escapeState === 2) {
        if (code >= 0x40 && code <= 0x7e) escapeState = 0; // final byte of the sequence
        continue;
      }

      if (ch === '\u001b') {
        escapeState = 1;
        continue;
      }
      if (ch === '\u0003') {
        // Ctrl-C
        process.stdout.write('\n');
        process.exit(130);
      }
      if (ch === '\n' || ch === '\r') {
        if (isTTY) process.stdout.write('\n');
        emitLine(buffer);
        buffer = '';
        continue;
      }
      if (ch === '\u007f' || ch === '\b') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          if (isTTY) process.stdout.write('\b \b');
        }
        continue;
      }
      if (code < 0x20) continue; // any other control byte -- ignore outright, never buffer it

      buffer += ch;
      if (isTTY) process.stdout.write(masked ? '*' : ch);
    }
  });

  process.stdin.on('end', () => {
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = '';
    }
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  });

  return function prompt(query, { mask = false } = {}) {
    process.stdout.write(query);
    masked = mask;
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };
}

/** Replaces KEY=... if present (anywhere in the file), appends it otherwise. Leaves every other line untouched. */
function upsertEnvVar(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) {
    // A function replacer, not a string one -- same reason as the $-doubling
    // above. `contents.replace(pattern, line)` would treat any `$$` already
    // inside `line` (e.g. an escaped bcrypt hash) as String.replace's own
    // "insert one literal $" pattern and silently collapse it back down,
    // undoing the escaping before it ever reached the file. Found by
    // actually re-reading the written file in testing, not assumed correct
    // from the escaping code alone.
    return contents.replace(pattern, () => line);
  }
  const needsNewline = contents.length > 0 && !contents.endsWith('\n');
  return contents + (needsNewline ? '\n' : '') + line + '\n';
}

function readEnvVar(contents, key) {
  const match = contents.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1] : null;
}

async function main() {
  const envPath = resolveEnvPath();
  const exists = fs.existsSync(envPath);
  let contents = exists ? fs.readFileSync(envPath, 'utf8') : '';

  // Only the repo-root .env is ever consumed by Docker Compose's
  // `env_file:` directive (see ../../docker-compose.yml). A REAL bug hit
  // in production: Compose interpolates `$word`-shaped sequences within
  // env_file VALUES too, not just `${VAR}` references inside
  // docker-compose.yml itself -- and a bcrypt hash (`$2b$12$...`) is
  // exactly that shape. The unresolved "variable" silently got blanked,
  // truncating the hash by ~22 characters before it ever reached the
  // container. Compose's own escape convention is doubling the dollar
  // sign (`$$` -> literal `$` after interpolation), so that's what gets
  // written here -- but ONLY for this file; fratoo-bridge/.env is read
  // directly by dotenv (no Compose involved, no interpolation, no
  // escaping needed) when running the bridge outside Docker.
  const isComposeEnv = envPath === path.resolve(__dirname, '..', '..', '.env');

  console.log(`Target file: ${envPath}${exists ? '' : ' (will be created)'}\n`);

  const existingUsername = readEnvVar(contents, 'ADMIN_USERNAME');
  const existingHash = readEnvVar(contents, 'ADMIN_PASSWORD_HASH');

  const prompt = createPrompter();

  if (existingHash) {
    const answer = await prompt(`An admin account already exists (username: ${existingUsername ?? '(unset)'}). Overwrite it? [y/N] `);
    if (!/^y(es)?$/i.test((answer ?? '').trim())) {
      console.log('Cancelled -- nothing was changed.');
      process.exit(0);
    }
  }

  const usernameInput = ((await prompt(`Admin username [${existingUsername ?? 'admin'}]: `)) ?? '').trim();
  const username = usernameInput || existingUsername || 'admin';

  let password;
  for (;;) {
    const first = (await prompt('Admin password: ', { mask: true })) ?? '';
    if (first.length < 8) {
      console.log('Password must be at least 8 characters.\n');
      continue;
    }
    const confirm = (await prompt('Confirm password: ', { mask: true })) ?? '';
    if (first !== confirm) {
      console.log("Passwords didn't match -- try again.\n");
      continue;
    }
    password = first;
    break;
  }

  const hash = bcrypt.hashSync(password, 12);
  // .replace with a FUNCTION replacer, not a string one -- `'$$'` as a
  // plain string replacement is itself a special pattern in
  // String.replace (it means "insert one literal $"), so
  // `hash.replace(/\$/g, '$$')` would silently do nothing. A function
  // replacer's return value is inserted as-is.
  const hashForFile = isComposeEnv ? hash.replace(/\$/g, () => '$$') : hash;

  contents = upsertEnvVar(contents, 'ADMIN_USERNAME', username);
  contents = upsertEnvVar(contents, 'ADMIN_PASSWORD_HASH', hashForFile);

  let jwtGenerated = false;
  const currentJwtSecret = readEnvVar(contents, 'JWT_SECRET');
  if (!currentJwtSecret || currentJwtSecret === 'change-me-to-a-long-random-string') {
    contents = upsertEnvVar(contents, 'JWT_SECRET', crypto.randomBytes(48).toString('hex'));
    jwtGenerated = true;
  }

  fs.writeFileSync(envPath, contents, { mode: 0o600 });

  // Round-trip verification: read back exactly what was written and
  // confirm it reconstructs to a hash that actually validates the
  // password the user just typed. Catches corruption like the one above
  // at write-time instead of shipping it silently -- this is what should
  // have caught it the first time.
  const rewritten = fs.readFileSync(envPath, 'utf8');
  const rawWritten = readEnvVar(rewritten, 'ADMIN_PASSWORD_HASH') ?? '';
  const reconstructedHash = isComposeEnv ? rawWritten.replace(/\$\$/g, () => '$') : rawWritten;
  const usernameWritten = readEnvVar(rewritten, 'ADMIN_USERNAME') ?? '';

  if (reconstructedHash !== hash || !bcrypt.compareSync(password, reconstructedHash) || usernameWritten !== username) {
    console.error('\n[ERROR] Verification failed after writing -- the saved credentials do not match what you just entered.');
    console.error('Nothing was deployed with this; please report this and try again.');
    console.error(`  username written: "${usernameWritten}" (expected "${username}")`);
    process.exit(1);
  }

  const written = ['ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', ...(jwtGenerated ? ['JWT_SECRET'] : [])];
  console.log(`\nVerified OK. Wrote ${written.join(', ')} to ${envPath}.`);
  console.log(`Username: "${username}"`);
  if (jwtGenerated) console.log('(Generated a fresh JWT_SECRET since none was set.)');
  console.log('Restart the stack to pick it up:');
  console.log('  docker compose up -d --build   (from the repo root)');
  process.exit(0);
}

main().catch((err) => {
  console.error('create-admin failed:', err);
  process.exit(1);
});
