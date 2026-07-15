/**
 * watch.js
 * -----------------------------------------------------------------------------
 * Auto-commit file watcher for CelebDossier.com
 *
 * Watches the entire project recursively. When files change, it waits for a
 * quiet period of 5 seconds (debounce). Once things settle, it runs:
 *      git add .
 *      git commit -m "Auto Update - YYYY-MM-DD HH:mm:ss"
 *      git push origin main
 *
 * - Only Node.js + chokidar are used (no extra deps).
 * - Never creates empty commits.
 * - Never runs two git pushes at the same time (a new request is queued).
 * - Keeps running until CTRL+C.
 * - Works on Windows (uses shell:true so "git" resolves via PATH / git.exe).
 *
 * Run with:  node watch.js
 * -----------------------------------------------------------------------------
 */

'use strict';

/* ============================================================================
 * 1. IMPORTS
 * ========================================================================== */
const path = require('path');
const { spawn } = require('child_process');

// chokidar is required. If it is missing, fail loudly with a helpful message.
let chokidar;
try {
  chokidar = require('chokidar');
} catch (err) {
  console.error(
    '\x1b[31m[ERROR]\x1b[0m chokidar is not installed. Run:  npm install chokidar'
  );
  process.exit(1);
}

/* ============================================================================
 * 2. CONFIGURATION
 * ========================================================================== */

// Root folder to watch (the project this script lives in / is launched from).
const PROJECT_ROOT = process.cwd();

// The git branch we push to.
const GIT_BRANCH = 'main';

// Quiet window: after the LAST change we wait this long before committing.
// Any change during the wait restarts the timer (handles rapid saves).
const DEBOUNCE_MS = 5000;

// File extensions we care about (lower-case, without the dot).
const WATCHED_EXTENSIONS = new Set([
  'html',
  'css',
  'js',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'svg',
  'ico',
  'json',
  'xml',
  'txt',
]);

// Folders / paths that must never trigger the watcher.
const IGNORED_DIRS = ['.git', 'node_modules', 'dist', '.cache'];

// Temporary / editor swap files we should ignore even if the extension matches.
// Examples: Vim swap (.swp), backups (file~), OS junk, in-progress saves.
const TEMP_FILE_REGEX = /(^|[\\/])(\.#|~\$)|(\.(swp|swx|swo|tmp|temp|bak|orig)$)|(~$)|(^|[\\/])\.DS_Store$|(^|[\\/])Thumbs\.db$/i;

/* ============================================================================
 * 3. COLORED LOGGING
 * ========================================================================== */

// Minimal ANSI colour codes so we do not need an external logging library.
const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// Small helper that prints a timestamped, colour-tagged line.
function log(color, tag, message) {
  const time = formatTimestamp(new Date());
  console.log(
    `${COLORS.gray}[${time}]${COLORS.reset} ${color}${tag}${COLORS.reset} ${message || ''}`
  );
}

// Convenience wrappers for each log type the spec asks for.
const logger = {
  fileChanged: (file) => log(COLORS.cyan, 'FILE CHANGED', file),
  waiting: (msg) => log(COLORS.yellow, 'WAITING...', msg),
  gitAdd: (msg) => log(COLORS.blue, 'GIT ADD', msg || ''),
  gitCommit: (msg) => log(COLORS.magenta, 'GIT COMMIT', msg || ''),
  gitPush: (msg) => log(COLORS.blue, 'GIT PUSH', msg || ''),
  success: (msg) => log(COLORS.green, 'SUCCESS', msg || ''),
  error: (msg) => log(COLORS.red, 'ERROR', msg || ''),
  info: (msg) => log(COLORS.gray, 'INFO', msg || ''),
};

/* ============================================================================
 * 4. TIMESTAMP HELPER
 * ========================================================================== */

// Formats a Date as "YYYY-MM-DD HH:mm:ss" in local time.
function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/* ============================================================================
 * 5. GIT COMMAND RUNNER
 * ========================================================================== */

/**
 * Runs a git command and resolves with { code, stdout, stderr }.
 * Uses spawn with shell:true so it works on Windows (finds git.exe via PATH).
 * We never reject on a non-zero exit code; the caller decides what to do,
 * so a single failed push cannot crash the watcher.
 */
function runGit(args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: PROJECT_ROOT,
      shell: true, // required for reliable resolution on Windows
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    // If git itself cannot be spawned (e.g. not installed), surface it here.
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr || err.message });
    });

    child.on('close', (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/* ============================================================================
 * 6. COMMIT + PUSH PIPELINE
 * ========================================================================== */

// State flags that guarantee only one git pipeline runs at a time.
let isRunning = false; // true while a git pipeline is in progress
let isQueued = false; // true if changes arrived while a pipeline was running

/**
 * The full git pipeline: add -> check for changes -> commit -> push.
 * Guards against concurrent runs and empty commits.
 */
async function commitAndPush() {
  // GUARD: if a pipeline is already running, just remember that another run
  // is needed and return. This is the "queue the next push" behaviour.
  if (isRunning) {
    isQueued = true;
    logger.info('A commit is already in progress. Queued the next push.');
    return;
  }

  isRunning = true;

  try {
    // --- STEP 1: git add . --------------------------------------------------
    logger.gitAdd('Staging all changes (git add .)');
    const addResult = await runGit(['add', '.']);
    if (addResult.code !== 0) {
      logger.error(`git add failed: ${addResult.stderr || addResult.stdout}`);
      return; // finally-block will release the lock and drain the queue
    }

    // --- STEP 2: detect whether there is anything to commit -----------------
    // "git status --porcelain" prints one line per change; empty output means
    // the working tree + index are clean, so we must NOT create an empty commit.
    const statusResult = await runGit(['status', '--porcelain']);
    if (statusResult.code !== 0) {
      logger.error(`git status failed: ${statusResult.stderr}`);
      return;
    }
    if (!statusResult.stdout) {
      logger.info('No changes to commit. Skipping.');
      return;
    }

    // --- STEP 3: git commit -------------------------------------------------
    const message = `Auto Update - ${formatTimestamp(new Date())}`;
    logger.gitCommit(`"${message}"`);
    const commitResult = await runGit(['commit', '-m', message]);
    if (commitResult.code !== 0) {
      // "nothing to commit" is a safety net in case of a race; treat as benign.
      const combined = `${commitResult.stdout} ${commitResult.stderr}`.toLowerCase();
      if (combined.includes('nothing to commit')) {
        logger.info('Nothing to commit after staging. Skipping.');
        return;
      }
      logger.error(`git commit failed: ${commitResult.stderr || commitResult.stdout}`);
      return;
    }

    // --- STEP 4: git push origin main --------------------------------------
    logger.gitPush(`Pushing to origin/${GIT_BRANCH}`);
    const pushResult = await runGit(['push', 'origin', GIT_BRANCH]);
    if (pushResult.code !== 0) {
      // Push failure is non-fatal: log it and keep watching. The commit stays
      // local and will be pushed on the next successful cycle.
      logger.error(`git push failed: ${pushResult.stderr || pushResult.stdout}`);
      return;
    }

    // --- DONE ---------------------------------------------------------------
    logger.success(`Committed and pushed: ${message}`);
  } catch (err) {
    // Catch-all so an unexpected error never stops the watcher.
    logger.error(`Unexpected error in git pipeline: ${err.message}`);
  } finally {
    // Always release the lock.
    isRunning = false;

    // DRAIN THE QUEUE: if changes came in while we were busy, run once more.
    if (isQueued) {
      isQueued = false;
      logger.info('Running queued push for changes made during the last commit.');
      commitAndPush();
    }
  }
}

/* ============================================================================
 * 7. DEBOUNCE SCHEDULER
 * ========================================================================== */

// Holds the pending debounce timer so we can reset it on each new change.
let debounceTimer = null;

/**
 * Called on every relevant file event. Resets the 5-second countdown so that
 * a burst of rapid saves results in a single commit once things go quiet.
 */
function scheduleCommit() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  logger.waiting(`Waiting ${DEBOUNCE_MS / 1000}s for changes to settle...`);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    commitAndPush();
  }, DEBOUNCE_MS);
}

