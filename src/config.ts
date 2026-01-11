import path from 'path';

// ---------------------------------------------------------
// CONSTANTS (The "Protocol")
// ---------------------------------------------------------
export const REDIS_PREFIX = "ISOAUTOMATE:";
export const WORKERS_SET = `${REDIS_PREFIX}workers`;

// File System Paths
export const SCREENSHOT_FOLDER = "screenshots";
export const ASSERTION_FOLDER = path.join(SCREENSHOT_FOLDER, "failures");

// ---------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------
// In Node.js, undefined acts like None in Python
export const DEFAULT_REDIS_DB = 0;