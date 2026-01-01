const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries an async Redis operation.
 */
async function redisRetry(operation, maxAttempts = 3, backoff = 200) {
    let attempt = 0;
    while (true) {
        try {
            return await operation();
        } catch (err) {
            attempt++;
            if (attempt > maxAttempts) {
                console.error(`[isoAutomate SDK Error] Operation failed: ${err.message}`);
                throw err;
            }
            await sleep(backoff * Math.pow(2, attempt - 1));
        }
    }
}

module.exports = { sleep, redisRetry };