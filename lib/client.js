const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const {
    REDIS_PREFIX, WORKERS_SET, SCREENSHOT_FOLDER, ASSERTION_FOLDER,
    DEFAULT_REDIS_HOST, DEFAULT_REDIS_PORT, DEFAULT_REDIS_DB
} = require('./config');
const { BrowserError } = require('./errors');
const { sleep, redisRetry } = require('./utils');

class BrowserClient {
    constructor(options = {}) {
        // Environment Variables vs Options
        const host = options.redisHost || process.env.REDIS_HOST || DEFAULT_REDIS_HOST;
        const port = parseInt(options.redisPort || process.env.REDIS_PORT || DEFAULT_REDIS_PORT);
        const password = options.redisPassword || process.env.REDIS_PASSWORD || undefined;
        const db = parseInt(options.redisDb || process.env.REDIS_DB || DEFAULT_REDIS_DB);
        const url = options.redisUrl || process.env.REDIS_URL;
        
        // Initialize Redis Connection
        if (url) {
            this.redis = new Redis(url);
        } else {
            this.redis = new Redis({
                host,
                port,
                password,
                db,
                tls: (options.redisSsl || process.env.REDIS_SSL === "true") ? {} : undefined
            });
        }

        this.session = null;
        this.videoUrl = null;
        this.sessionData = {};
    }

    /**
     * Cleanup mechanism (Manual call required in Node as there is no Context Manager 'with')
     */
    async close() {
        if (this.session) {
            try {
                console.log(`[SDK] Auto-releasing session ${this.session.browserId.substring(0, 6)}...`);
                await this.release();
            } catch (e) {
                console.log(`[SDK] Release failed during cleanup: ${e.message}`);
            }
        }
        this.redis.disconnect();
    }

    // ---------------------------- Connection & Lifecycle ----------------------------

    async acquire(browserType = "chrome", record = false) {
        // Get list of workers
        const workers = await redisRetry(() => this.redis.smembers(WORKERS_SET));
        
        // Shuffle workers (Fisher-Yates)
        for (let i = workers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [workers[i], workers[j]] = [workers[j], workers[i]];
        }

        for (const workerName of workers) {
            // Try to pop a free browser
            const freeKey = `${REDIS_PREFIX}${workerName}:${browserType}:free`;
            const bid = await redisRetry(() => this.redis.spop(freeKey));

            if (bid) {
                // Mark as busy
                await redisRetry(() => this.redis.sadd(`${REDIS_PREFIX}${workerName}:${browserType}:busy`, bid));

                this.session = {
                    browserId: bid,
                    worker: workerName,
                    browserType: browserType,
                    record: record
                };

                // Start Recording Signal
                if (record) {
                    await this._send("start_recording", {}, 5);
                }

                return { status: "ok", browser_id: bid, worker: workerName };
            }
        }

        throw new BrowserError(`No browsers available for type: '${browserType}'. Check your workers.`);
    }

    async release() {
        if (!this.session) return { status: "error", error: "not_acquired" };

        try {
            // Stop Recording Signal
            if (this.session.record) {
                console.log("[SDK] Stopping recording...");
                const res = await this._send("stop_recording", {}, 120);
                if (res.video_url) {
                    this.videoUrl = res.video_url;
                    console.log(`[SDK] Session Video: ${this.videoUrl}`);
                }
            }

            console.log("[SDK] Sending release command...");
            const res = await this._send("release_browser");
            this.sessionData = res;
            console.log(`[SDK] Release result: ${JSON.stringify(res)}`);
            return res;

        } catch (e) {
            console.error(`[SDK ERROR] Error inside release: ${e.message}`);
            return { status: "error", error: e.message };
        } finally {
            this.session = null;
        }
    }

    async _send(action, args = {}, timeout = 60) {
        if (!this.session) throw new BrowserError(`Cannot perform action '${action}': Browser session not acquired.`);

        const taskId = uuidv4().replace(/-/g, '');
        const resultKey = `${REDIS_PREFIX}result:${taskId}`;
        const queue = `${REDIS_PREFIX}${this.session.worker}:tasks`;

        const payload = JSON.stringify({
            task_id: taskId,
            browser_id: this.session.browserId,
            worker_name: this.session.worker,
            browser_type: this.session.browserType,
            action: action,
            args: args,
            result_key: resultKey
        });

        await redisRetry(() => this.redis.rpush(queue, payload));

        const start = Date.now();
        while (Date.now() - start < timeout * 1000) {
            const res = await redisRetry(() => this.redis.get(resultKey));
            if (res) {
                await redisRetry(() => this.redis.del(resultKey));
                return JSON.parse(res);
            }
            await sleep(50);
        }

        return { status: "error", error: "Timeout waiting for worker" };
    }

    // ---------------------------- ASSERTION HANDLER ----------------------------

