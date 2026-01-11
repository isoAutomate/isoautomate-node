import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Redis, { Redis as RedisClient } from 'ioredis';
import * as dotenv from 'dotenv';

import {
  DEFAULT_REDIS_DB,
  REDIS_PREFIX,
  WORKERS_SET,
  SCREENSHOT_FOLDER,
  ASSERTION_FOLDER
} from './config';
import { BrowserError } from './errors';
import { withRedisRetry, sleep } from './utils';

// Load environment variables immediately
dotenv.config();

// Interface for the session object
interface BrowserSession {
  browser_id: string;
  worker: string;
  browser_type: string;
  video: boolean;
  profile_id: string | null;
  record: boolean;
}

export class BrowserClient {
  private redisUrl: string | undefined;
  private host: string | undefined;
  private port: string | undefined;
  private password: string | undefined;
  private db: number;
  private ssl: boolean;
  
  private r: RedisClient;
  public session: BrowserSession | null = null;
  public video_url: string | null = null;
  public record_url: string | null = null;
  public session_data: any = {};
  
  private _init_sent: boolean = false;

  /**
   * Node.js SDK for isoAutomate.
   * Controls remote browsers via Redis queues.
   */
  constructor(options: {
    redisUrl?: string;
    redisHost?: string;
    redisPort?: number | string;
    redisPassword?: string;
    redisDb?: number;
    redisSsl?: boolean;
    envFile?: string;
  } = {}) {
    // Load custom env file if provided
    if (options.envFile) {
      dotenv.config({ path: options.envFile, override: true });
    }

    const envUrl = process.env.REDIS_URL;
    const envHost = process.env.REDIS_HOST;
    const envPort = process.env.REDIS_PORT;
    const envPass = process.env.REDIS_PASSWORD;
    const envDb = process.env.REDIS_DB;
    const envSsl = (process.env.REDIS_SSL || "false").toLowerCase() === "true" || process.env.REDIS_SSL === "1";

    this.redisUrl = options.redisUrl || envUrl;
    this.host = options.redisHost || envHost;
    this.port = options.redisPort ? String(options.redisPort) : envPort;
    this.password = options.redisPassword || envPass;
    this.db = options.redisDb !== undefined ? options.redisDb : (envDb ? parseInt(envDb) : DEFAULT_REDIS_DB);
    this.ssl = options.redisSsl !== undefined ? options.redisSsl : envSsl;

    if (!this.redisUrl && !this.host) {
      throw new BrowserError("Missing Redis Configuration.");
    }

    try {
      if (this.redisUrl) {
        this.r = new Redis(this.redisUrl, {
          db: this.db,
          tls: this.ssl ? {} : undefined
        });
      } else {
        const portNum = this.port ? parseInt(this.port) : 6379;
        this.r = new Redis({
          host: this.host,
          port: portNum,
          password: this.password,
          db: this.db,
          tls: this.ssl ? {} : undefined
        });
      }
    } catch (e: any) {
      throw new BrowserError(`Failed to initialize Redis connection: ${e.message}`);
    }
  }

  // --- Redis Wrappers ---
  
  private async _r_rpush(key: string, ...values: string[]): Promise<number> {
    return withRedisRetry(() => this.r.rpush(key, ...values));
  }

  // --- Lifecycle Methods ---

