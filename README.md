<div align="center">
  <h1 align="center">isoAutomate Node.js SDK</h1>
  
  <p align="center">
    <b>The Sovereign Browser Infrastructure & Orchestration Platform</b>
  </p>

  <a href="https://www.npmjs.com/package/isoautomate">
    <img src="https://img.shields.io/npm/v/isoautomate.svg?color=blue" alt="NPM version">
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License">
  </a>
  <a href="https://isoautomate.com/docs">
    <img src="https://img.shields.io/badge/isoAutomate-Official-blue.svg" alt="Documentation">
  </a>
  <a href="https://isoautomate.readthedocs.io/">
    <img src="https://img.shields.io/badge/Docs-ReadTheDocs-blue.svg" alt="ReadTheDocs">
  </a>
</div>

<br />

<div align="center">
<img src="ext/sdk-nodejs.png" alt="isoAutomate Architecture" width="450" />
</div>

---

## Installation

Install the SDK via npm:

```bash
npm install isoautomate

```

## Configuration

The SDK requires a connection to a Redis instance to communicate with the browser engine. You can configure this either via an environment file (.env) or directly in your Node.js code.

**Method A: Environment Variables (.env)**
Create a `.env` file in your project root. This is the recommended way to keep credentials out of your source code. You can use either a single connection string or individual fields.

```ini
# Individual Fields
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=yourpassword
REDIS_DB=0
REDIS_SSL=false

# OR Single Redis URL (overrides individual fields if present)
# REDIS_URL=rediss://:password@host:port/0

```

**Method B: Direct Initialization**

You can pass connection details directly when creating the `BrowserClient` instance.

**Using individual arguments:**

```typescript
import { BrowserClient } from 'isoautomate';

const browser = new BrowserClient({
    redisHost: "localhost",
    redisPort: 6379,
    redisPassword: "yourpassword",
    redisDb: 0,
    redisSsl: true
});

```

**Using a Redis URL:**

```typescript
import { BrowserClient } from 'isoautomate';

const browser = new BrowserClient({
    redisUrl: "rediss://:password@host:port/0"
});

```

## Usage Examples

Browser sessions are managed through the `BrowserClient`. To ensure that browser resources are cleaned up properly on the server, we highly recommend using a `try...finally` block.

### Standard Async/Await Pattern (Recommended)

Using the `finally` block ensures that the browser is automatically released back to the fleet, even if your script crashes or an error occurs.

```typescript
import { BrowserClient } from 'isoautomate';

async function main() {
    const browser = new BrowserClient();

    try {
        // Acquire the browser instance
        // args: (browser_type, video, profile, record)
        await browser.acquire("chrome", true); 
        
        await browser.open_url("[https://example.com](https://example.com)");
        await browser.assert_text("Example Domain");

    } catch (error) {
        console.error("An error occurred:", error);
    } finally {
        // Crucial: Always release to free up slots for other tasks
        const result = await browser.release();
        
        // Video URL is available after release
        if (browser.video_url) {
            console.log(`Session video: ${browser.video_url}`);
        }
    }
}

main();

```

## The Acquire Method

The `acquire()` method is used to claim a browser from your remote fleet. It supports several parameters to customize your environment.

### Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `browser_type` | `string` | `"chrome"` | The browser to use: `chrome`, `brave`, `opera`, or their `_profiled` variants for CDP mode. |
| `video` | `boolean` | `false` | When true, starts an MP4 recording of the browser session. |
| `record` | `boolean` | `false` | When true, records DOM events for session replay. |
| `profile` | `string` | `boolean` | `null` |

### Understanding Persistence (Profiles)

Persistence allows you to resume sessions so you don't have to log in to websites repeatedly.

* **Managed Profile (`true`):** The SDK manages a persistent ID for you locally. It creates a `.iso_profiles` folder in your project to remember which browser belongs to this project.
* **Custom Profile (`"my_account_1"`):** You provide a specific string. This is best for managing multiple different accounts. Any script using the same string will share the same cookies and history.

```typescript
// Example: Using a named profile for a specific social media account
// acquire(type, video, profile, record)
await browser.acquire("chrome", false, "twitter_marketing_account");

```

## Browser Actions

Once you have acquired a browser, you can control it using the following methods.

### 1. Navigation

