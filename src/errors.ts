export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserError";
    // Ensures the stack trace is captured correctly
    Error.captureStackTrace(this, this.constructor);
  }
}