  /**
   * Acquire a browser session using ATOMIC LUA SCRIPTING.
   */
  public async acquire(
    browser_type: string = "chrome", 
    video: boolean = false, 
    profile: boolean | string | null = null, 
    record: boolean = false
  ): Promise<any> {
    let profile_id: string | null = null;
    
    if (profile === true) {
      const profileStore = path.join(process.cwd(), ".iso_profiles");
      if (!fs.existsSync(profileStore)) fs.mkdirSync(profileStore, { recursive: true });
      
      const idFile = path.join(profileStore, "default_profile.id");
      if (fs.existsSync(idFile)) {
        profile_id = fs.readFileSync(idFile, 'utf-8').trim();
      } else {
        profile_id = `user_${uuidv4().replace(/-/g, '').substring(0, 8)}`;
        fs.writeFileSync(idFile, profile_id);
      }
    } else if (typeof profile === 'string') {
      profile_id = profile;
    }

    this._init_sent = false;

    // LUA SCRIPT
    const luaScript = `
      local workers = redis.call('SMEMBERS', KEYS[1])
      for i = #workers, 2, -1 do
          local j = math.random(i)
          workers[i], workers[j] = workers[j], workers[i]
      end
      
      for _, worker in ipairs(workers) do
          local free_key = ARGV[1] .. worker .. ':' .. ARGV[2] .. ':free'
          local bid = redis.call('SPOP', free_key)
          if bid then
              local busy_key = ARGV[1] .. worker .. ':' .. ARGV[2] .. ':busy'
              redis.call('SADD', busy_key, bid)
              return {worker, bid}
          end
      end
      return nil
    `;

    let result: any;
    try {
      result = await this.r.eval(luaScript, 1, WORKERS_SET, REDIS_PREFIX, browser_type);
    } catch (e: any) {
      throw new BrowserError(`Redis Lua Error: ${e.message}`);
    }

    if (result) {
      const worker_name = result[0];
      const bid = result[1];

      this.session = {
        browser_id: bid,
        worker: worker_name,
        browser_type: browser_type,
        video: video,
        profile_id: profile_id,
        record: record
      };

      if (profile_id || video || record) {
        // Trigger initialization
        await this._send("get_title");
      }

      return { status: "ok", browser_id: bid, worker: worker_name };
    }

    throw new BrowserError(`No browsers available for type: '${browser_type}'. Check workers.`);
  }

  public async release(): Promise<any> {
    if (!this.session) return { status: "error", error: "not_acquired" };

    try {
      if (this.session.video) {
        const res = await this._send("stop_video", {}, 120);
        if (res.video_url) {
          this.video_url = res.video_url;
        }
      }

      if (this.session.record) {
        const resR = await this._send("stop_record", {}, 60);
        if (resR.record_url) {
          this.record_url = resR.record_url;
        }
      }

      const res = await this._send("release_browser");
      this.session_data = res;
      return res;
    } catch (e: any) {
      return { status: "error", error: String(e) };
    } finally {
      this.session = null;
    }
  }

  /**
   * Close the Redis connection (Useful for cleanup in Node)
   */
  public async close(): Promise<void> {
    await this.r.quit();
  }

  private async _send(action: string, args: any = {}, timeout: number = 60): Promise<any> {
    if (!this.session) throw new BrowserError(`Cannot perform action '${action}': Browser session not acquired.`);

    const task_id = uuidv4().replace(/-/g, '');
    const result_key = `${REDIS_PREFIX}result:${task_id}`;
    const queue = `${REDIS_PREFIX}${this.session.worker}:tasks`;

    const payload: any = {
      task_id: task_id,
      browser_id: this.session.browser_id,
      worker_name: this.session.worker,
      action: action,
      args: args,
      result_key: result_key
    };

    if (!this._init_sent) {
      if (this.session.video) payload.video = true;
      if (this.session.record) payload.record = true;
      if (this.session.profile_id) {
        payload.profile_id = this.session.profile_id;
        payload.browser_type = this.session.browser_type;
      }
    }

    await this._r_rpush(queue, JSON.stringify(payload));

    try {
      // Blocking Pop
      const resp = await this.r.blpop(result_key, timeout);
      if (resp) {
        this._init_sent = true;
        // resp[0] is key, resp[1] is value
        return JSON.parse(resp[1]);
      } else {
        return { status: "error", error: "Timeout waiting for worker" };
      }
    } catch (e: any) {
      return { status: "error", error: `Redis RPC Error: ${e.message}` };
    }
  }

