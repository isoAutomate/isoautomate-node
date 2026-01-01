class BrowserError extends Error {
    constructor(message) {
        super(message);
        this.name = "BrowserError";
    }
}

module.exports = { BrowserError };