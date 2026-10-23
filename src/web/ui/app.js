/* ============================================================
   墨子 Web 客户端
   状态：durable 快照 + 带 seq 的增量事件；缺口即重拉快照。
   ============================================================ */
(() => {
  "use strict";

  // ---------- 常量 ----------
  const STORAGE = {
    session: "mozi.sessionKey",
    theme: "mozi.theme",
    details: "mozi.detailsOpen",
  };
  const FOLLOW_THRESHOLD = 24;
  const RECONNECT_BASE = 500;
  const RECONNECT_MAX = 10000;
  const ELAPSED_HINT_MS = 15000;

  // ---------- 状态 ----------
  const state = {
    ws: null,
    connected: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    pending: new Map(),
    reqId: 0,
    sessions: [],
    sessionKey: null,
    snapshot: null,
    lastSeq: 0,
    /** 按回合、按 step 累积的流式内容 */
    live: new Map(),
    running: false,
    turnStartedAt: null,
    /** 详情栏当前选中项：{ kind: "tool"|"step"|"user"|"turn", turnId, stepId?, callId? } */
    selection: null,
    view: "chat",
    lastTrajectoryRender: 0,
    trajectoryTimer: null,
    follow: true,
    query: "",
    /** 增量渲染：聊天容器与已渲染回合的缓存 */
    chatEl: null,
    turnEls: new Map(),
    renderQueued: false,
    /** 下一次渲染强制滚到底部（发送消息时） */
    forceScroll: false,
  };

  const el = {};
  const $ = (id) => document.getElementById(id);

  // ---------- 工具 ----------
  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function relTime(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function fmtDuration(ms) {
    if (ms === undefined || ms === null) return "";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  }

  // ---------- 轻量 markdown（无外部依赖，默认转义） ----------
  function renderInline(text) {
    let out = escapeHtml(text);
    // 行内代码优先，避免其中的标记被二次处理
    const codes = [];
    out = out.replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
    return out;
  }

  function renderMarkdown(src) {
    const lines = String(src ?? "").split("\n");
    const html = [];
    let i = 0;

    const flushParagraph = (buffer) => {
      if (buffer.length === 0) return;
      html.push(`<p>${buffer.map(renderInline).join("<br>")}</p>`);
      buffer.length = 0;
    };

    let para = [];

    while (i < lines.length) {
      const line = lines[i];

      // 围栏代码块
      const fence = /^```(\w*)\s*$/.exec(line);
      if (fence) {
        flushParagraph(para);
        const lang = fence[1];
        const body = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;
        const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
        html.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
        continue;
      }

      // 标题
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph(para);
        const level = heading[1].length;
        html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        flushParagraph(para);
        html.push("<hr>");
        i += 1;
        continue;
      }

      // 引用
      if (/^>\s?/.test(line)) {
        flushParagraph(para);
        const body = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          body.push(lines[i].replace(/^>\s?/, ""));
          i += 1;
        }
        html.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
        continue;
      }

      // 表格
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        flushParagraph(para);
        const splitRow = (row) =>
          row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
        const body = rows
          .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
          .join("");
        html.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
        continue;
      }

      // 列表
      const listItem = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
      if (listItem) {
        flushParagraph(para);
        const ordered = /\d/.test(listItem[2]);
        const items = [];
        while (i < lines.length) {
          const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
          if (!match || /\d/.test(match[2]) !== ordered) break;
          items.push(`<li>${renderInline(match[3])}</li>`);
          i += 1;
        }
        const tag = ordered ? "ol" : "ul";
        html.push(`<${tag}>${items.join("")}</${tag}>`);
        continue;
      }

      // 空行
      if (line.trim() === "") {
        flushParagraph(para);
        i += 1;
        continue;
      }

      para.push(line);
      i += 1;
    }

    flushParagraph(para);
    return html.join("");
  }

  // ---------- WebSocket ----------
  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      state.reconnectAttempt = 0;
      el.connBanner.dataset.on = "false";

      // 连接建立后再恢复会话，否则 request() 会因为 WS 未就绪而失败
      const pendingKey = state.sessionKey;
      if (pendingKey) {
        switchSession(pendingKey);
      } else {
        loadSessions();
      }
    };

    ws.onclose = () => {
      state.connected = false;
      el.connBanner.dataset.on = "true";
      scheduleReconnect();
    };

    ws.onerror = () => {
      el.connBanner.dataset.on = "true";
    };

    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.type === "res") {
        const pending = state.pending.get(frame.id);
        if (!pending) return;
        state.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.payload);
        else pending.reject(new Error(frame.error?.message || "请求失败"));
      } else if (frame.type === "event") {
        handleEvent(frame.event, frame.payload);
      }
    };
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    const cap = Math.min(RECONNECT_MAX, RECONNECT_BASE * 2 ** state.reconnectAttempt);
    const jitter = cap / 2 + Math.random() * (cap / 2);
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, jitter);
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("未连接到服务器"));
        return;
      }
      const id = String(++state.reqId);
      state.pending.set(id, { resolve, reject });
      state.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  function subscribe(sessionKeys) {
    if (!state.connected || sessionKeys.length === 0) return;
    request("sessions.subscribe", { sessionKeys }).catch(() => {});
  }

  // ---------- 事件处理 ----------
  function handleEvent(name, payload) {
    switch (name) {
      case "connected":
        return;
      case "session.subscribed":
        state.lastSeq = payload.lastSeq;
        return;
      case "session.snapshot":
        if (payload.sessionKey !== state.sessionKey) return;
        applySnapshot(payload.snapshot);
        return;
      case "session.event":
        handleSessionEvent(payload);
        return;
      case "queue_added":
      case "queue_removed":
        refreshSnapshot();
        return;
      case "session.updated":
        // 标题生成是异步的，刷新列表即可
        loadSessions();
        return;
      case "session.status":
        if (payload.sessionKey !== state.sessionKey) return;
        state.running = payload.running;
        if (payload.running && !state.turnStartedAt) state.turnStartedAt = Date.now();
        renderComposer();
        scheduleRender();
        return;
      case "chat.error":
        state.running = false;
        state.live.clear();
        renderComposer();
        scheduleRender();
        return;
      default:
        return;
    }
  }

  function handleSessionEvent(event) {
    if (event.sessionKey !== state.sessionKey) return;

    // seq 缺口 -> 重拉快照，保证不在错误状态上继续追加
    // 瞬时事件（流式增量）不推进序号，也不参与缺口判断
    if (!event.transient) {
      if (event.seq > 0 && state.lastSeq > 0 && event.seq > state.lastSeq + 1) {
        refreshSnapshot();
        return;
      }
      if (event.seq > 0) state.lastSeq = Math.max(state.lastSeq, event.seq);
    }

    switch (event.type) {
      case "turn_start": {
        state.running = true;
        state.turnStartedAt = event.createdAt || Date.now();
        state.live.clear();
        if (!state.snapshot) {
          refreshSnapshot();
          break;
        }
        if (!state.snapshot.turns.some((turn) => turn.turnId === event.turnId)) {
          state.snapshot.turns.push({
            turnId: event.turnId,
            requestId: event.requestId,
            createdAt: event.createdAt,
            content: event.content ?? "",
            steps: [],
            running: true,
            resumed: event.resumed,
          });
        }
        renderComposer();
        scheduleRender();
        break;
      }
      case "step_start": {
        const step = ensureLiveStep(event.turnId, event.stepId);
        step.partial = true;
        scheduleRender();
        break;
      }
      case "text_delta": {
        const step = ensureLiveStep(event.turnId, event.stepId);
        step.text += event.delta;
        scheduleRender();
        break;
      }
      case "thinking_delta": {
        const step = ensureLiveStep(event.turnId, event.stepId);
        step.thinking = (step.thinking || "") + event.delta;
        scheduleRender();
        break;
      }
      case "assistant": {
        const step = ensureLiveStep(event.turnId, event.stepId);
        step.text = event.text;
        step.thinking = event.thinking;
        step.partial = event.partial;
        scheduleRender();
        break;
      }
      case "tool_start": {
        const step = ensureLiveStep(event.turnId, event.stepId);
        step.tools.push({
          type: "tool",
          callId: event.callId,
          name: event.name,
          args: event.args,
          state: "running",
        });
        scheduleRender();
        break;
      }
      case "tool_update": {
        const tool = findLiveTool(event.callId);
        if (tool) tool.text = event.text;
        scheduleRender();
        break;
      }
      case "tool_end": {
        const tool = findLiveTool(event.callId);
        if (tool) {
          tool.text = event.text ?? tool.text;
          tool.isError = event.isError;
          tool.state = event.isError ? "error" : "done";
          tool.durationMs = event.durationMs;
        }
        scheduleRender();
        break;
      }
      case "turn_end": {
        state.running = false;
        state.turnStartedAt = null;
        state.live.clear();
        renderComposer();
        refreshSnapshot();
        loadSessions();
        break;
      }
      case "reset": {
        state.live.clear();
        state.snapshot = null;
        refreshSnapshot();
        break;
      }
      default:
        break;
    }
  }

  function ensureLiveStep(turnId, stepId) {
    const key = `${turnId}:${stepId}`;
    let step = state.live.get(key);
    if (!step) {
      step = { turnId, stepId, text: "", thinking: "", partial: true, tools: [] };
      state.live.set(key, step);
    }
    return step;
  }

  function findLiveTool(callId) {
    for (const step of state.live.values()) {
      const tool = step.tools.find((candidate) => candidate.callId === callId);
      if (tool) return tool;
    }
    return null;
  }

  function applySnapshot(snapshot) {
    state.snapshot = snapshot;
    state.lastSeq = snapshot?.seq ?? 0;
    state.running = Boolean(snapshot?.running);
    state.live.clear();

    if (state.running) {
      const runningTurn = snapshot.turns.find((turn) => turn.running);
      state.turnStartedAt = runningTurn?.createdAt ?? Date.now();
      // 从快照里恢复未完成的 step，让刷新后能继续流式渲染
      for (const turn of snapshot.turns) {
        if (!turn.running) continue;
        for (const step of turn.steps) {
          if (!step.partial) continue;
          const key = `${turn.turnId}:${step.stepId}`;
          state.live.set(key, {
            turnId: turn.turnId,
            stepId: step.stepId,
            text: step.text,
            thinking: step.thinking || "",
            partial: true,
            tools: step.tools.slice(),
          });
        }
      }
    } else {
      state.turnStartedAt = null;
    }

    scheduleRender();
    renderComposer();
    renderTrajectory();
  }

  async function refreshSnapshot() {
    if (!state.sessionKey) return;
    try {
      const result = await request("sessions.history", { sessionKey: state.sessionKey });
      applySnapshot(result.snapshot);
    } catch {
    }
  }

  // ---------- 会话 ----------
  async function loadSessions() {
    try {
      const result = await request("sessions.list", { limit: 100 });
      state.sessions = result.sessions || [];
      renderSessions();
    } catch {
    }
  }

  function renderSessions() {
    const query = state.query.toLowerCase();
    const sessions = state.sessions.filter((session) => {
      if (!session.messageCount && !session.turnCount) return false;
      if (!query) return true;
      return (
        (session.label || "").toLowerCase().includes(query) ||
        session.sessionKey.toLowerCase().includes(query)
      );
    });

    if (sessions.length === 0) {
      el.sessionList.innerHTML = `<div class="empty-hint">${
        state.query ? "没有匹配的会话" : "暂无历史会话"
      }</div>`;
      el.sessionCount.textContent = "0 个会话";
      return;
    }

    el.sessionCount.textContent = `${sessions.length} 个会话`;
    el.sessionList.innerHTML = sessions
      .map((session) => {
        const active = session.sessionKey === state.sessionKey;
        const title = session.label || session.sessionKey.replace(/^webchat:/, "").slice(0, 18);
        const statusState = session.running
          ? "running"
          : session.turnCount > 0
            ? "done"
            : "idle";
        return `
        <div class="session-item" data-key="${escapeHtml(session.sessionKey)}" data-active="${active}"
             title="${escapeHtml(session.label || session.sessionKey)}">
          <span class="mz-dot" data-state="${statusState}"></span>
          <span class="session-title">${escapeHtml(title)}</span>
          <span class="session-time">${relTime(session.updatedAt)}</span>
          <button class="session-del" data-del="${escapeHtml(session.sessionKey)}" title="删除会话" aria-label="删除会话">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M3 4h10M6.5 4V2.5h3V4M5 4l.6 9h4.8L11 4"/>
            </svg>
          </button>
        </div>`;
      })
      .join("");

    el.sessionList.querySelectorAll(".session-item").forEach((node) => {
      node.addEventListener("click", (event) => {
        if (event.target.closest("[data-del]")) return;
        switchSession(node.dataset.key);
      });
    });
    el.sessionList.querySelectorAll("[data-del]").forEach((node) => {
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteSession(node.dataset.del);
      });
    });
  }

  async function switchSession(sessionKey) {
    if (!sessionKey) return;
    state.sessionKey = sessionKey;
    localStorage.setItem(STORAGE.session, sessionKey);
    state.snapshot = null;
    state.live.clear();
    state.chatEl = null;
    state.turnEls.clear();
    renderSessions();
    scheduleRender();

    try {
      const result = await request("sessions.restore", { sessionKey });
      applySnapshot(result.snapshot);
      subscribe([sessionKey]);
      renderTopbar();
      // 启动时只走了恢复分支，这里补上列表加载
      await loadSessions();
    } catch (error) {
      console.warn("打开会话失败:", error);
      if (!localStorage.getItem(STORAGE.session)) state.sessionKey = null;
      renderDetails();
    }
    if (window.innerWidth <= 640) document.querySelector(".app").dataset.sidebar = "collapsed";
  }

  async function deleteSession(sessionKey) {
    if (!confirm("删除这个会话？转录会保留为归档。")) return;
    try {
      await request("sessions.delete", { sessionKey });
      if (state.sessionKey === sessionKey) {
        state.sessionKey = null;
        state.snapshot = null;
        localStorage.removeItem(STORAGE.session);
        scheduleRender();
        renderTopbar();
      }
      loadSessions();
    } catch {
    }
  }

  async function newSession() {
    try {
      const result = await request("chat.clear");
      state.sessionKey = result.sessionKey;
      state.snapshot = null;
      state.live.clear();
      state.lastSeq = 0;
      localStorage.setItem(STORAGE.session, result.sessionKey);
      subscribe([result.sessionKey]);
      scheduleRender();
      renderTopbar();
      await loadSessions();
    } catch {
    }
  }

  // ---------- 渲染：会话 ----------
  function renderTopbar() {
    const title = state.sessionKey
      ? state.sessionKey.replace(/^webchat:/, "")
      : "新对话";
    el.topbarTitle.textContent = title;
    const model = state.snapshot?.turns.find((turn) => turn.model)?.model;
    el.topbarSub.textContent = model ? model : "durable session";
  }

  // ---------- 渲染：对话 ----------
  function toolSummary(tool) {
    const args = tool.args || {};
    const candidate =
      args.path ?? args.file_path ?? args.command ?? args.query ?? args.pattern ?? args.url ?? args.name;
    if (typeof candidate !== "string") return "";
    const flat = candidate.replace(/\s+/g, " ").trim();
    return flat.length > 72 ? `${flat.slice(0, 72)}…` : flat;
  }

  function toolIcon(name) {
    const n = String(name).toLowerCase();
    if (n.includes("bash") || n.includes("shell") || n.includes("exec")) return "⌘";
    if (n.includes("read") || n.includes("write") || n.includes("edit") || n.includes("patch")) return "▤";
    if (n.includes("grep") || n.includes("glob") || n.includes("search")) return "⌕";
    if (n.includes("web") || n.includes("fetch")) return "◈";
    if (n.includes("browser")) return "◐";
    return "◆";
  }

  function renderToolBody(tool) {
    const name = String(tool.name || "").toLowerCase();
    const args = tool.args || {};
    const output = tool.text || "";

    // bash：终端块
    if (name.includes("bash") || name.includes("shell") || name.includes("exec")) {
      const command = typeof args.command === "string" ? args.command : "";
      return `
        <div class="term"><div class="term-cmd">${escapeHtml(command)}</div>${escapeHtml(output)}</div>`;
    }

    // 文件改动：差异
    if (name.includes("edit") || name.includes("write") || name.includes("patch")) {
      const path = args.path || args.file_path || "";
      const oldText = typeof args.old_string === "string" ? args.old_string : "";
      const newText = typeof args.new_string === "string" ? args.new_string : "";
      if (oldText || newText) {
        return `
          <div class="diff">
            <div class="diff-file">${escapeHtml(path)}</div>
            ${oldText.split("\n").map((line) => `<div class="diff-line" data-kind="del"><span class="diff-sign">-</span>${escapeHtml(line)}</div>`).join("")}
            ${newText.split("\n").map((line) => `<div class="diff-line" data-kind="add"><span class="diff-sign">+</span>${escapeHtml(line)}</div>`).join("")}
          </div>
          ${output ? `<div style="margin-top:10px"><div class="tool-label">结果</div><div class="tool-pre">${escapeHtml(output)}</div></div>` : ""}`;
      }
      return `
        <div class="tool-pre">${escapeHtml(JSON.stringify(args, null, 2))}</div>
        ${output ? `<div style="margin-top:10px"><div class="tool-label">结果</div><div class="tool-pre">${escapeHtml(output)}</div></div>` : ""}`;
    }

    // read：带行号
    if (name === "read" || name.includes("read_file")) {
      const start = Number(args.offset || args.start || 1);
      const lines = output.split("\n");
      return `
        <div class="tool-pre">${lines
          .map((line, index) => `${String(start + index).padStart(4, " ")}  ${escapeHtml(line)}`)
          .join("\n")}</div>`;
    }

    // 默认：IN / OUT
    return `
      <div class="tool-inout">
        <div>
          <div class="tool-label">输入</div>
          <div class="tool-pre">${escapeHtml(JSON.stringify(args, null, 2))}</div>
        </div>
        ${
          output
            ? `<div><div class="tool-label">输出</div><div class="tool-pre">${escapeHtml(output)}</div></div>`
            : ""
        }
      </div>`;
  }

  function renderTool(tool, keyPrefix) {
    const statusText =
      tool.state === "running"
        ? "运行中"
        : tool.state === "error"
          ? "失败"
          : tool.state === "interrupted"
            ? "已中断"
            : fmtDuration(tool.durationMs) || "完成";
    const selected = state.selection?.kind === "tool" && state.selection.callId === tool.callId;
    return `
      <div class="tool" data-state="${tool.state}" data-open="${selected}" data-call="${escapeHtml(tool.callId)}">
        <div class="tool-head" data-toggle="${escapeHtml(keyPrefix)}">
          <span class="tool-icon">${toolIcon(tool.name)}</span>
          <span class="tool-name">${escapeHtml(tool.name)}</span>
          <span class="tool-sep">·</span>
          <span class="tool-summary">${escapeHtml(toolSummary(tool))}</span>
          <span class="tool-status">${statusText}</span>
        </div>
        <div class="tool-body">${renderToolBody(tool)}</div>
      </div>`;
  }

  function renderStep(step, turn) {
    const parts = [];
    if (step.thinking) {
      const latestLine = step.thinking.trim().split("\n").filter(Boolean).pop() || "";
      parts.push(`
        <div class="think" data-open="false">
          <div class="think-head">
            <svg class="think-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 4l4 4-4 4"/></svg>
            <span>思考</span>
            <span class="think-latest">${escapeHtml(latestLine)}</span>
          </div>
          <div class="think-body">${escapeHtml(step.thinking)}</div>
        </div>`);
    }
    if (step.text) {
      // 不要给正文套渐变扫光：它会把 color 设为 transparent，
      // 内联代码等子元素会继承成透明文字（表现为一块纯色方块）。
      const cls = "msg-body";
      parts.push(`<div class="${cls}">${renderMarkdown(step.text)}</div>`);
    }
    for (const tool of step.tools || []) {
      parts.push(renderTool(tool, `${turn.turnId}:${step.stepId}:${tool.callId}`));
    }
    return parts.join("");
  }

  /** 合并流式中的 step；聊天与轨迹共用，避免两处视图不一致 */
  function stepsForTurn(turn) {
    const steps = turn.steps.map((step) => ({ ...step, tools: step.tools.slice() }));
    if (!state.running) return steps;

    for (const live of state.live.values()) {
      if (live.turnId !== turn.turnId) continue;
      const existing = steps.find((step) => step.stepId === live.stepId);
      if (existing) {
        existing.text = live.text;
        existing.thinking = live.thinking;
        existing.partial = live.partial;
        existing.tools = live.tools;
      } else {
        steps.push(live);
      }
    }
    return steps;
  }

  function renderTurn(turn) {
    const steps = stepsForTurn(turn);

    const elapsed =
      turn.running && state.turnStartedAt ? fmtDuration(Date.now() - state.turnStartedAt) : "";
    const showElapsed = turn.running && Date.now() - (state.turnStartedAt || Date.now()) > ELAPSED_HINT_MS;

    const meta = [];
    if (turn.resumed) meta.push("已从上次中断恢复");
    if (turn.reason === "interrupted") meta.push("被中断");
    if (turn.reason === "aborted") meta.push("已取消");
    if (turn.reason === "error") meta.push(`失败：${turn.error || ""}`);
    if (turn.usage) meta.push(`${turn.usage.totalTokens} tokens`);
    if (turn.model) meta.push(turn.model);

    const runningLine = turn.running
      ? `<div class="msg-meta"><span class="mz-dot" data-state="running"></span><span class="${showElapsed ? "" : "mz-shimmer"}">${
          showElapsed ? `思考中 · ${elapsed}` : "正在处理"
        }</span></div>`
      : meta.length > 0
        ? `<div class="msg-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("<span>·</span>")}</div>`
        : "";

    return `
        <div class="msg-user">
          <div class="bubble">${escapeHtml(turn.content)}</div>
        </div>
        <div class="msg-steps">
          ${steps.map((step) => renderStep(step, turn)).join("")}
        </div>
        ${runningLine}`;
  }

  /** 合并同一帧内的多次渲染请求 */
  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderChatNow();
    });
  }

  /** 当前是否贴在底部（渲染前调用，避免被新内容的高度影响） */
  function isAtBottom() {
    return (
      el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight <=
      FOLLOW_THRESHOLD
    );
  }

  /**
   * 增量渲染：
   * 只更新内容变化的回合，其余 DOM 原样保留。
   * 全量 innerHTML 会重置滚动位置、丢掉展开状态，流式输出时表现为"不跟随"。
   */
  function renderChatNow() {
    // 视图互斥：轨迹视图只渲染表格，避免每帧重建聊天 DOM 再被覆盖
    if (state.view === "trajectory") {
      renderTrajectory();
      return;
    }

    const turns = state.snapshot?.turns ?? [];

    if (turns.length === 0 && !state.running) {
      state.turnEls.clear();
      state.chatEl = null;
      el.chatScroll.innerHTML = renderHero();
      renderTrajectory();
      return;
    }

    // state.follow 是唯一权威：只有用户向上滚动或点击"回到最新"时才改变它
    const stick = state.forceScroll || state.follow;
    state.forceScroll = false;

    if (!state.chatEl || !state.chatEl.isConnected) {
      el.chatScroll.innerHTML = "";
      state.chatEl = document.createElement("div");
      state.chatEl.className = "chat";
      el.chatScroll.appendChild(state.chatEl);
      state.turnEls.clear();
    }

    const seen = new Set();
    let index = 0;
    for (const turn of turns) {
      seen.add(turn.turnId);
      const html = renderTurn(turn);
      let entry = state.turnEls.get(turn.turnId);

      if (!entry) {
        const node = document.createElement("section");
        node.className = "msg";
        node.dataset.turn = turn.turnId;
        node.innerHTML = html;
        entry = { node, html };
        state.turnEls.set(turn.turnId, entry);
      } else if (entry.html !== html) {
        entry.node.innerHTML = html;
        entry.html = html;
      }

      // 保持顺序；节点已就位时不移动，避免无谓的重排
      if (state.chatEl.children[index] !== entry.node) {
        state.chatEl.insertBefore(entry.node, state.chatEl.children[index] ?? null);
      }

      // 重建 HTML 后恢复选中工具的展开态
      if (state.selection?.kind === "tool" && state.selection.callId) {
        const selected = entry.node.querySelector(`.tool[data-call="${CSS.escape(state.selection.callId)}"]`);
        if (selected) selected.dataset.open = "true";
      }

      index += 1;
    }

    for (const [turnId, entry] of state.turnEls) {
      if (seen.has(turnId)) continue;
      entry.node.remove();
      state.turnEls.delete(turnId);
    }

    // 内容更新后一次性调整滚动位置
    if (stick) {
      el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
    }
    state.follow = stick;
    $("scrollBottom").dataset.on = stick ? "false" : "true";
  }

  function renderHero() {
    return `
      <div class="hero">
        ${window.__MOZI_MARK__ || ""}
        <div class="hero-title">开始一个新的对话</div>
        <div class="hero-sub">回合、工具调用与流式输出都会写入持久日志，刷新或重启后可以继续。</div>
        <div class="hero-cards">
          <button class="hero-card" data-prompt="帮我总结这个仓库的架构，并指出三个可以改进的地方。">🧭 分析仓库架构</button>
          <button class="hero-card" data-prompt="检查最近的改动，找出一处可能的 bug。">🐛 排查潜在 bug</button>
          <button class="hero-card" data-prompt="为当前项目写一个简短的 README。">📄 生成 README</button>
        </div>
      </div>`;
  }

  // ---------- 渲染：轨迹视图 ----------
  function renderTrajectory(force = false) {
    if (state.view !== "trajectory") return;

    // 流式期间事件很密，轨迹表是只读账本，200ms 刷新一次足够
    const now = Date.now();
    if (!force && now - state.lastTrajectoryRender < 200) {
      if (!state.trajectoryTimer) {
        state.trajectoryTimer = setTimeout(() => {
          state.trajectoryTimer = null;
          renderTrajectory(true);
        }, 200);
      }
      return;
    }
    state.lastTrajectoryRender = now;
    const turns = state.snapshot?.turns ?? [];

    // 轨迹视图直接替换容器内容，聊天视图的缓存必须失效
    state.chatEl = null;
    state.turnEls.clear();

    if (turns.length === 0) {
      el.chatScroll.innerHTML = `<div class="hero"><div class="hero-title">暂无轨迹</div><div class="hero-sub">发送一条消息后会在这里显示回合、step 与工具调用的完整记录。</div></div>`;
      return;
    }

    const rows = [];
    turns.forEach((turn, turnIndex) => {
      const duration = turn.endedAt ? fmtDuration(turn.endedAt - turn.createdAt) : "进行中";
      rows.push(`
        <tr class="traj-turn" data-traj-turn="${escapeHtml(turn.turnId)}">
          <td colspan="4">
            <span class="mz-dot" data-state="${turn.running ? "running" : turn.reason === "completed" ? "done" : "error"}"></span>
            <strong>回合 ${turnIndex + 1}</strong>
            <span class="traj-dim">${duration}</span>
            <span class="traj-dim">${turn.steps.length} step · ${turn.steps.reduce((n, step) => n + step.tools.length, 0)} 工具</span>
          </td>
        </tr>
        <tr class="traj-row traj-user" data-traj-user="${escapeHtml(turn.turnId)}">
          <td class="traj-idx">${turnIndex + 1}.0</td>
          <td>用户输入</td>
          <td class="traj-content traj-wrap" colspan="2">${escapeHtml(turn.content || "（空）")}</td>
        </tr>`);

      stepsForTurn(turn).forEach((step, stepIndex) => {
        rows.push(`
          <tr class="traj-row" data-traj-step="${escapeHtml(step.stepId)}" data-traj-step-turn="${escapeHtml(turn.turnId)}">
            <td class="traj-idx">${turnIndex + 1}.${stepIndex + 1}</td>
            <td>模型输出</td>
            <td class="traj-content">${escapeHtml((step.text || step.thinking || "").slice(0, 140) || "—")}</td>
            <td class="traj-dim">${step.partial ? "流式" : "完成"}</td>
          </tr>`);

        for (const tool of step.tools) {
          rows.push(`
            <tr class="traj-row traj-tool" data-traj-call="${escapeHtml(tool.callId)}">
              <td class="traj-idx">${turnIndex + 1}.${stepIndex + 1}</td>
              <td>${toolIcon(tool.name)} ${escapeHtml(tool.name)}</td>
              <td class="traj-content">${escapeHtml(toolSummary(tool))}</td>
              <td class="traj-dim">${
                tool.state === "running" ? "运行中" : fmtDuration(tool.durationMs) || tool.state
              }</td>
            </tr>`);
        }
      });
    });

    el.chatScroll.innerHTML = `
      <div class="chat">
        <table class="traj">
          <thead><tr><th>序号</th><th>事件</th><th>内容</th><th>耗时</th></tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>`;
  }

  // ---------- 渲染：详情栏 ----------
  /** 打开详情栏（选中某处时自动展开） */
  function openDetails() {
    if (!el.app) return;
    el.app.dataset.details = "open";
    localStorage.setItem(STORAGE.details, "open");
  }

  /** 选中详情项；allowToggle 仅用于对话里的工具卡片 */
  function select(selection, allowToggle = false) {
    if (!selection) return;

    const same =
      state.selection &&
      state.selection.kind === selection.kind &&
      state.selection.turnId === selection.turnId &&
      state.selection.stepId === selection.stepId &&
      state.selection.callId === selection.callId;

    if (allowToggle && same) {
      state.selection = null;
      document.querySelectorAll(".tool[data-call]").forEach((node) => {
        node.dataset.open = "false";
      });
      renderDetails();
      return;
    }

    state.selection = selection;

    // 对话视图里同步展开对应的工具卡片
    const callId = selection.kind === "tool" ? selection.callId : null;
    document.querySelectorAll(".tool[data-call]").forEach((node) => {
      node.dataset.open = callId && node.dataset.call === callId ? "true" : "false";
    });

    openDetails();
    renderDetails();
  }

  /** 在快照/流式内容里查找工具调用 */
  function findTool(callId) {
    for (const turn of state.snapshot?.turns ?? []) {
      for (const step of turn.steps) {
        const tool = step.tools.find((candidate) => candidate.callId === callId);
        if (tool) return { tool, turn, step };
      }
    }
    for (const live of state.live.values()) {
      const tool = live.tools.find((candidate) => candidate.callId === callId);
      if (tool) return { tool, turn: state.snapshot?.turns.find((t) => t.turnId === live.turnId), step: live };
    }
    return null;
  }

  function findTurn(turnId) {
    return state.snapshot?.turns.find((turn) => turn.turnId === turnId) ?? null;
  }

  function findStep(turnId, stepId) {
    const turn = findTurn(turnId);
    const step = turn?.steps.find((candidate) => candidate.stepId === stepId);
    return step ? { turn, step } : null;
  }

  function section(title, bodyHtml) {
    return `<div><div class="detail-section-title">${escapeHtml(title)}</div>${bodyHtml}</div>`;
  }

  function renderDetails() {
    const selection = state.selection;
    if (!selection) {
      el.detailsBody.innerHTML = `<div class="details-empty">点击工具、模型输出或用户输入查看详情</div>`;
      return;
    }

    if (selection.kind === "user") {
      const turn = findTurn(selection.turnId);
      if (!turn) {
        el.detailsBody.innerHTML = `<div class="details-empty">该回合不在当前会话中</div>`;
        return;
      }
      el.detailsBody.innerHTML =
        section(
          "用户输入",
          `<div class="detail-text">${escapeHtml(turn.content || "（空）")}</div>`
        ) +
        section("时间", `<div class="detail-meta">${new Date(turn.createdAt).toLocaleString("zh-CN")}</div>`);
      return;
    }

    if (selection.kind === "step") {
      const found = findStep(selection.turnId, selection.stepId);
      if (!found) {
        el.detailsBody.innerHTML = `<div class="details-empty">该 step 不在当前会话中</div>`;
        return;
      }
      const { step } = found;
      el.detailsBody.innerHTML =
        section(
          "模型输出",
          step.text
            ? `<div class="detail-text markdown">${renderMarkdown(step.text)}</div>`
            : `<div class="details-empty">（无文本）</div>`
        ) +
        (step.thinking
          ? section("思考", `<div class="detail-text detail-think">${escapeHtml(step.thinking)}</div>`)
          : "") +
        section(
          "状态",
          `<div class="detail-meta">${step.partial ? "流式中" : "已完成"} · ${step.tools.length} 次工具调用</div>`
        );
      return;
    }

    if (selection.kind === "turn") {
      const turn = findTurn(selection.turnId);
      if (!turn) {
        el.detailsBody.innerHTML = `<div class="details-empty">该回合不在当前会话中</div>`;
        return;
      }
      const duration = turn.endedAt ? fmtDuration(turn.endedAt - turn.createdAt) : "进行中";
      const lines = [
        `状态：${turn.reason ?? "运行中"}`,
        `耗时：${duration}`,
        turn.model ? `模型：${turn.model}` : "",
        turn.usage ? `tokens：${turn.usage.totalTokens}` : "",
        turn.error ? `错误：${turn.error}` : "",
        `step 数：${turn.steps.length}`,
        `工具调用：${turn.steps.reduce((sum, step) => sum + step.tools.length, 0)}`,
      ].filter(Boolean);
      el.detailsBody.innerHTML =
        section("回合", `<div class="detail-text">${escapeHtml(turn.content || "（空）")}</div>`) +
        section("概览", `<div class="detail-meta">${lines.map(escapeHtml).join("<br>")}</div>`);
      return;
    }

    // 工具调用
    const found = findTool(selection.callId);
    if (!found) {
      el.detailsBody.innerHTML = `<div class="details-empty">该调用不在当前会话中</div>`;
      return;
    }
    const { tool } = found;
    el.detailsBody.innerHTML = `
      <div>
        <div class="detail-section-title">工具</div>
        <div class="mz-row mz-gap-8">
          <span class="tool-icon">${toolIcon(tool.name)}</span>
          <strong>${escapeHtml(tool.name)}</strong>
          <span class="mz-dot" data-state="${
            tool.state === "running" ? "running" : tool.state === "error" || tool.state === "interrupted" ? "error" : "done"
          }"></span>
        </div>
      </div>
      <div>
        <div class="detail-section-title">输入</div>
        <div class="tool-pre">${escapeHtml(JSON.stringify(tool.args ?? {}, null, 2))}</div>
      </div>
      <div>
        <div class="detail-section-title">输出</div>
        <div class="tool-pre">${escapeHtml(tool.text || "（暂无输出）")}</div>
      </div>`;
  }

  // ---------- 渲染：输入区 ----------
  /** 渲染队列停靠栏（运行中提示 + 排队消息） */
  function renderQueueDock() {
    const docks = $("composerDocks");
    if (!docks) return;

    const queued = state.snapshot?.queued ?? [];
    const parts = [];

    if (state.running) {
      parts.push(
        `<div class="dock-line"><span class="mz-dot" data-state="running"></span>回合进行中 · Enter 排队，停止按钮可中断</div>`
      );
    }

    if (queued.length > 0) {
      parts.push(`<div class="dock" data-open="true">
        <div class="dock-head"><span>排队中 ${queued.length} 条</span></div>
        <div class="dock-body">
          ${queued
            .map(
              (item) => `<div class="dock-item" data-queue="${escapeHtml(item.id)}">
                <span class="mz-grow">${escapeHtml(item.content)}</span>
                ${item.behavior === "steer" ? `<span class="dock-tag">插入</span>` : ""}
                ${item.behavior === "steer" ? "" : `<button class="dock-act" data-queue-act="steer">插入</button>`}
                <button class="dock-act" data-queue-act="delete">删除</button>
              </div>`
            )
            .join("")}
        </div>
      </div>`);
    }

    docks.innerHTML = parts.join("");
  }

  function renderComposer() {
    renderQueueDock();
    const running = state.running;
    el.sendBtn.dataset.mode = running ? "stop" : "send";
    el.sendBtn.title = running ? "停止" : "发送";
    el.sendBtn.innerHTML = running
      ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="1.6"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.8 7.2L8 3l4.2 4.2"/></svg>`;
  }

  function autoResize() {
    el.input.style.height = "auto";
    el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
  }

  async function send() {
    const message = el.input.value.trim();
    if (!message) return;

    el.input.value = "";
    autoResize();

    // 回合运行中：默认排队，不打断当前回合（要中断请按停止按钮）
    if (state.running) {
      try {
        await request("chat.send", {
          message,
          sessionKey: state.sessionKey,
          whenBusy: "followUp",
        });
        await refreshSnapshot();
      } catch (error) {
        el.input.value = message;
        autoResize();
      }
      return;
    }

    // 未绑定会话时先建一个，确保事件有归属
    if (!state.sessionKey) {
      try {
        const result = await request("chat.clear");
        state.sessionKey = result.sessionKey;
        localStorage.setItem(STORAGE.session, result.sessionKey);
        subscribe([state.sessionKey]);
      } catch (error) {
        alert(`无法创建会话：${error.message}`);
        return;
      }
    }

    state.follow = true;
    state.forceScroll = true;
    try {
      await request("chat.send", {
        message,
        sessionKey: state.sessionKey,
        requestId: crypto.randomUUID(),
      });
      setTimeout(refreshSnapshot, 60);
    } catch (error) {
      el.chatScroll.insertAdjacentHTML(
        "beforeend",
        `<div class="chat"><div class="msg"><div class="msg-body" style="color:var(--state-error)">发送失败：${escapeHtml(
          error.message
        )}</div></div></div>`
      );
    }
  }

  // ---------- 主题 ----------
  function applyTheme(theme) {
    const resolved =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;
    document.body.dataset.theme = resolved;
    localStorage.setItem(STORAGE.theme, theme);
    el.themeBtn.title = resolved === "dark" ? "切换到浅色" : "切换到深色";
    el.themeBtn.textContent = resolved === "dark" ? "☀" : "☾";
  }

  // ---------- 启动 ----------
  function bind() {
    el.app = document.querySelector(".app");
    el.sidebar = $("sidebar");
    el.sessionList = $("sessionList");
    el.sessionCount = $("sessionCount");
    el.sessionSearch = $("sessionSearch");
    el.topbarTitle = $("topbarTitle");
    el.topbarSub = $("topbarSub");
    el.connBanner = $("connBanner");
    el.chatScroll = $("chatScroll");
    el.input = $("input");
    el.sendBtn = $("sendBtn");
    el.detailsBody = $("detailsBody");
    el.themeBtn = $("themeBtn");

    $("newSessionBtn").addEventListener("click", newSession);
    $("mobileMenuBtn").addEventListener("click", () => {
      const app = document.querySelector(".app");
      app.dataset.sidebar = app.dataset.sidebar === "expanded" ? "collapsed" : "expanded";
    });
    $("collapseBtn").addEventListener("click", () => {
      el.app.dataset.sidebar =
        el.app.dataset.sidebar === "collapsed" ? "expanded" : "collapsed";
    });
    $("closeDetailsBtn").addEventListener("click", () => {
      state.selection = null;
      el.app.dataset.details = "closed";
      localStorage.setItem(STORAGE.details, "closed");
      scheduleRender();
      renderDetails();
    });

    el.sessionSearch.addEventListener("input", () => {
      state.query = el.sessionSearch.value.trim();
      renderSessions();
    });

    $("composerDocks").addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.closest("[data-queue-act]");
      if (!action) return;

      const item = action.closest("[data-queue]");
      const queueId = item?.dataset.queue;
      if (!queueId) return;

      if (action.dataset.queueAct === "steer") {
        await request("chat.steer", { queueId }).catch(() => {});
      } else {
        await request("chat.dequeue", { queueId }).catch(() => {});
      }
      await refreshSnapshot();
    });

    el.sendBtn.addEventListener("click", send);
    el.input.addEventListener("input", autoResize);
    el.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
      if (event.key === "Escape" && state.running) {
        event.preventDefault();
        request("chat.cancel").catch(() => {});
      }
    });

    // 统一事件委托：增量渲染会替换节点，逐节点绑定会失效
    el.chatScroll.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const heroCard = target.closest(".hero-card");
      if (heroCard) {
        el.input.value = heroCard.dataset.prompt || "";
        autoResize();
        el.input.focus();
        return;
      }

      const thinkHead = target.closest(".think-head");
      if (thinkHead) {
        const parent = thinkHead.parentElement;
        parent.dataset.open = parent.dataset.open === "true" ? "false" : "true";
        return;
      }

      const toolHead = target.closest(".tool-head");
      if (toolHead) {
        const callId = toolHead.closest(".tool")?.dataset.call;
        if (callId) select({ kind: "tool", callId }, true);
        return;
      }

      // 工具卡片内部的点击不要触发选中切换
      if (target.closest(".tool")) return;

      // 轨迹视图：工具 / step / 用户输入 / 回合都能查看详情
      const trajCall = target.closest("[data-traj-call]");
      if (trajCall) {
        select({ kind: "tool", callId: trajCall.dataset.trajCall });
        return;
      }

      const trajStep = target.closest("[data-traj-step]");
      if (trajStep) {
        select({
          kind: "step",
          turnId: trajStep.dataset.trajStepTurn,
          stepId: trajStep.dataset.trajStep,
        });
        return;
      }

      const trajUser = target.closest("[data-traj-user]");
      if (trajUser) {
        select({ kind: "user", turnId: trajUser.dataset.trajUser });
        return;
      }

      const trajTurn = target.closest("[data-traj-turn]");
      if (trajTurn) {
        select({ kind: "turn", turnId: trajTurn.dataset.trajTurn });
        return;
      }
    });

    el.chatScroll.addEventListener("scroll", () => {
      // 轨迹视图替换容器也会触发 scroll，不能让它改掉对话的跟随状态
      if (state.view !== "chat") return;
      const distance = el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight;
      state.follow = distance <= FOLLOW_THRESHOLD;
      $("scrollBottom").dataset.on = state.follow ? "false" : "true";
    });
    $("scrollBottom").addEventListener("click", () => {
      state.follow = true;
      state.forceScroll = true;
      el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
      $("scrollBottom").dataset.on = "false";
    });

    document.querySelectorAll("[data-view]").forEach((node) => {
      node.addEventListener("click", () => {
        state.view = node.dataset.view;
        document.querySelectorAll("[data-view]").forEach((other) => {
          other.dataset.active = String(other === node);
        });
        el.chatScroll.style.paddingTop = state.view === "trajectory" ? "14px" : "24px";
        if (state.view === "trajectory") {
          renderTrajectory(true);
        } else {
          // 从轨迹切回对话：回到最新，避免停在中间
          state.follow = true;
          state.forceScroll = true;
          scheduleRender();
        }
      });
    });

    el.themeBtn.addEventListener("click", () => {
      const current = document.body.dataset.theme;
      applyTheme(current === "dark" ? "light" : "dark");
    });

    const storedDetails = localStorage.getItem(STORAGE.details);
    if (storedDetails === "closed") el.app.dataset.details = "closed";
    el.app.dataset.sidebar = window.innerWidth <= 640 ? "collapsed" : "expanded";

    applyTheme(localStorage.getItem(STORAGE.theme) || "system");
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if ((localStorage.getItem(STORAGE.theme) || "system") === "system") applyTheme("system");
      });

    renderComposer();
    renderDetails();
  }

  function start() {
    bind();
    connect();

    const saved = localStorage.getItem(STORAGE.session);
    if (saved) {
      // 只记录待恢复的会话；真正的恢复在 ws.onopen 里做
      state.sessionKey = saved;
    }
    scheduleRender();
    renderTopbar();

    // 运行中回合的计时刷新
    setInterval(() => {
      if (state.running && state.snapshot) scheduleRender();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
