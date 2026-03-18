/**
 * 内置工具 - 浏览器控制
 *
 * 基于 Playwright 实现的浏览器自动化工具
 * 支持页面导航、截图、内容提取、元素交互等功能
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { jsonResult, errorResult, readStringParam, readNumberParam, readBooleanParam } from "../common.js";

// 浏览器会话状态
interface BrowserSession {
  browser: unknown;
  context: unknown;
  page: unknown;
  refs: Map<string, { role: string; name?: string; nth?: number }>;
  refsMode: "aria" | "role";
}

let browserSession: BrowserSession | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let playwrightModule: any = null;

/** 延迟加载 Playwright */
async function getPlaywright() {
  if (!playwrightModule) {
    try {
      // @ts-ignore - 动态导入可选依赖
      playwrightModule = await import("playwright-core");
    } catch {
      throw new Error("Playwright not installed. Run: npm install playwright-core");
    }
  }
  return playwrightModule;
}

/** 获取或创建浏览器会话 */
async function getBrowserSession(): Promise<BrowserSession> {
  if (browserSession) {
    return browserSession;
  }
  throw new Error("Browser not started. Use 'start' action first.");
}

/** 通过 ref 获取元素定位器 */
function getRefLocator(page: any, ref: string, session: BrowserSession) {
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;

  if (/^e\d+$/i.test(normalized)) {
    const info = session.refs.get(normalized.toLowerCase());
    if (!info) {
      throw new Error(`Unknown ref "${normalized}". Run a new snapshot first.`);
    }
    const locator = info.name
      ? page.getByRole(info.role, { name: info.name, exact: true })
      : page.getByRole(info.role);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }
  return page.locator(ref);
}

/** 解析 aria 快照，生成元素引用 */
function parseAriaSnapshot(snapshot: string): Map<string, { role: string; name?: string; nth?: number }> {
  const refs = new Map<string, { role: string; name?: string; nth?: number }>();
  let refCounter = 1;
  const lines = snapshot.split("\n");
  const roleCounters = new Map<string, Map<string, number>>();

  for (const line of lines) {
    const match = line.match(/^\s*-\s+(\w+)(?:\s+"([^"]*)")?/);
    if (match) {
      const role = match[1] as string;
      const name = match[2] as string | undefined;
      const interactiveRoles = [
        "button", "link", "textbox", "checkbox", "radio", "combobox",
        "listbox", "option", "menuitem", "tab", "switch", "slider",
        "searchbox", "spinbutton", "menuitemcheckbox", "menuitemradio",
        "treeitem", "gridcell", "row", "cell"
      ];

      if (interactiveRoles.includes(role)) {
        const key = `${role}:${name || ""}`;
        if (!roleCounters.has(role)) {
          roleCounters.set(role, new Map<string, number>());
        }
        const roleMap = roleCounters.get(role)!;
        const count = roleMap.get(key) || 0;
        roleMap.set(key, count + 1);

        const refKey = `e${refCounter}`;
        refs.set(refKey, {
          role,
          name: name || undefined,
          nth: count > 0 ? count : undefined,
        });
        refCounter++;
      }
    }
  }
  return refs;
}

/** 生成带 ref 标记的快照文本 */
function generateRefSnapshot(refs: Map<string, { role: string; name?: string; nth?: number }>): string {
  const lines: string[] = [];
  for (const [ref, info] of refs) {
    const nameStr = info.name ? ` "${info.name}"` : "";
    const nthStr = info.nth !== undefined ? ` [${info.nth}]` : "";
    lines.push(`[${ref}] ${info.role}${nameStr}${nthStr}`);
  }
  return lines.join("\n");
}