| Method | Arguments | Description |
| --- | --- | --- |
| `open_url(url)` | `url (string)` | Navigates the browser to the specified website. |
| `reload(ignore_cache, script)` | `ignore_cache (boolean=true)`, `script (string=null)` | Force reloads the page. `ignore_cache` ensures a fresh fetch. `script` runs JS immediately after the reload. |
| `refresh()` | None | Reloads the current page (standard refresh). |
| `go_back()` | None | Navigates to the previous page in history. |
| `go_forward()` | None | Navigates to the next page in history. |
| `internalize_links()` | None | Forces all links on the current page to open in the current tab instead of a new one. |
| `get_navigation_history()` | None | Returns the list of URLs in the current session's history. |

```typescript
// Basic navigation
await browser.open_url("[https://isoautomate.com](https://isoautomate.com)");

// Hard reload with a custom script to hide a banner
await browser.reload(true, "document.querySelector('.banner').style.display='none';");

// Prevent new tabs from popping up
await browser.internalize_links();

```

### 2. Mouse Interactions

These methods handle standard web-element interactions using the browser's automation engine.

| Method | Arguments | Description |
| --- | --- | --- |
| `click(selector, timeout)` | `selector (string)`, `timeout (number=null)` | Clicks an element. `timeout` (seconds) determines how long to wait for the element to appear. |
| `click_if_visible(selector)` | `selector (string)` | Attempts to click an element only if it is visible. Fails silently if not found. |
| `click_visible_elements(selector, limit)` | `selector (string)`, `limit (number=0)` | Clicks all visible instances of a selector. `limit` caps the clicks (0 for all). |
| `click_nth_visible_element(selector, number)` | `selector (string)`, `number (number=1)` | Clicks the specific visible instance (e.g., 2nd button) based on the `number` provided. |
| `click_link(text)` | `text (string)` | Finds a link by its visible text and clicks it. |
| `click_active_element()` | None | Clicks whichever element currently holds the browser's focus. |
| `mouse_click(selector)` | `selector (string)` | Performs a standard mouse click on the targeted element. |
| `nested_click(parent_selector, selector)` | `parent_selector (string)`, `selector (string)` | Finds the parent first, then locates and clicks the child element inside it. |
| `click_with_offset(selector, x, y, center)` | `selector (string)`, `x, y (number)`, `center (boolean=false)` | Clicks at relative coordinates. If `center=true`, x/y are offsets from the element's middle. |

```typescript
// Click a button but wait up to 15 seconds for it to load
await browser.click("#submit-btn", 15);

// Click the 2nd visible 'Add to Cart' button found on a page
await browser.click_nth_visible_element("button.add-to-cart", 2);

// Click exactly 5 pixels from the left and 10 pixels from the top of an element
await browser.click_with_offset("#map-canvas", 5, 10);

```

### 3. Keyboard and Input

These methods provide granular control over how text is entered and how forms are processed, ranging from high-speed data entry to human-simulated typing.

| Method | Arguments | Description |
| --- | --- | --- |
| `type(selector, text, timeout)` | `selector, text (string)`, `timeout (number=null)` | Rapidly enters text into a field. Optional `timeout` waits for the field to appear. |
| `press_keys(selector, text)` | `selector, text (string)` | Simulates individual key presses. This is slower and mimics human behavior. |
| `send_keys(selector, text)` | `selector, text (string)` | Standard automation method to send raw keys to an element. |
| `set_value(selector, text)` | `selector, text (string)` | Directly sets the `value` attribute of an element via the browser's internal API. |
| `clear(selector)` | `selector (string)` | Deletes all current text/content within an input or textarea element. |
| `clear_input(selector)` | `selector (string)` | Specifically targets `<input>` fields to reset their state. |
| `submit(selector)` | `selector (string)` | Triggers the `submit` event for the form containing the specified element. |
| `focus(selector)` | `selector (string)` | Sets the browser's active focus to the specified element, triggering "onfocus" events. |

#### Usage Example:

```typescript
// Use standard 'type' for speed on non-sensitive fields
await browser.type("#search", "isoAutomate documentation", 5);

// Use 'press_keys' for fields that listen for keyup/keydown events (like passwords)
await browser.press_keys("input[name='password']", "securePassword123");

// Clear a field before updating it
await browser.clear("#email-field");
await browser.type("#email-field", "support@isoautomate.com");

// Focus and submit
await browser.focus("#login-btn");
await browser.submit("#login-form");

```