/* ============================================================================
 * 8. FILE FILTERING
 * ========================================================================== */

// Returns true if a given path should be ignored by the watcher.
function shouldIgnore(targetPath) {
  // Normalise separators for cross-platform matching.
  const normalized = targetPath.split(path.sep).join('/');

  // Ignore anything inside a blocked directory.
  for (const dir of IGNORED_DIRS) {
    if (
      normalized === dir ||
      normalized.includes(`/${dir}/`) ||
      normalized.startsWith(`${dir}/`) ||
      normalized.endsWith(`/${dir}`)
    ) {
      return true;
    }
  }

  // Ignore temporary / editor files regardless of extension.
  if (TEMP_FILE_REGEX.test(normalized)) {
    return true;
  }

  return false;
}

// Returns true if the file extension is one we track.
function hasWatchedExtension(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase(); // "html", "png"...
  return WATCHED_EXTENSIONS.has(ext);
}

/* ============================================================================
 * 9. START THE WATCHER
 * ========================================================================== */

logger.info(`Watching project: ${PROJECT_ROOT}`);
logger.info(
  `Tracking: ${[...WATCHED_EXTENSIONS].join(', ')} | Ignoring: ${IGNORED_DIRS.join(', ')}`
);
logger.info(`Debounce: ${DEBOUNCE_MS / 1000}s | Branch: ${GIT_BRANCH}`);
logger.info('Press CTRL+C to stop.');

// Initialise chokidar. ignoreInitial:true prevents a commit on startup.
const watcher = chokidar.watch(PROJECT_ROOT, {
  ignored: shouldIgnore, // function form: called for every path
  ignoreInitial: true, // do not fire for existing files at boot
  persistent: true, // keep the process alive
  awaitWriteFinish: {
    // Wait until a file finishes being written before emitting an event.
    // This alone smooths out large image saves; the debounce handles the rest.
    stabilityThreshold: 300,
    pollInterval: 100,
  },
});

// Single handler for add / change / unlink events.
function onFileEvent(eventType, filePath) {
  // Only react to file types we actually track.
  if (!hasWatchedExtension(filePath)) {
    return;
  }
  const relative = path.relative(PROJECT_ROOT, filePath) || filePath;
  logger.fileChanged(`${relative} (${eventType})`);
  scheduleCommit();
}

// Wire up the relevant events.
watcher
  .on('add', (p) => onFileEvent('added', p))
  .on('change', (p) => onFileEvent('changed', p))
  .on('unlink', (p) => onFileEvent('deleted', p))
  .on('error', (err) => logger.error(`Watcher error: ${err.message}`))
  .on('ready', () => logger.success('Initial scan complete. Watching for changes.'));

/* ============================================================================
 * 10. GRACEFUL SHUTDOWN
 * ========================================================================== */

// Handle CTRL+C (SIGINT) and SIGTERM so we can close the watcher cleanly.
function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down watcher...`);
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  watcher.close().finally(() => {
    logger.success('Watcher stopped. Goodbye!');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Last line of defence: never let an uncaught error kill the watcher silently.
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});