    async _handleAssertion(action, args) {
        if (args.screenshot === undefined) args.screenshot = true;

        const res = await this._send(action, args);

        if (res.status === "fail") {
            // 1. Save Screenshot
            if (res.screenshot_base64) {
                try {
                    if (!fs.existsSync(ASSERTION_FOLDER)) fs.mkdirSync(ASSERTION_FOLDER, { recursive: true });
                    
                    const selectorClean = (args.selector || "unknown").replace(/[#\.\s]/g, "_").substring(0, 20);
                    const timestamp = new Date().toISOString().replace(/[:.]/g, "");
                    const filename = `FAIL_${action}_${selectorClean}_${timestamp}.png`;
                    const filePath = path.join(ASSERTION_FOLDER, filename);

                    fs.writeFileSync(filePath, Buffer.from(res.screenshot_base64, 'base64'));
                    console.log(` [Assertion Fail] Screenshot saved: ${filePath}`);
                } catch (e) {
                    console.error(` [SDK Error] Failed to save failure screenshot: ${e.message}`);
                }
            }
            
            // 2. Throw Error
            throw new Error(res.error || "Unknown assertion error");
        }
        return true;
    }

    // =========================================================================
    //  ACTION METHODS (Mapped camelCase -> snake_case protocol)
    // =========================================================================

    // --- 1. Navigation ---
    async openUrl(url) { return this._send("open_url", { url }); }
    async reload(ignoreCache = true, script = null) { 
        return this._send("reload", { ignore_cache: ignoreCache, script_to_evaluate_on_load: script }); 
    }
    async refresh() { return this._send("refresh"); }
    async goBack() { return this._send("go_back"); }
    async goForward() { return this._send("go_forward"); }
    async internalizeLinks() { return this._send("internalize_links"); }
    async getNavigationHistory() { return this._send("get_navigation_history"); }

    // --- 2. Mouse Interaction ---
    async click(selector, timeout = null) { return this._send("click", { selector, timeout }); }
    async clickIfVisible(selector) { return this._send("click_if_visible", { selector }); }
    async clickVisibleElements(selector, limit = 0) { return this._send("click_visible_elements", { selector, limit }); }
    async clickNthElement(selector, number = 1) { return this._send("click_nth_element", { selector, number }); }
    async clickNthVisibleElement(selector, number = 1) { return this._send("click_nth_visible_element", { selector, number }); }
    async clickLink(text) { return this._send("click_link", { text }); }
    async clickActiveElement() { return this._send("click_active_element"); }
    async mouseClick(selector) { return this._send("mouse_click", { selector }); }
    async nestedClick(parentSelector, selector) { return this._send("nested_click", { parent_selector: parentSelector, selector }); }
    async clickWithOffset(selector, x, y, center = false) { return this._send("click_with_offset", { selector, x, y, center }); }
    
    async doubleClick(selector) { return this._send("double_click", { selector }); }
    async rightClick(selector) { return this._send("right_click", { selector }); }
    async hover(selector) { return this._send("hover", { selector }); }
    async dragAndDrop(dragSelector, dropSelector) { return this._send("drag_and_drop", { drag_selector: dragSelector, drop_selector: dropSelector }); }

    // --- 3. Keyboard & Input ---
    async type(selector, text, timeout = null) { return this._send("type", { selector, text, timeout }); }
    async pressKeys(selector, text) { return this._send("press_keys", { selector, text }); }
    async sendKeys(selector, text) { return this._send("send_keys", { selector, text }); }
    async setValue(selector, text) { return this._send("set_value", { selector, text }); }
    async clear(selector) { return this._send("clear", { selector }); }
    async clearInput(selector) { return this._send("clear_input", { selector }); }
    async submit(selector) { return this._send("submit", { selector }); }
    async focus(selector) { return this._send("focus", { selector }); }

    // --- 4. GUI / PyAutoGUI ---
    async guiClickElement(selector, timeframe = 0.25) { return this._send("gui_click_element", { selector, timeframe }); }
    async guiClickXY(x, y, timeframe = 0.25) { return this._send("gui_click_x_y", { x, y, timeframe }); }
    async guiClickCaptcha() { return this._send("gui_click_captcha"); }
    async solveCaptcha() { return this._send("solve_captcha"); }
    async guiDragAndDrop(dragSelector, dropSelector, timeframe = 0.35) { 
        return this._send("gui_drag_and_drop", { drag_selector: dragSelector, drop_selector: dropSelector, timeframe }); 
    }
    async guiHoverElement(selector) { return this._send("gui_hover_element", { selector }); }
    async guiWrite(text) { return this._send("gui_write", { text }); }
    async guiPressKeys(keysList) { return this._send("gui_press_keys", { keys: keysList }); }

    // --- 5. Selects ---
    async selectOptionByText(selector, text) { return this._send("select_option_by_text", { selector, text }); }
    async selectOptionByValue(selector, value) { return this._send("select_option_by_value", { selector, value }); }
    async selectOptionByIndex(selector, index) { return this._send("select_option_by_index", { selector, index }); }

    // --- 6. Window / Tab / Frame ---
    async openNewTab(url) { return this._send("open_new_tab", { url }); }
    async openNewWindow(url) { return this._send("open_new_window", { url }); }
    async switchToTab(index = -1) { return this._send("switch_to_tab", { index }); }
    async switchToWindow(index = -1) { return this._send("switch_to_window", { index }); }
    async closeActiveTab() { return this._send("close_active_tab"); }
    async maximize() { return this._send("maximize"); }
    async minimize() { return this._send("minimize"); }
    async medimize() { return this._send("medimize"); }
    async tileWindows() { return this._send("tile_windows"); }
    
    async switchToFrame(selector) { return this._send("switch_to_frame", { selector }); }
    async switchToDefaultContent() { return this._send("switch_to_default_content"); }
    async switchToParentFrame() { return this._send("switch_to_parent_frame"); }
    async setWindowSize(width, height) { return this._send("set_window_size", { width, height }); }
    async setWindowRect(x, y, width, height) { return this._send("set_window_rect", { x, y, width, height }); }

    // --- 7. Data Extraction ---
    async getText(selector = "body") { return this._send("get_text", { selector }); }
    async getTitle() { return this._send("get_title"); }
    async getCurrentUrl() { return this._send("get_current_url"); }
    async getPageSource() { return this._send("get_page_source"); }
    async getHtml(selector = null) { return this._send("get_html", { selector }); }
    async getAttribute(selector, attribute) { return this._send("get_attribute", { selector, attribute }); }
    async getElementAttributes(selector) { return this._send("get_element_attributes", { selector }); }
    async getUserAgent() { return this._send("get_user_agent"); }
    async getCookieString() { return this._send("get_cookie_string"); }
    async getElementRect(selector) { return this._send("get_element_rect", { selector }); }
    async getWindowRect() { return this._send("get_window_rect"); }
    async getScreenRect() { return this._send("get_screen_rect"); }
    async isElementVisible(selector) { return this._send("is_element_visible", { selector }); }
    async isTextVisible(text) { return this._send("is_text_visible", { text }); }
    async isChecked(selector) { return this._send("is_checked", { selector }); }
    async isSelected(selector) { return this._send("is_selected", { selector }); }
    async isOnline() { return this._send("is_online"); }
    async getPerformanceMetrics() { return this._send("get_performance_metrics"); }
    async getAlertText() { return this._send("get_alert_text"); }

    // --- 8. Cookies & Storage ---
    async getAllCookies() { return this._send("get_all_cookies"); }
    async clearCookies() { return this._send("clear_cookies"); }
    async addCookie(cookieDict) { return this._send("add_cookie", { cookie: cookieDict }); }
    async deleteCookie(name) { return this._send("delete_cookie", { name }); }
    
    async saveCookies(name = "cookies.json") {
        const res = await this._send("save_cookies");
        if (res.status === "ok" && res.cookies) {
            fs.writeFileSync(name, JSON.stringify(res.cookies, null, 4));
            return { status: "ok", path: path.resolve(name) };
        }
        return res;
    }

    async loadCookies(name = "cookies.json", cookiesList = null) {
        let finalCookies = cookiesList;
        if (!finalCookies && name) {
            if (fs.existsSync(name)) {
                finalCookies = JSON.parse(fs.readFileSync(name, 'utf8'));
            } else {
                return { status: "error", error: `Local cookie file not found: ${name}` };
            }
        }
        return this._send("load_cookies", { name, cookies: finalCookies });
    }

    async getLocalStorageItem(key) { return this._send("get_local_storage_item", { key }); }
    async setLocalStorageItem(key, value) { return this._send("set_local_storage_item", { key, value }); }
    async getSessionStorageItem(key) { return this._send("get_session_storage_item", { key }); }
    async setSessionStorageItem(key, value) { return this._send("set_session_storage_item", { key, value }); }
    async exportSession() { return this._send("get_storage_state"); }
    async importSession(stateDict) { return this._send("set_storage_state", { state: stateDict }); }

    // --- 9. Visuals ---
    async highlight(selector) { return this._send("highlight", { selector }); }
    async highlightOverlay(selector) { return this._send("highlight_overlay", { selector }); }
    async removeElement(selector) { return this._send("remove_element", { selector }); }
    async flash(selector, duration = 1) { return this._send("flash", { selector, duration }); }

    // --- 10. Advanced ---
    async getMfaCode(totpKey) { return this._send("get_mfa_code", { totp_key: totpKey }); }
    async enterMfaCode(selector, totpKey) { return this._send("enter_mfa_code", { selector, totp_key: totpKey }); }
    async grantPermissions(permissions) { return this._send("grant_permissions", { permissions }); }
    async executeScript(script) { return this._send("execute_script", { script }); }
    async evaluate(expression) { return this._send("evaluate", { expression }); }
    async blockUrls(patterns) { return this._send("block_urls", { patterns }); }
    async acceptAlert() { return this._send("accept_alert"); }
    async dismissAlert() { return this._send("dismiss_alert"); }
    async uploadFile(selector, filePath) { return this._send("upload_file", { selector, file_path: filePath }); }

    // --- 11. Assertions ---
    async assertText(text, selector = "html", screenshot = true) { return this._handleAssertion("assert_text", { text, selector, screenshot }); }
    async assertExactText(text, selector = "html", screenshot = true) { return this._handleAssertion("assert_exact_text", { text, selector, screenshot }); }
    async assertElement(selector, screenshot = true) { return this._handleAssertion("assert_element", { selector, screenshot }); }
    async assertElementPresent(selector, screenshot = true) { return this._handleAssertion("assert_element_present", { selector, screenshot }); }
    async assertElementAbsent(selector, screenshot = true) { return this._handleAssertion("assert_element_absent", { selector, screenshot }); }
    async assertElementNotVisible(selector, screenshot = true) { return this._handleAssertion("assert_element_not_visible", { selector, screenshot }); }
    async assertTextNotVisible(text, selector = "html", screenshot = true) { return this._handleAssertion("assert_text_not_visible", { text, selector, screenshot }); }
    async assertTitle(title, screenshot = true) { return this._handleAssertion("assert_title", { title, screenshot }); }
    async assertUrl(urlSubstring, screenshot = true) { return this._handleAssertion("assert_url", { url: urlSubstring, screenshot }); }
    async assertAttribute(selector, attribute, value, screenshot = true) { return this._handleAssertion("assert_attribute", { selector, attribute, value, screenshot }); }

    // --- 12. Scrolling & Waiting ---
    async scrollIntoView(selector) { return this._send("scroll_into_view", { selector }); }
    async scrollToBottom() { return this._send("scroll_to_bottom"); }
    async scrollToTop() { return this._send("scroll_to_top"); }
    async scrollDown(amount = 25) { return this._send("scroll_down", { amount }); }
    async scrollUp(amount = 25) { return this._send("scroll_up", { amount }); }
    async scrollToY(y) { return this._send("scroll_to_y", { y }); }
    
    async sleep(seconds) { return this._send("sleep", { seconds }); }
    
    async waitForElement(selector, timeout = null) { return this._send("wait_for_element", { selector, timeout }); }
    async waitForText(text, selector = "html", timeout = null) { return this._send("wait_for_text", { text, selector, timeout }); }
    async waitForElementPresent(selector, timeout = null) { return this._send("wait_for_element_present", { selector, timeout }); }
    async waitForElementAbsent(selector, timeout = null) { return this._send("wait_for_element_absent", { selector, timeout }); }
    async waitForNetworkIdle() { return this._send("wait_for_network_idle"); }
    async waitForElementNotVisible(selector, timeout = null) { return this._send("wait_for_element_not_visible", { selector, timeout }); }

    // --- 13. Screenshots & Files ---
    async savePageSource(name = "source.html") {
        const res = await this._send("save_page_source");
        if (res.status === "ok" && res.source_base64) {
            fs.writeFileSync(name, Buffer.from(res.source_base64, 'base64').toString('utf8'));
            res.local_file_saved = true;
            res.file_path = path.resolve(name);
            delete res.source_base64;
        }
        return res;
    }

    async screenshot(filename = null, selector = null) {
        if (!filename) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
            const id = uuidv4().substring(0, 4);
            filename = path.join(SCREENSHOT_FOLDER, `${timestamp}_${id}.png`);
        }
        
        const dir = path.dirname(filename);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const res = await this._send("save_screenshot", { name: "temp.png", selector });
        
        if (res.status === "ok" && res.image_base64) {
            fs.writeFileSync(filename, Buffer.from(res.image_base64, 'base64'));
            return { status: "ok", path: path.resolve(filename) };
        }
        return res;
    }

    async saveAsPdf(filename = null) {
        if (!filename) filename = `doc_${Math.floor(Date.now() / 1000)}.pdf`;
        
        const dir = path.dirname(filename);
        if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const res = await this._send("save_as_pdf");
        if (res.status === "ok" && res.pdf_base64) {
            fs.writeFileSync(filename, Buffer.from(res.pdf_base64, 'base64'));
            return { status: "ok", path: path.resolve(filename) };
        }
        return res;
    }
}

module.exports = BrowserClient;