### 4. GUI Actions (OS-Level Control)

GUI actions operate at the **hardware level**. Instead of sending Javascript events through the browser engine, they move a virtual mouse and press virtual keys on the remote machine's operating system.

> **Note:** These actions require a `_profiled` browser engine (e.g., `chrome_profiled`).

| Method | Arguments | Description |
| --- | --- | --- |
| `gui_click_element(selector, timeframe)` | `selector (string)`, `timeframe (number=0.25)` | Physically moves the OS cursor to the element's coordinates and clicks. `timeframe` controls the speed. |
| `gui_click_x_y(x, y, timeframe)` | `x, y (number)`, `timeframe (number=0.25)` | Physically clicks on raw pixel coordinates on the screen. |
| `gui_hover_element(selector)` | `selector (string)` | Physically moves the OS cursor to hover over an element. |
| `gui_drag_and_drop(drag, drop, timeframe)` | `drag, drop (string)`, `timeframe (number=0.35)` | Performs a hardware-level press, drag movement, and release gesture. |
| `gui_write(text)` | `text (string)` | Direct hardware-level keyboard input. This types into the element that currently has the OS focus. |
| `gui_press_keys(keys_list)` | `keys_list (string[])` | Sends a list of specific hardware keys (e.g., `['control', 'c']`). |
| `gui_click_captcha()` | None | Automatically locates the verification checkbox in common captcha widgets and performs a physical OS-level click. |
| `solve_captcha()` | None | A high-level trigger that handles the OS-level movement required to check verification boxes. |

#### High-Fidelity Examples:

```typescript
// Perform a hardware-level click on a button to mimic real human interaction
await browser.gui_click_element("#login-submit", 0.5);

// Drag a physical slider or element
await browser.gui_drag_and_drop("#source-box", "#target-bin");

// Type using the OS virtual keyboard (useful for bypassing JS-level listeners)
await browser.focus("#comment-box");
await browser.gui_write("Typing at the hardware level.");

// Handle verification checkboxes automatically
await browser.solve_captcha();

```

### 5. Selects & Dropdowns

These methods simplify interacting with standard HTML `<select>` elements and custom dropdown menus.

| Method | Arguments | Description |
| --- | --- | --- |
| `select_option_by_text(selector, text)` | `selector, text (string)` | Selects an option from a dropdown list based on the visible text. |
| `select_option_by_value(selector, value)` | `selector, value (string)` | Selects an option based on its internal HTML `value` attribute. |
| `select_option_by_index(selector, index)` | `selector (string)`, `index (number)` | Selects an option based on its position in the list (starting from `0`). |

#### Examples:

```typescript
// Select "United States" from a country list by its visible name
await browser.select_option_by_text("#country-select", "United States");

// Select an option where the HTML looks like <option value="USD">Dollar</option>
await browser.select_option_by_value("#currency", "USD");

// Select the first option in a list
await browser.select_option_by_index("#category", 0);

```

### 6. Window & Tab Management

These methods allow you to orchestrate multiple browser contexts, switch between tabs, and control the physical dimensions of the browser window.

| Method | Arguments | Description |
| --- | --- | --- |
| `open_new_tab(url)` | `url (string)` | Opens a new browser tab and navigates to the specified URL. |
| `open_new_window(url)` | `url (string)` | Opens a completely new browser window instance and navigates to the URL. |
| `switch_to_tab(index)` | `index (number=-1)` | Switches the active focus to a different tab. `0` is the first tab, `-1` is the most recently opened. |
| `switch_to_window(index)` | `index (number=-1)` | Switches focus to a different window instance. |
| `close_active_tab()` | None | Closes the current tab. Focus will automatically shift to the next available tab. |
| `maximize()` | None | Expands the browser window to fill the entire screen. |
| `minimize()` | None | Minimizes the browser window to the taskbar/dock. |
| `medimize()` | None | Resizes the window to a medium, standard size (Requires `_profiled`). |
| `tile_windows()` | None | Organizes all open windows into a grid pattern (Requires `_profiled`). |

```typescript
// Open a second site in a new tab
await browser.open_new_tab("[https://google.com](https://google.com)");

// Switch back to the original tab (first one)
await browser.switch_to_tab(0);

```

### 7. Data Extraction (Getters)

These methods allow you to retrieve data from the remote browser and return it to your local Node.js script for processing.