/** 浏览器控制工具 */
export function createBrowserTool(): AgentTool {
  return {
    name: "browser",
    label: "Browser Control",
    description: `Control a browser for web automation tasks.
Actions: start, stop, navigate, screenshot, snapshot, click, type, hover, drag, press, select, scroll, evaluate, wait, fill
Element Reference: After 'snapshot', use refs like 'e1', 'e2' for interactions.`,
    parameters: Type.Object({
      action: Type.String({ description: "Action: start, stop, navigate, screenshot, snapshot, click, type, hover, drag, press, select, scroll, evaluate, wait, fill" }),
      url: Type.Optional(Type.String({ description: "URL for navigate action" })),
      ref: Type.Optional(Type.String({ description: "Element ref (e.g., 'e1', 'e2') from snapshot" })),
      selector: Type.Optional(Type.String({ description: "CSS selector (fallback if ref not available)" })),
      doubleClick: Type.Optional(Type.Boolean({ description: "Double click instead of single click" })),
      button: Type.Optional(Type.String({ description: "Mouse button: left, right, middle" })),
      modifiers: Type.Optional(Type.Array(Type.String(), { description: "Modifier keys: Alt, Control, Meta, Shift" })),
      text: Type.Optional(Type.String({ description: "Text for type/press action" })),
      slowly: Type.Optional(Type.Boolean({ description: "Type slowly with delay between chars" })),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing" })),
      key: Type.Optional(Type.String({ description: "Key to press (e.g., 'Enter', 'Tab', 'ArrowDown')" })),
      startRef: Type.Optional(Type.String({ description: "Start element ref for drag" })),
      endRef: Type.Optional(Type.String({ description: "End element ref for drag" })),
      values: Type.Optional(Type.Array(Type.String(), { description: "Values to select in dropdown" })),
      fields: Type.Optional(Type.Array(Type.Object({
        ref: Type.String({ description: "Element ref" }),
        type: Type.String({ description: "Field type: text, checkbox, radio" }),
        value: Type.Union([Type.String(), Type.Boolean(), Type.Number()], { description: "Value to fill" }),
      }), { description: "Form fields to fill" })),
      fullPage: Type.Optional(Type.Boolean({ description: "Take full page screenshot" })),
      direction: Type.Optional(Type.String({ description: "Scroll direction: up, down, left, right" })),
      amount: Type.Optional(Type.Number({ description: "Scroll amount in pixels" })),
      waitFor: Type.Optional(Type.String({ description: "Wait condition: selector, text, textGone, timeout, load, network, url" })),
      value: Type.Optional(Type.String({ description: "Value for wait condition" })),
      code: Type.Optional(Type.String({ description: "JavaScript code for evaluate action" })),
      headless: Type.Optional(Type.Boolean({ description: "Run browser headless (default: true)" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true })!;
      const timeout = readNumberParam(params, "timeout", { min: 1000, max: 120000 }) ?? 30000;

      try {
        switch (action) {
          case "start": return await startBrowser(params);
          case "stop": return await stopBrowser();
          case "navigate": return await navigateTo(params, timeout);
          case "screenshot": return await takeScreenshot(params, timeout);
          case "snapshot": return await getSnapshot(params, timeout);
          case "click": return await clickElement(params, timeout);
          case "type": return await typeText(params, timeout);
          case "hover": return await hoverElement(params, timeout);
          case "drag": return await dragElement(params, timeout);
          case "press": return await pressKey(params);
          case "select": return await selectOption(params, timeout);
          case "scroll": return await scrollPage(params, timeout);
          case "evaluate": return await evaluateScript(params, timeout);
          case "wait": return await waitFor(params, timeout);
          case "fill": return await fillForm(params, timeout);
          default: return errorResult(`Unknown action: ${action}`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

async function startBrowser(params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  if (browserSession) return jsonResult({ status: "already_running", message: "Browser is already running" });
  const headless = readBooleanParam(params, "headless") ?? true;
  const playwright = await getPlaywright();

  const browser = await playwright.chromium.launch({ headless, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const context = await (browser as any).newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  browserSession = { browser, context, page, refs: new Map(), refsMode: "role" };
  return jsonResult({ status: "started", headless, viewport: { width: 1280, height: 720 } });
}

async function stopBrowser(): Promise<AgentToolResult<unknown>> {
  if (!browserSession) return jsonResult({ status: "not_running" });
  try { await (browserSession.browser as any).close(); } catch {}
  browserSession = null;
  return jsonResult({ status: "stopped" });
}

async function navigateTo(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const url = readStringParam(params, "url", { required: true })!;
  try { new URL(url); } catch { return errorResult(`Invalid URL: ${url}`); }
  const page = session.page as any;
  await page.goto(url, { timeout, waitUntil: "domcontentloaded" });
  session.refs.clear();
  return jsonResult({ status: "navigated", url: page.url(), title: await page.title() });
}

async function takeScreenshot(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const fullPage = readBooleanParam(params, "fullPage") ?? false;
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  const page = session.page as any;
  let buffer: Buffer;
  if (ref) {
    const locator = getRefLocator(page, ref, session);
    buffer = await locator.screenshot({ type: "png", timeout });
  } else if (selector) {
    buffer = await page.locator(selector).first().screenshot({ type: "png", timeout });
  } else {
    buffer = await page.screenshot({ fullPage, type: "png" });
  }
  return jsonResult({ status: "screenshot_taken", fullPage, size: buffer.length, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` });
}

async function getSnapshot(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const page = session.page as any;
  const title = await page.title();
  const url = page.url();
  let ariaSnapshot = "";
  try { ariaSnapshot = await page.locator("body").ariaSnapshot(); } catch {}
  if (ariaSnapshot) {
    const refs = parseAriaSnapshot(ariaSnapshot);
    session.refs = refs;
    return jsonResult({ status: "snapshot", url, title, elementsCount: refs.size, elements: generateRefSnapshot(refs), ariaSnapshot: ariaSnapshot.slice(0, 8000) });
  }
  const interactiveElements = await page.evaluate(`(() => {
    const elements = [];
    const selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"]';
    const els = document.querySelectorAll(selectors);
    let index = 1;
    els.forEach(el => {
      if (index > 50) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      elements.push({ ref: 'e' + index, tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', text: (el.innerText || el.value || '').slice(0, 50) });
      index++;
    });
    return elements;
  })()`);
  session.refs.clear();
  for (const el of interactiveElements) session.refs.set(el.ref, { role: el.tag === "a" ? "link" : el.tag === "button" ? "button" : el.type || el.tag, name: el.text });
  return jsonResult({ status: "snapshot", url, title, elements: interactiveElements, elementsCount: interactiveElements.length });
}

async function clickElement(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  if (!ref && !selector) return errorResult("Either 'ref' or 'selector' is required");
  const page = session.page as any;
  const locator = ref ? getRefLocator(page, ref, session) : page.locator(selector!);
  const doubleClick = readBooleanParam(params, "doubleClick") ?? false;
  const button = readStringParam(params, "button") as "left" | "right" | "middle" | undefined;
  if (doubleClick) await locator.dblclick({ timeout, button: button || "left" });
  else await locator.click({ timeout, button: button || "left" });
  return jsonResult({ status: "clicked", element: ref || selector });
}

async function typeText(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  const text = readStringParam(params, "text", { required: true })!;
  if (!ref && !selector) return errorResult("Either 'ref' or 'selector' is required");
  const page = session.page as any;
  const locator = ref ? getRefLocator(page, ref, session) : page.locator(selector!);
  const slowly = readBooleanParam(params, "slowly") ?? false;
  const submit = readBooleanParam(params, "submit") ?? false;
  if (slowly) { await locator.click({ timeout }); await locator.type(text, { timeout, delay: 75 }); }
  else await locator.fill(text, { timeout });
  if (submit) await locator.press("Enter", { timeout });
  return jsonResult({ status: "typed", element: ref || selector, text: text.slice(0, 50), submitted: submit });
}

async function hoverElement(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  if (!ref && !selector) return errorResult("Either 'ref' or 'selector' is required");
  const page = session.page as any;
  const locator = ref ? getRefLocator(page, ref, session) : page.locator(selector!);
  await locator.hover({ timeout });
  return jsonResult({ status: "hovered", element: ref || selector });
}

async function dragElement(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const startRef = readStringParam(params, "startRef", { required: true })!;
  const endRef = readStringParam(params, "endRef", { required: true })!;
  const page = session.page as any;
  await getRefLocator(page, startRef, session).dragTo(getRefLocator(page, endRef, session), { timeout });
  return jsonResult({ status: "dragged", from: startRef, to: endRef });
}

async function pressKey(params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const key = readStringParam(params, "key", { required: true })!;
  await (session.page as any).keyboard.press(key);
  return jsonResult({ status: "pressed", key });
}

async function selectOption(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  const values = params.values as string[] | undefined;
  if (!ref && !selector) return errorResult("Either 'ref' or 'selector' is required");
  if (!values?.length) return errorResult("'values' array is required");
  const page = session.page as any;
  const locator = ref ? getRefLocator(page, ref, session) : page.locator(selector!);
  await locator.selectOption(values, { timeout });
  return jsonResult({ status: "selected", element: ref || selector, values });
}

async function scrollPage(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const ref = readStringParam(params, "ref");
  const direction = readStringParam(params, "direction") ?? "down";
  const amount = readNumberParam(params, "amount", { min: 100, max: 10000 }) ?? 500;
  const page = session.page as any;
  if (ref) { await getRefLocator(page, ref, session).scrollIntoViewIfNeeded({ timeout }); return jsonResult({ status: "scrolled", element: ref }); }
  const deltas: Record<string, [number, number]> = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] };
  const [dx, dy] = deltas[direction] ?? [0, amount];
  await page.evaluate(`window.scrollBy(${dx}, ${dy})`);
  return jsonResult({ status: "scrolled", direction, amount });
}

async function evaluateScript(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const code = readStringParam(params, "code", { required: true })!;
  const ref = readStringParam(params, "ref");
  const page = session.page as any;
  const result = ref ? await getRefLocator(page, ref, session).evaluate((el: any, c: string) => eval(c), code) : await page.evaluate(code);
  return jsonResult({ status: "evaluated", result: JSON.stringify(result, null, 2).slice(0, 2000) });
}

async function waitFor(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const waitForCondition = readStringParam(params, "waitFor") ?? "timeout";
  const value = readStringParam(params, "value");
  const page = session.page as any;
  switch (waitForCondition) {
    case "selector": if (!value) return errorResult("Selector required"); await page.waitForSelector(value, { timeout }); return jsonResult({ status: "waited", condition: "selector" });
    case "text": if (!value) return errorResult("Text required"); await page.getByText(value).first().waitFor({ state: "visible", timeout }); return jsonResult({ status: "waited", condition: "text" });
    case "load": await page.waitForLoadState("load", { timeout }); return jsonResult({ status: "waited", condition: "load" });
    case "network": await page.waitForLoadState("networkidle", { timeout }); return jsonResult({ status: "waited", condition: "networkidle" });
    default: await page.waitForTimeout(readNumberParam(params, "amount") ?? 1000); return jsonResult({ status: "waited", condition: "timeout" });
  }
}

async function fillForm(params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const session = await getBrowserSession();
  const fields = params.fields as Array<{ ref: string; type: string; value: string | boolean | number }> | undefined;
  if (!fields?.length) return errorResult("'fields' array is required");
  const page = session.page as any;
  const results: Array<{ ref: string; status: string }> = [];
  for (const field of fields) {
    if (!field.ref || !field.type) { results.push({ ref: field.ref || "unknown", status: "skipped" }); continue; }
    try {
      const locator = getRefLocator(page, field.ref, session);
      if (field.type === "checkbox" || field.type === "radio") await locator.setChecked(field.value === true || field.value === "true", { timeout });
      else await locator.fill(String(field.value), { timeout });
      results.push({ ref: field.ref, status: "filled" });
    } catch (e) { results.push({ ref: field.ref, status: `error: ${e}` }); }
  }
  return jsonResult({ status: "form_filled", fields: results });
}