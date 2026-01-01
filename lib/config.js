const path = require('path');
const os = require('os');

// Constants (The Protocol)
const REDIS_PREFIX = "ISOAUTOMATE:";
const WORKERS_SET = `${REDIS_PREFIX}workers`;

// File System Paths
const SCREENSHOT_FOLDER = path.join(process.cwd(), "screenshots");
const ASSERTION_FOLDER = path.join(SCREENSHOT_FOLDER, "failures");

// Defaults
const DEFAULT_REDIS_HOST = "localhost";
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_DB = 0;

module.exports = {
    REDIS_PREFIX,
    WORKERS_SET,
    SCREENSHOT_FOLDER,
    ASSERTION_FOLDER,
    DEFAULT_REDIS_HOST,
    DEFAULT_REDIS_PORT,
    DEFAULT_REDIS_DB
};