| Method | Arguments | Description |
| --- | --- | --- |
| `get_text(selector)` | `selector (string="body")` | Retrieves the visible text content of an element. Defaults to the entire page body. |
| `get_title()` | None | Returns the current page title as shown in the browser tab. |
| `get_current_url()` | None | Returns the absolute URL of the page currently being viewed. |
| `get_page_source()` | None | Returns the full raw HTML source code of the current page as a string. |
| `save_page_source(name)` | `name (string="source.html")` | Downloads the full raw HTML source code and saves it to a local file. |
| `get_html(selector)` | `selector (string=null)` | Returns the inner HTML of a specific element. If no selector is provided, returns the `<html>` content. |
| `get_attribute(selector, attr)` | `selector, attr (string)` | Retrieves the value of a specific HTML attribute (e.g., `src`, `href`, `value`). |
| `get_element_attributes(sel)` | `selector (string)` | Returns a dictionary containing all attributes of the targeted element. |
| `get_user_agent()` | None | Returns the User Agent string currently being used by the browser. |
| `get_cookie_string()` | None | Returns all cookies for the current domain formatted as a single string. |
| `get_element_rect(sel)` | `selector (string)` | Returns an object with the element's position and size (`x`, `y`, `width`, `height`). |
| `get_window_rect()` | None | Returns the browser window's current dimensions and position. |
| `is_element_visible(sel)` | `selector (string)` | Returns `true` if the element is currently visible on the screen. |
| `is_text_visible(text)` | `text (string)` | Returns `true` if the specified text is visible anywhere on the page. |
| `get_performance_metrics()` | None | Returns detailed network and rendering performance metrics from the browser engine. |

#### Data Extraction Examples:

```typescript
// Get the price of a product
const price = await browser.get_text(".product-price");

// Extract a link from a button
const downloadUrl = await browser.get_attribute("#download-link", "href");

// Save the full HTML for offline parsing
await browser.save_page_source("debug_page.html");

// Check visibility before interacting
if (await browser.is_element_visible("#cookie-consent")) {
    await browser.click("#accept-all");
}

```

### 8. Cookies & Session Storage

These methods provide direct control over browser cookies and storage, allowing you to manage sessions, bypass logins, or clear tracking data manually.

| Method | Arguments | Description |
| --- | --- | --- |
| `get_all_cookies()` | None | Returns a list of all cookies for the current domain. |
| `get_cookie_string()` | None | Returns all cookies formatted as a single string (useful for header injection). |
| `save_cookies(name)` | `name (string)` | Saves current cookies to a local JSON file. |
| `load_cookies(name)` | `name (string)` | Loads cookies from a local JSON file. |
| `clear_cookies()` | None | Clears all cookies from the current browser session. |
| `get_local_storage_item(key)` | `key (string)` | Retrieves a specific value from `localStorage`. |
| `set_local_storage_item(key, value)` | `key, value (string)` | Sets a specific key-value pair in `localStorage`. |

#### Usage Examples:

```typescript
// Save cookies to a file for later use
const cookies = await browser.get_all_cookies();

// Clear all storage to start a clean session
await browser.clear_cookies();

```

### 9. Wait & Verification (Assertions)

These methods are essential for handling dynamic content. They ensure your script waits for elements to load before interacting, preventing "Element Not Found" errors.

| Method | Arguments | Description |
| --- | --- | --- |
| `sleep(seconds)` | `seconds (number)` | Performs a hard pause for the specified number of seconds. |
| `wait_for_element(selector, timeout)` | `selector (string)`, `timeout (number=null)` | Pauses execution until the element appears in the DOM. |
| `wait_for_text(text, timeout)` | `text (string)`, `timeout (number=null)` | Pauses execution until the specific text is visible on the page. |
| `wait_for_network_idle()` | None | Pauses execution until network activity stops (useful for SPAs). |
| `assert_element(selector)` | `selector (string)` | Validates that an element exists. Throws Error if not found. |
| `assert_text(text, selector)` | `text (string)`, `selector (string="body")` | Validates that specific text exists within a chosen element (default: whole page). |

#### Usage Examples:

```typescript
// Wait for a slow-loading dashboard to appear
await browser.wait_for_element("#dashboard-main", 20);

// Wait for page network activity to settle
await browser.wait_for_network_idle();

// Verify that login was successful
await browser.assert_text("Welcome back, User!", "h1");

// Hard pause (use sparingly)
await browser.sleep(2.5);

```

