import { Redis } from 'ioredis';

/**
 * Standard sleep function (async/await compatible)
 */
export const sleep = (seconds: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

/**
 * Retry logic for Redis operations.
 * Equivalent to your @redis_retry decorator.
 */
export async function withRedisRetry<T>(
  operation: () => Promise<T>, 
  maxAttempts: number = 3, 
  backoffFactor: number = 0.2
): Promise<T> {
  let attempt = 0;
  
  while (true) {
    try {
      return await operation();
    } catch (error: any) {
      // Check if it's a Redis connection/timeout error
      // ioredis errors usually contain 'ETIMEDOUT' or 'ECONNREFUSED'
      const isRedisError = error?.code === 'ETIMEDOUT' || 
                           error?.code === 'ECONNREFUSED' || 
                           error?.message?.includes('Redis');

      if (isRedisError) {
        attempt++;
        if (attempt > maxAttempts) {
          throw error;
        }
        // Calculate backoff: 0.2 * (2 ^ (attempt - 1))
        const delay = backoffFactor * (Math.pow(2, attempt - 1));
        await sleep(delay);
      } else {
        // If it's not a connection error (e.g., logic error), throw immediately
        throw error;
      }
    }
  }
}