  // --- Assertion Handler ---
  private async _handle_assertion(action: string, args: any): Promise<boolean> {
    if (!args.screenshot) args.screenshot = true;
    const res = await this._send(action, args);

    if (res.status === "fail") {
      if (res.screenshot_base64) {
        try {
          if (!fs.existsSync(ASSERTION_FOLDER)) fs.mkdirSync(ASSERTION_FOLDER, { recursive: true });
          const selectorClean = (args.selector || "unknown").replace(/[#. ]/g, "_").substring(0, 20);
          const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").substring(8, 14); // HHMMSS approx
          const filename = `FAIL_${action}_${selectorClean}_${timestamp}.png`;
          const filePath = path.join(ASSERTION_FOLDER, filename);
          
          fs.writeFileSync(filePath, Buffer.from(res.screenshot_base64, 'base64'));
        } catch (e) {
            // Ignore write errors
        }
      }
      const errorMsg = res.error || "Unknown assertion error";
      throw new Error(errorMsg); // Using standard Error for assertions
    }
    return true;
  }

  // --- Helper: Save Base64 File ---
  private _save_base64_file(res: any, key_name: string, output_path: string): any {
    if (res.status === "ok" && res[key_name]) {
      try {
        const dir = path.dirname(output_path);
        if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        fs.writeFileSync(output_path, Buffer.from(res[key_name], 'base64'));
        return { status: "ok", path: path.resolve(output_path) };
      } catch (e: any) {
        return { status: "error", error: `Failed to save local file: ${e.message}` };
      }
    }
    return res;
  }

  // --- Actions ---

  public async screenshot(filename?: string, selector?: string): Promise<any> {
    if (!filename) {
      const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").substring(0, 15);
      const uniqueId = uuidv4().replace(/-/g, '').substring(0, 4);
      filename = path.join(SCREENSHOT_FOLDER, `${timestamp}_${uniqueId}.png`);
    }
    const res = await this._send("save_screenshot", { name: "temp.png", selector: selector });
    return this._save_base64_file(res, "image_base64", filename);
  }

  public async save_as_pdf(filename?: string): Promise<any> {
    if (!filename) filename = `doc_${Math.floor(Date.now() / 1000)}.pdf`;
    const res = await this._send("save_as_pdf");
    return this._save_base64_file(res, "pdf_base64", filename);
  }

  public async save_page_source(name: string = "source.html"): Promise<any> {
    const res = await this._send("save_page_source");
    if (res.status === "ok" && res.source_base64) {
      try {
        const data = Buffer.from(res.source_base64, 'base64').toString('utf-8');
        fs.writeFileSync(name, data, 'utf-8');
        return { status: "ok", path: path.resolve(name) };
      } catch (e: any) {
        return { status: "error", error: String(e) };
      }
    }
    return res;
  }

  public async execute_cdp_cmd(cmd: string, params: any = {}): Promise<any> {
    return this._send("execute_cdp_cmd", { cmd, params });
  }

  public async upload_file(selector: string, local_file_path: string): Promise<any> {
    if (!fs.existsSync(local_file_path)) return { status: "error", error: `Local file not found: ${local_file_path}` };
    const fileData = fs.readFileSync(local_file_path).toString('base64');
    const filename = path.basename(local_file_path);
    return this._send("upload_file", { selector, file_name: filename, file_data: fileData });
  }

  // --- Standard Mappings ---

  public async open_url(url: string): Promise<any> { return this._send("open_url", { url }); }
  public async reload(ignore_cache: boolean = true, script?: string): Promise<any> { return this._send("reload", { ignore_cache, script_to_evaluate_on_load: script }); }
  public async refresh(): Promise<any> { return this._send("refresh"); }
  public async go_back(): Promise<any> { return this._send("go_back"); }
  public async go_forward(): Promise<any> { return this._send("go_forward"); }
  public async internalize_links(): Promise<any> { return this._send("internalize_links"); }
  public async get_navigation_history(): Promise<any> { return this._send("get_navigation_history"); }

  public async click(selector: string, timeout?: number): Promise<any> { return this._send("click", { selector, timeout }); }
  public async click_if_visible(selector: string): Promise<any> { return this._send("click_if_visible", { selector }); }
  public async click_visible_elements(selector: string, limit: number = 0): Promise<any> { return this._send("click_visible_elements", { selector, limit }); }
  public async click_nth_element(selector: string, number: number = 1): Promise<any> { return this._send("click_nth_element", { selector, number }); }
  public async click_nth_visible_element(selector: string, number: number = 1): Promise<any> { return this._send("click_nth_visible_element", { selector, number }); }
  public async click_link(text: string): Promise<any> { return this._send("click_link", { text }); }
  public async click_active_element(): Promise<any> { return this._send("click_active_element"); }
  public async mouse_click(selector: string): Promise<any> { return this._send("mouse_click", { selector }); }
  public async nested_click(parent_selector: string, selector: string): Promise<any> { return this._send("nested_click", { parent_selector, selector }); }
  public async click_with_offset(selector: string, x: number, y: number, center: boolean = false): Promise<any> { return this._send("click_with_offset", { selector, x, y, center }); }

  public async type(selector: string, text: string, timeout?: number): Promise<any> { return this._send("type", { selector, text, timeout }); }
  public async press_keys(selector: string, text: string): Promise<any> { return this._send("press_keys", { selector, text }); }
  public async send_keys(selector: string, text: string): Promise<any> { return this._send("send_keys", { selector, text }); }
  public async set_value(selector: string, text: string): Promise<any> { return this._send("set_value", { selector, text }); }
  public async clear(selector: string): Promise<any> { return this._send("clear", { selector }); }
  public async clear_input(selector: string): Promise<any> { return this._send("clear_input", { selector }); }
  public async submit(selector: string): Promise<any> { return this._send("submit", { selector }); }
  public async focus(selector: string): Promise<any> { return this._send("focus", { selector }); }

  public async gui_click_element(selector: string, timeframe: number = 0.25): Promise<any> { return this._send("gui_click_element", { selector, timeframe }); }
  public async gui_click_x_y(x: number, y: number, timeframe: number = 0.25): Promise<any> { return this._send("gui_click_x_y", { x, y, timeframe }); }
  public async gui_click_captcha(): Promise<any> { return this._send("gui_click_captcha"); }
  public async solve_captcha(): Promise<any> { return this._send("solve_captcha"); }
  public async gui_drag_and_drop(drag_selector: string, drop_selector: string, timeframe: number = 0.35): Promise<any> { return this._send("gui_drag_and_drop", { drag_selector, drop_selector, timeframe }); }
  public async gui_hover_element(selector: string): Promise<any> { return this._send("gui_hover_element", { selector }); }
  public async gui_write(text: string): Promise<any> { return this._send("gui_write", { text }); }
  public async gui_press_keys(keys_list: string[]): Promise<any> { return this._send("gui_press_keys", { keys: keys_list }); }

  public async select_option_by_text(selector: string, text: string): Promise<any> { return this._send("select_option_by_text", { selector, text }); }
  public async select_option_by_value(selector: string, value: string): Promise<any> { return this._send("select_option_by_value", { selector, value }); }
  public async select_option_by_index(selector: string, index: number): Promise<any> { return this._send("select_option_by_index", { selector, index }); }

  public async open_new_tab(url: string): Promise<any> { return this._send("open_new_tab", { url }); }
  public async open_new_window(url: string): Promise<any> { return this._send("open_new_window", { url }); }
  public async switch_to_tab(index: number = -1): Promise<any> { return this._send("switch_to_tab", { index }); }
  public async switch_to_window(index: number = -1): Promise<any> { return this._send("switch_to_window", { index }); }
  public async close_active_tab(): Promise<any> { return this._send("close_active_tab"); }
  public async maximize(): Promise<any> { return this._send("maximize"); }
  public async minimize(): Promise<any> { return this._send("minimize"); }
  public async medimize(): Promise<any> { return this._send("medimize"); }
  public async tile_windows(): Promise<any> { return this._send("tile_windows"); }

  public async get_text(selector: string = "body"): Promise<any> { return this._send("get_text", { selector }); }
  public async get_title(): Promise<any> { return this._send("get_title"); }
  public async get_current_url(): Promise<any> { return this._send("get_current_url"); }
  public async get_page_source(): Promise<any> { return this._send("get_page_source"); }
  public async get_html(selector?: string): Promise<any> { return this._send("get_html", { selector }); }
  public async get_attribute(selector: string, attribute: string): Promise<any> { return this._send("get_attribute", { selector, attribute }); }
  public async get_element_attributes(selector: string): Promise<any> { return this._send("get_element_attributes", { selector }); }
  public async get_user_agent(): Promise<any> { return this._send("get_user_agent"); }
  public async get_cookie_string(): Promise<any> { return this._send("get_cookie_string"); }
  public async get_element_rect(selector: string): Promise<any> { return this._send("get_element_rect", { selector }); }
  public async get_window_rect(): Promise<any> { return this._send("get_window_rect"); }
  public async get_screen_rect(): Promise<any> { return this._send("get_screen_rect"); }
  public async is_element_visible(selector: string): Promise<any> { return this._send("is_element_visible", { selector }); }
  public async is_text_visible(text: string): Promise<any> { return this._send("is_text_visible", { text }); }
  public async is_checked(selector: string): Promise<any> { return this._send("is_checked", { selector }); }
  public async is_selected(selector: string): Promise<any> { return this._send("is_selected", { selector }); }
  public async is_online(): Promise<any> { return this._send("is_online"); }
  public async get_performance_metrics(): Promise<any> { return this._send("get_performance_metrics"); }

  public async get_all_cookies(): Promise<any> { return this._send("get_all_cookies"); }
  public async save_cookies(name: string = "cookies.txt"): Promise<any> {
    const res = await this._send("save_cookies");
    if (res.status === "ok" && res.cookies) {
      try {
        fs.writeFileSync(name, JSON.stringify(res.cookies, null, 4));
        return { status: "ok", path: path.resolve(name) };
      } catch (e: any) {
        return { status: "error", error: `Failed to write local file: ${e.message}` };
      }
    }
    return res;
  }
  public async load_cookies(name: string = "cookies.txt", cookies_list?: any[]): Promise<any> {
    let finalCookies = cookies_list;
    if (!finalCookies && name) {
      try {
        if (fs.existsSync(name)) {
          const fileData = fs.readFileSync(name, 'utf-8');
          finalCookies = JSON.parse(fileData);
        } else {
          return { status: "error", error: `Local cookie file not found: ${name}` };
        }
      } catch (e: any) {
        return { status: "error", error: `Failed to read local file: ${e.message}` };
      }
    }
    return this._send("load_cookies", { name, cookies: finalCookies });
  }
  public async clear_cookies(): Promise<any> { return this._send("clear_cookies"); }
  
  public async get_local_storage_item(key: string): Promise<any> { return this._send("get_local_storage_item", { key }); }
  public async set_local_storage_item(key: string, value: string): Promise<any> { return this._send("set_local_storage_item", { key, value }); }
  public async get_session_storage_item(key: string): Promise<any> { return this._send("get_session_storage_item", { key }); }
  public async set_session_storage_item(key: string, value: string): Promise<any> { return this._send("set_session_storage_item", { key, value }); }
  public async export_session(): Promise<any> { return this._send("get_storage_state"); }
  public async import_session(state_dict: any): Promise<any> { return this._send("set_storage_state", { state: state_dict }); }

  public async highlight(selector: string): Promise<any> { return this._send("highlight", { selector }); }
  public async highlight_overlay(selector: string): Promise<any> { return this._send("highlight_overlay", { selector }); }
  public async remove_element(selector: string): Promise<any> { return this._send("remove_element", { selector }); }
  public async flash(selector: string, duration: number = 1): Promise<any> { return this._send("flash", { selector, duration }); }

  public async get_mfa_code(totp_key: string): Promise<any> { return this._send("get_mfa_code", { totp_key }); }
  public async enter_mfa_code(selector: string, totp_key: string): Promise<any> { return this._send("enter_mfa_code", { selector, totp_key }); }
  public async grant_permissions(permissions: string): Promise<any> { return this._send("grant_permissions", { permissions }); }
  public async execute_script(script: string): Promise<any> { return this._send("execute_script", { script }); }
  public async evaluate(expression: string): Promise<any> { return this._send("evaluate", { expression }); }
  public async block_urls(patterns: string[]): Promise<any> { return this._send("block_urls", { patterns }); }

  public async assert_text(text: string, selector: string = "html", screenshot: boolean = true): Promise<any> { return this._handle_assertion("assert_text", { text, selector, screenshot }); }
  public async assert_exact_text(text: string, selector: string = "html", screenshot: boolean = true): Promise<any> { return this._handle_assertion("assert_exact_text", { text, selector, screenshot }); }
  public async assert_element(selector: string, screenshot: boolean = true): Promise<any> { return this._handle_assertion("assert_element", { selector, screenshot }); }
  public async assert_element_present(selector: string, screenshot: boolean = true): Promise<any> { return this._handle_assertion("assert_element_present", { selector, screenshot }); }
  public async assert_element_absent(selector: string, screenshot: boolean = true): Promise<any> { return this._handle_assertion("assert_element_absent", { selector, screenshot }); }
  public async assert_element_not_visible(selector: string, screenshot: boolean = true): Promise<any> { return this._handle_assertion("assert_element_not_visible", { selector, screenshot }); }
  public async assert_text_not_visible(text: string, selector: string = "html", screenshot: boolean = true): Promise<any> { return this._handle_assertion("assert_text_not_visible", { text, selector, screenshot }); }
  public async assert_title(title: string, screenshot: boolean = true): Promise<any> { return this._handle_assertion("assert_title", { title, screenshot }); }
  public async assert_url(url_substring: string, screenshot: boolean = true): Promise<any> { return this._handle_assertion("assert_url", { url: url_substring, screenshot }); }
  public async assert_attribute(selector: string, attribute: string, value: string, screenshot: boolean = true): Promise<any> { return this._handle_assertion("assert_attribute", { selector, attribute, value, screenshot }); }

  public async scroll_into_view(selector: string): Promise<any> { return this._send("scroll_into_view", { selector }); }
  public async scroll_to_bottom(): Promise<any> { return this._send("scroll_to_bottom"); }
  public async scroll_to_top(): Promise<any> { return this._send("scroll_to_top"); }
  public async scroll_down(amount: number = 25): Promise<any> { return this._send("scroll_down", { amount }); }
  public async scroll_up(amount: number = 25): Promise<any> { return this._send("scroll_up", { amount }); }
  public async scroll_to_y(y: number): Promise<any> { return this._send("scroll_to_y", { y }); }
  public async sleep(seconds: number): Promise<any> { return this._send("sleep", { seconds }); }
  public async wait_for_element(selector: string, timeout?: number): Promise<any> { return this._send("wait_for_element", { selector, timeout }); }
  public async wait_for_text(text: string, selector: string = "html", timeout?: number): Promise<any> { return this._send("wait_for_text", { text, selector, timeout }); }
  public async wait_for_element_present(selector: string, timeout?: number): Promise<any> { return this._send("wait_for_element_present", { selector, timeout }); }
  public async wait_for_element_absent(selector: string, timeout?: number): Promise<any> { return this._send("wait_for_element_absent", { selector, timeout }); }
  public async wait_for_network_idle(): Promise<any> { return this._send("wait_for_network_idle"); }
}