### 10. Scripting & Advanced Features

These methods allow you to extend the SDK's capabilities by executing custom logic directly within the browser context or retrieving advanced metadata.

| Method | Arguments | Description |
| --- | --- | --- |
| `execute_script(script)` | `script (string)` | Executes raw Javascript within the current page context. |
| `evaluate(expression)` | `expression (string)` | Evaluates a JS expression and returns the value. |
| `execute_cdp_cmd(cmd, params)` | `cmd (string)`, `params (object)` | **God Mode:** Executes raw Chrome DevTools Protocol commands directly. |
| `get_mfa_code(key)` | `key (string)` | Generates a 2FA/TOTP code from a secret key. |
| `enter_mfa_code(selector, key)` | `selector`, `key` | Generates a 2FA code and types it into the selector. |
| `grant_permissions(perms)` | `perms (string)` | Grants browser permissions. |
| `get_performance_metrics()` | None | Returns a detailed object of Chrome performance logs. |
| `highlight(selector)` | `selector (string)` | Visually highlights an element (useful for debugging/video). |
| `internalize_links()` | None | Rewrites `target="_blank"` links to open in the current tab. |
| `get_user_agent()` | None | Retrieves the current browser's User Agent string. |

#### Usage Examples:

```typescript
// Execute JS to get the value of a complex hidden variable
const userId = await browser.execute_script("return window.appConfig.currentUserId;");

// GOD MODE: Clear browser cache directly via CDP
await browser.execute_cdp_cmd("Network.clearBrowserCache", {});

// GOD MODE: Emulate a mobile device metrics
await browser.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
    "width": 375, "height": 812, "deviceScaleFactor": 3, "mobile": true
});

// Highlight an element before clicking it for a better video recording
await browser.highlight("#buy-now-button");
await browser.click("#buy-now-button");

```

### 11. Full Example: Social Media Automation

This example demonstrates a complete workflow: using persistence to stay logged in, performing high-fidelity GUI clicks to bypass detection, and extracting data.

```typescript
import { BrowserClient } from 'isoautomate';

async function runAutomation() {
    const browser = new BrowserClient();

    try {
        // 1. Acquire a browser with a persistent profile for "User_Alpha"
        // We use 'chrome_profiled' to enable hardware-level GUI actions
        await browser.acquire("chrome_profiled", true, "User_Alpha");

        // 2. Navigate and wait for content
        await browser.open_url("[https://example-social-media.com/login](https://example-social-media.com/login)");
        
        // 3. Handle login if not already logged in
        if (await browser.is_text_visible("Sign In")) {
            await browser.type("#username", "my_bot_user");
            await browser.press_keys("#password", "secure_pass_123");
            
            // Use GUI click for the final submit to mimic human behavior
            await browser.gui_click_element("#login-btn");
            
            // Wait for the dashboard to confirm successful login
            await browser.wait_for_element(".dashboard-feed", 15);
        }

        // 4. Interact with the feed
        await browser.gui_hover_element(".first-post");
        await browser.click(".like-button");
        
        // 5. Extract data to your local script
        const postStats = await browser.get_text(".post-stats");
        console.log(`Current Post Stats: ${postStats}`);

    } catch (err) {
        console.error("Automation failed:", err);
    } finally {
        // 6. Release browser and get video
        await browser.release();
        console.log(`View execution recording at: ${browser.video_url}`);
    }
}

runAutomation();

```

## License

This project is licensed under the **MIT License**. See the [LICENSE](https://www.google.com/search?q=LICENSE) file for more details.

## Contributing

We welcome contributions to the isoAutomate Node.js SDK! If you'd like to help improve the platform, please follow these steps:

1. **Fork** the repository.
2. **Create a new feature branch** (`git checkout -b feature/your-feature-name`).
3. **Commit your changes** (`git commit -m 'Add some feature'`).
4. **Push to the branch** (`git push origin feature/your-feature-name`).
5. **Open a Pull Request**.

For major changes, please open an issue first to discuss what you would like to change.

---

<div align="center">
<p>Built for the Sovereign Web. Powered by <b>isoAutomate</b>.</p>
<a href="https://isoautomate.com">Official Website</a> •
<a href="https://isoautomate.com/docs">Full API Reference</a> •
<a href="mailto:support@isoautomate.com">Support</a>
</div>

```
