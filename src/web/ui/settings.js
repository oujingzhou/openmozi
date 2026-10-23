/* ============================================================
   设置页逻辑
   与聊天页共用 WebSocket 协议；配置以草稿形式编辑，保存时只提交改动过的分区。
   ============================================================ */
(() => {
  "use strict";

  // ---------- 元数据 ----------
  const PROVIDER_LABELS = {
    deepseek: "DeepSeek",
    doubao: "豆包",
    minimax: "MiniMax",
    kimi: "Kimi",
    stepfun: "阶跃星辰",
    modelscope: "ModelScope",
    dashscope: "DashScope",
    zhipu: "智谱 AI",
    openai: "OpenAI",
    ollama: "Ollama",
    openrouter: "OpenRouter",
    together: "Together AI",
    groq: "Groq",
    vllm: "vLLM",
    "custom-openai": "自定义 OpenAI 兼容",
    "custom-anthropic": "自定义 Anthropic 兼容",
  };

  const CUSTOM_PROVIDERS = new Set(["custom-openai", "custom-anthropic"]);
  const NEEDS_BASE_URL = new Set([
    "custom-openai",
    "custom-anthropic",
    "openrouter",
    "together",
    "groq",
    "ollama",
    "vllm",
    "openai",
  ]);

  const CHANNELS = [
    {
      id: "feishu",
      name: "飞书",
      fields: [
        { key: "appId", label: "App ID" },
        { key: "appSecret", label: "App Secret", secret: true },
      ],
    },
    {
      id: "dingtalk",
      name: "钉钉",
      fields: [
        { key: "appKey", label: "App Key" },
        { key: "appSecret", label: "App Secret", secret: true },
        { key: "robotCode", label: "Robot Code" },
      ],
    },
    {
      id: "qq",
      name: "QQ",
      fields: [
        { key: "appId", label: "App ID" },
        { key: "clientSecret", label: "Client Secret", secret: true },
        { key: "sandbox", label: "沙箱环境", type: "boolean" },
      ],
    },
    {
      id: "wecom",
      name: "企业微信",
      fields: [
        { key: "corpId", label: "Corp ID" },
        { key: "corpSecret", label: "Corp Secret", secret: true },
        { key: "agentId", label: "Agent ID", type: "number" },
        { key: "token", label: "Token" },
        { key: "encodingAESKey", label: "EncodingAESKey" },
      ],
    },
  ];

  const SECTIONS = [
    { id: "overview", group: "总览", label: "概览" },
    { id: "providers", group: "配置", label: "模型提供商" },
    { id: "agent", group: "配置", label: "Agent" },
    { id: "channels", group: "配置", label: "通讯通道" },
    { id: "server", group: "配置", label: "服务与日志" },
    { id: "memory", group: "配置", label: "记忆与技能" },
    { id: "sessions", group: "运行", label: "会话" },
    { id: "logs", group: "运行", label: "事件日志" },
  ];

  const SECTION_OF_PATH = {
    agent: "agent",
    server: "server",
    logging: "server",
    memory: "memory",
    skills: "memory",
    channels: "channels",
    providers: "providers",
  };

  // ---------- 状态 ----------
  const state = {
    ws: null,
    connected: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    pending: new Map(),
    reqId: 0,
    view: "overview",
    status: null,
    config: null,
    draft: null,
    dirty: new Set(),
    deletedProviders: new Set(),
    addedProviders: new Set(),
    /** 显式改过模型列表的提供商：只有这些才提交 models，避免冲掉 compat 等字段 */
    modelsDirty: new Set(),
    /** 被编辑过的提供商：只提交这些，避免把环境变量提供的条目写进配置文件 */
    editedProviders: new Set(),
    logs: [],
    busy: false,
    saveMessage: { kind: "", text: "" },
  };

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
  }

  function fmtUptime(ms) {
    if (!ms || ms < 0) return "—";
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    if (minutes > 0) return `${minutes} 分`;
    return `${seconds} 秒`;
  }

  // ---------- WebSocket ----------
  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      state.reconnectAttempt = 0;
      renderConnection();
      void loadAll();
    };

    ws.onclose = () => {
      state.connected = false;
      renderConnection();
      scheduleReconnect();
    };

    ws.onerror = () => renderConnection();

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
        return;
      }

      if (frame.type === "event") handleEvent(frame.event, frame.payload);
    };
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    const cap = Math.min(10000, 500 * 2 ** state.reconnectAttempt);
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, cap / 2 + Math.random() * (cap / 2));
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
      setTimeout(() => {
        if (!state.pending.has(id)) return;
        state.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, 20000);
    });
  }

  function handleEvent(name, payload) {
    if (name === "session.status" && payload) {
      addLog("info", `会话 ${payload.sessionKey} ${payload.running ? "开始运行" : "空闲"}`);
      return;
    }
    if (name === "chat.error" && payload) {
      addLog("error", `对话错误：${payload.error}`);
    }
  }

  // ---------- 日志 ----------
  function addLog(level, message) {
    const time = new Date().toLocaleTimeString("zh-CN");
    state.logs.push({ level, message, time });
    if (state.logs.length > 300) state.logs.shift();
    if (state.view === "logs") renderLogs();
  }

  // ---------- 数据加载 ----------
  async function loadAll() {
    try {
      const [status, config] = await Promise.all([request("status.get"), request("config.get")]);
      state.status = status;
      state.config = config;
      state.draft = toDraft(config);
      state.dirty.clear();
      state.deletedProviders.clear();
      state.addedProviders.clear();
      state.modelsDirty.clear();
      state.editedProviders.clear();
      render();
      addLog("info", "配置已加载");
    } catch (error) {
      state.saveMessage = { kind: "error", text: `加载配置失败：${error.message}` };
      renderSaveBar();
      addLog("error", `加载配置失败：${error.message}`);
    }
  }

  /** 服务端配置 -> 可编辑草稿（补齐缺失结构，避免渲染时访问 undefined） */
  function toDraft(config) {
    const providers = {};
    for (const [id, provider] of Object.entries(config?.providers ?? {})) {
      providers[id] = {
        id: provider.id ?? id,
        name: provider.name ?? id,
        baseUrl: provider.baseUrl ?? "",
        groupId: provider.groupId ?? "",
        hasApiKey: Boolean(provider.hasApiKey),
        apiKey: "",
        models: (provider.models ?? []).map((model) => ({
          id: model.id ?? "",
          name: model.name ?? "",
          contextWindow: model.contextWindow ?? 0,
          maxTokens: model.maxTokens ?? 0,
          supportsVision: model.supportsVision !== false,
          supportsReasoning: model.supportsReasoning !== false,
        })),
      };
    }

    const channels = {};
    for (const meta of CHANNELS) {
      const source = config?.channels?.[meta.id] ?? {};
      channels[meta.id] = {
        enabled: source.enabled !== false,
        hasConfig: Boolean(source.hasConfig),
        ...Object.fromEntries(meta.fields.map((field) => [field.key, source[field.key] ?? ""])),
      };
    }

    return {
      providers,
      channels,
      agent: {
        defaultProvider: config?.agent?.defaultProvider ?? "deepseek",
        defaultModel: config?.agent?.defaultModel ?? "",
        maxTokens: config?.agent?.maxTokens ?? 4096,
        thinkingLevel: config?.agent?.thinkingLevel ?? "medium",
        systemPrompt: config?.agent?.systemPrompt ?? "",
      },
      server: {
        port: config?.server?.port ?? 3000,
        host: config?.server?.host ?? "0.0.0.0",
        logLevel: config?.logging?.level ?? "info",
      },
      memory: {
        enabled: config?.memory?.enabled !== false,
        directory: config?.memory?.directory ?? "",
      },
      skills: {
        enabled: config?.skills?.enabled !== false,
        userDir: config?.skills?.userDir ?? "",
        workspaceDir: config?.skills?.workspaceDir ?? "",
      },
    };
  }

  // ---------- 渲染 ----------
  function render() {
    renderNav();
    renderView();
    renderSaveBar();
    renderConnection();
  }

  function renderConnection() {
    const badge = $("connection");
    if (!badge) return;
    badge.dataset.online = state.connected ? "true" : "false";
    badge.innerHTML = `<span class="mz-dot" data-state="${state.connected ? "done" : "error"}"></span>${
      state.connected ? "已连接" : "连接断开"
    }`;
  }

  function renderNav() {
    const nav = $("nav");
    if (!nav) return;

    let currentGroup = "";
    nav.innerHTML = SECTIONS.map((section) => {
      const header =
        section.group !== currentGroup
          ? ((currentGroup = section.group), `<div class="nav-group">${esc(section.group)}</div>`)
          : "";
      const active = state.view === section.id;
      return `${header}<button class="nav-item" data-nav="${section.id}" data-active="${active}">${esc(
        section.label
      )}</button>`;
    }).join("");
  }

  function renderView() {
    const panel = $("panel");
    if (!panel) return;

    switch (state.view) {
      case "overview":
        panel.innerHTML = renderOverview();
        break;
      case "providers":
        panel.innerHTML = renderProviders();
        break;
      case "agent":
        panel.innerHTML = renderAgent();
        break;
      case "channels":
        panel.innerHTML = renderChannels();
        break;
      case "server":
        panel.innerHTML = renderServer();
        break;
      case "memory":
        panel.innerHTML = renderMemory();
        break;
      case "sessions":
        panel.innerHTML = renderSessions();
        break;
      case "logs":
        panel.innerHTML = renderLogs();
        break;
      default:
        panel.innerHTML = "";
    }
  }

  function sectionHead(title, desc) {
    return `<div class="section-head"><span class="section-title">${esc(title)}</span></div>
      <div class="section-desc">${esc(desc)}</div>`;
  }

  function renderOverview() {
    const status = state.status;
    if (!status) return `<div class="empty">正在加载…</div>`;

    const providerRows = (status.providers ?? [])
      .map(
        (provider) => `
        <div class="row">
          <span class="mz-dot" data-state="${provider.available ? "done" : "idle"}"></span>
          <div class="row-main">
            <div class="row-title">${esc(PROVIDER_LABELS[provider.id] ?? provider.name ?? provider.id)}</div>
            <div class="row-sub">${esc(provider.id)}</div>
          </div>
        </div>`
      )
      .join("");

    const channelRows = (status.channels ?? [])
      .map(
        (channel) => `
        <div class="row">
          <span class="mz-dot" data-state="${channel.connected ? "done" : "idle"}"></span>
          <div class="row-main">
            <div class="row-title">${esc(CHANNELS.find((c) => c.id === channel.id)?.name ?? channel.id)}</div>
            <div class="row-sub">${channel.connected ? "已连接" : "未连接"}</div>
          </div>
        </div>`
      )
      .join("");

    return `
      ${sectionHead("概览", "服务状态、已注册的模型提供商与通讯通道。")}
      <div class="stats">
        <div class="stat"><div class="stat-label">版本</div><div class="stat-value">${esc(status.version)}</div></div>
        <div class="stat"><div class="stat-label">运行时长</div><div class="stat-value">${esc(fmtUptime(status.uptime))}</div></div>
        <div class="stat"><div class="stat-label">提供商</div><div class="stat-value">${(status.providers ?? []).length}</div></div>
        <div class="stat"><div class="stat-label">通道</div><div class="stat-value">${(status.channels ?? []).length}</div></div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">模型提供商</span>
          <span class="card-sub">${(status.providers ?? []).length} 个</span></div>
        ${providerRows || `<div class="empty">尚未配置提供商</div>`}
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">通讯通道</span>
          <span class="card-sub">${(status.channels ?? []).length} 个</span></div>
        ${channelRows || `<div class="empty">未启用任何通道（仅 Web 模式）</div>`}
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">存储</span></div>
        <div class="row"><div class="row-main">
          <div class="row-title">会话目录</div>
          <div class="row-sub">${esc(status.durableDir ?? "~/.mozi/sessions")}</div>
        </div></div>
      </div>`;
  }

  function providerCard(id) {
    const provider = state.draft.providers[id];
    const label = provider.name || PROVIDER_LABELS[id] || id;
    const isCustom = CUSTOM_PROVIDERS.has(id);
    const models = provider.models ?? [];

    return `
      <div class="card" data-provider="${esc(id)}">
        <div class="card-head">
          <span class="mz-dot" data-state="${provider.hasApiKey ? "done" : "idle"}"></span>
          <div>
            <div class="card-title">${esc(label)}</div>
            <div class="card-sub">${esc(id)}${provider.baseUrl ? ` · ${esc(provider.baseUrl)}` : ""}</div>
          </div>
          <div class="card-actions">
            <button class="btn btn--ghost btn--sm" data-action="provider-edit" data-id="${esc(id)}">编辑</button>
            <button class="btn btn--danger btn--sm" data-action="provider-delete" data-id="${esc(id)}">删除</button>
          </div>
        </div>

        <div class="field">
          <span class="field-label">API Key</span>
          <input class="input" type="password" placeholder="${provider.hasApiKey ? "已配置，留空保持不变" : "未配置"}"
                 data-path="providers.${esc(id)}.apiKey" value="${esc(provider.apiKey)}" autocomplete="off">
        </div>

        ${
          isCustom
            ? `<div class="field">
                 <span class="field-label">Base URL</span>
                 <input class="input" data-path="providers.${esc(id)}.baseUrl" value="${esc(provider.baseUrl)}"
                        placeholder="https://api.example.com/v1">
               </div>
               <div class="field">
                 <span class="field-label">模型</span>
                 <div>
                   ${
                     models.length === 0
                       ? `<div class="card-sub">尚未添加模型，至少需要一个才能使用</div>`
                       : `<table class="model-table">
                            <thead>
                              <tr>
                                <th>模型 ID</th>
                                <th>名称</th>
                                <th>上下文</th>
                                <th>最大输出</th>
                                <th>推理</th>
                                <th>视觉</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              ${models
                                .map(
                                  (model, index) => `
                                <tr>
                                  <td><input class="input" data-path="providers.${esc(id)}.models.${index}.id"
                                             value="${esc(model.id)}" placeholder="model-id"></td>
                                  <td><input class="input" data-path="providers.${esc(id)}.models.${index}.name"
                                             value="${esc(model.name)}" placeholder="显示名称"></td>
                                  <td><input class="input" type="number" data-path="providers.${esc(id)}.models.${index}.contextWindow"
                                             value="${esc(model.contextWindow)}"></td>
                                  <td><input class="input" type="number" data-path="providers.${esc(id)}.models.${index}.maxTokens"
                                             value="${esc(model.maxTokens)}"></td>
                                  <td><input type="checkbox" data-path="providers.${esc(id)}.models.${index}.supportsReasoning"
                                             ${model.supportsReasoning ? "checked" : ""}
                                             title="支持 reasoning_effort"></td>
                                  <td><input type="checkbox" data-path="providers.${esc(id)}.models.${index}.supportsVision"
                                             ${model.supportsVision ? "checked" : ""}
                                             title="支持图片输入"></td>
                                  <td><button class="btn btn--danger btn--sm" data-action="model-delete"
                                              data-id="${esc(id)}" data-index="${index}">移除</button></td>
                                </tr>`
                                )
                                .join("")}
                            </tbody>
                          </table>`
                   }
                   <button class="btn btn--outline btn--sm" data-action="model-add" data-id="${esc(id)}"
                           style="margin-top:8px">+ 添加模型</button>
                 </div>
               </div>`
            : ""
        }
      </div>`;
  }

  function renderProviders() {
    const ids = Object.keys(state.draft.providers);
    return `
      ${sectionHead("模型提供商", "配置可用的模型服务。密钥只保存在本机配置文件中，界面不回显。")}
      <button class="btn btn--outline" data-action="provider-add" style="margin-bottom:14px">+ 添加提供商</button>
      ${ids.length === 0 ? `<div class="empty">还没有配置任何提供商</div>` : ids.map(providerCard).join("")}`;
  }

  function renderAgent() {
    const agent = state.draft.agent;
    const providerIds = Array.from(
      new Set([...Object.keys(state.draft.providers), ...Object.keys(PROVIDER_LABELS)])
    );
    const options = providerIds
      .map(
        (id) =>
          `<option value="${esc(id)}" ${agent.defaultProvider === id ? "selected" : ""}>${esc(
            PROVIDER_LABELS[id] ?? id
          )}</option>`
      )
      .join("");

    return `
      ${sectionHead("Agent", "默认模型与推理参数。")}
      <div class="card">
        <div class="field">
          <span class="field-label">默认提供商</span>
          <select class="select" data-path="agent.defaultProvider">${options}</select>
        </div>
        <div class="field">
          <span class="field-label">默认模型</span>
          <input class="input" data-path="agent.defaultModel" value="${esc(agent.defaultModel)}"
                 placeholder="例如 your-model-id">
          <span class="field-hint">必须与提供商支持的模型 ID 一致</span>
        </div>
        <div class="field">
          <span class="field-label">思考深度</span>
          <select class="select" data-path="agent.thinkingLevel">
            ${["off", "minimal", "low", "medium", "high", "xhigh"]
              .map(
                (level) =>
                  `<option value="${level}" ${agent.thinkingLevel === level ? "selected" : ""}>${level}</option>`
              )
              .join("")}
          </select>
          <span class="field-hint">对应提供商的 reasoning_effort；不支持的取值会被服务端拒绝</span>
        </div>
        <div class="field">
          <span class="field-label">最大输出 Token</span>
          <input class="input" type="number" min="1" data-path="agent.maxTokens" value="${esc(agent.maxTokens)}">
        </div>
        <div class="field">
          <span class="field-label">系统提示</span>
          <textarea class="textarea" data-path="agent.systemPrompt"
                    placeholder="留空使用内置提示">${esc(agent.systemPrompt)}</textarea>
        </div>
      </div>`;
  }

  function renderChannels() {
    const cards = CHANNELS.map((meta) => {
      const channel = state.draft.channels[meta.id];
      const fields = meta.fields
        .map((field) => {
          if (field.type === "boolean") {
            return `<div class="field">
              <span class="field-label">${esc(field.label)}</span>
              <label class="switch"><input type="checkbox" data-path="channels.${meta.id}.${field.key}"
                ${channel[field.key] ? "checked" : ""}>启用</label>
            </div>`;
          }
          return `<div class="field">
            <span class="field-label">${esc(field.label)}</span>
            <input class="input" type="${field.secret ? "password" : field.type === "number" ? "number" : "text"}"
                   data-path="channels.${meta.id}.${field.key}"
                   value="${field.secret ? "" : esc(channel[field.key])}"
                   placeholder="${field.secret && channel.hasConfig ? "已配置，留空保持不变" : ""}"
                   autocomplete="off">
          </div>`;
        })
        .join("");

      return `
        <div class="card">
          <div class="card-head">
            <span class="mz-dot" data-state="${channel.hasConfig ? "done" : "idle"}"></span>
            <div class="card-title">${esc(meta.name)}</div>
            <div class="card-actions">
              <label class="switch"><input type="checkbox" data-path="channels.${meta.id}.enabled"
                ${channel.enabled ? "checked" : ""}>启用</label>
            </div>
          </div>
          ${fields}
        </div>`;
    });

    return `
      ${sectionHead("通讯通道", "可选。未配置通道时，Web 界面本身就是完整入口。")}
      ${cards.join("")}`;
  }

  function renderServer() {
    const server = state.draft.server;
    return `
      ${sectionHead("服务与日志", "监听地址与日志级别，修改端口需要重启服务。")}
      <div class="card">
        <div class="field">
          <span class="field-label">端口</span>
          <input class="input" type="number" min="1" max="65535" data-path="server.port" value="${esc(server.port)}">
        </div>
        <div class="field">
          <span class="field-label">监听地址</span>
          <input class="input" data-path="server.host" value="${esc(server.host)}" placeholder="0.0.0.0">
        </div>
        <div class="field">
          <span class="field-label">日志级别</span>
          <select class="select" data-path="server.logLevel">
            ${["debug", "info", "warn", "error"]
              .map((level) => `<option value="${level}" ${server.logLevel === level ? "selected" : ""}>${level}</option>`)
              .join("")}
          </select>
        </div>
      </div>`;
  }

  function renderMemory() {
    const memory = state.draft.memory;
    const skills = state.draft.skills;
    return `
      ${sectionHead("记忆与技能", "跨会话记忆与 SKILL.md 技能加载。")}
      <div class="card">
        <div class="card-head"><span class="card-title">记忆系统</span></div>
        <div class="field">
          <span class="field-label">启用</span>
          <label class="switch"><input type="checkbox" data-path="memory.enabled" ${memory.enabled ? "checked" : ""}>启用长期记忆</label>
        </div>
        <div class="field">
          <span class="field-label">存储目录</span>
          <input class="input" data-path="memory.directory" value="${esc(memory.directory)}" placeholder="~/.mozi/memory">
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">技能</span></div>
        <div class="field">
          <span class="field-label">启用</span>
          <label class="switch"><input type="checkbox" data-path="skills.enabled" ${skills.enabled ? "checked" : ""}>加载 SKILL.md</label>
        </div>
        <div class="field">
          <span class="field-label">用户目录</span>
          <input class="input" data-path="skills.userDir" value="${esc(skills.userDir)}" placeholder="~/.mozi/skills">
        </div>
        <div class="field">
          <span class="field-label">工作区目录</span>
          <input class="input" data-path="skills.workspaceDir" value="${esc(skills.workspaceDir)}" placeholder="./skills">
        </div>
      </div>`;
  }

  function renderSessions() {
    const sessions = state.status?.sessions ?? 0;
    return `
      ${sectionHead("会话", "当前活动会话数量；历史会话在聊天页侧边栏管理。")}
      <div class="card">
        <div class="row">
          <div class="row-main">
            <div class="row-title">活动会话</div>
            <div class="row-sub">WebSocket 连接数</div>
          </div>
          <strong>${sessions}</strong>
        </div>
        <div class="row">
          <div class="row-main">
            <div class="row-title">会话目录</div>
            <div class="row-sub">${esc(state.status?.durableDir ?? "~/.mozi/sessions")}</div>
          </div>
        </div>
      </div>
      <a class="btn btn--outline" href="/">打开聊天界面</a>`;
  }

  function renderLogs() {
    const lines = state.logs
      .map(
        (entry) =>
          `<span class="log-line" data-level="${esc(entry.level)}">${esc(entry.time)}  ${esc(entry.message)}</span>`
      )
      .join("");
    return `${sectionHead("事件日志", "当前页面的连接与配置操作记录。")}
      <div class="logs" id="logContainer">${lines || `<span class="log-line">暂无日志</span>`}</div>`;
  }

  function renderSaveBar() {
    const message = $("saveMessage");
    const saveButton = $("saveBtn");
    const discardButton = $("discardBtn");

    const dirtyCount = state.dirty.size;
    if (saveButton) {
      saveButton.disabled = dirtyCount === 0 || state.busy;
      saveButton.textContent = state.busy ? "保存中…" : dirtyCount > 0 ? `保存更改（${dirtyCount}）` : "保存更改";
    }
    if (discardButton) discardButton.disabled = dirtyCount === 0 || state.busy;
    if (message) {
      message.dataset.kind = state.saveMessage.kind;
      message.textContent = state.saveMessage.text;
    }
  }

  // ---------- 草稿编辑 ----------
  function setPath(path, value) {
    const parts = path.split(".");
    const section = SECTION_OF_PATH[parts[0]];
    if (!section) return;

    if (parts[0] === "providers" && parts[1]) {
      state.editedProviders.add(parts[1]);
      // 直接编辑模型字段（ID/上下文/推理开关等）也要算作模型变更
      if (parts[2] === "models") state.modelsDirty.add(parts[1]);
    }

    let target = state.draft;
    for (const part of parts.slice(0, -1)) {
      if (!target[part]) target[part] = {};
      target = target[part];
    }
    target[parts[parts.length - 1]] = value;
    state.dirty.add(section);
    renderSaveBar();
  }

  function readInput(input) {
    if (input.type === "checkbox") return input.checked;
    if (input.type === "number") {
      const parsed = Number(input.value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return input.value;
  }

  // ---------- 保存 ----------
  function buildSaveParams() {
    const params = {};

    if (state.dirty.has("providers")) {
      for (const [id, provider] of Object.entries(state.draft.providers)) {
        if (!CUSTOM_PROVIDERS.has(id)) continue;
        if (!(state.modelsDirty.has(id) || state.addedProviders.has(id))) continue;
        const valid = (provider.models ?? []).filter((model) => model.id.trim() !== "");
        if (valid.length === 0) {
          throw new Error(`${PROVIDER_LABELS[id] ?? id} 至少需要一个模型 ID`);
        }
      }

      const providers = {};
      const touched = new Set([...state.editedProviders, ...state.addedProviders]);
      for (const id of touched) {
        const provider = state.draft.providers[id];
        if (!provider) continue;
        providers[id] = {
          id: provider.id || id,
          name: provider.name || id,
          baseUrl: provider.baseUrl || undefined,
          groupId: provider.groupId || undefined,
          hasApiKey: true,
          ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
          // 只在用户改过模型列表（或新增提供商）时提交，保留 compat/supports* 等未暴露字段
          ...(CUSTOM_PROVIDERS.has(id) &&
          (state.modelsDirty.has(id) || state.addedProviders.has(id)) &&
          provider.models?.length
            ? {
                models: provider.models
                  .filter((model) => model.id.trim() !== "")
                  .map((model) => ({
                    id: model.id.trim(),
                    name: (model.name || model.id).trim(),
                    contextWindow: Number(model.contextWindow) || 128000,
                    maxTokens: Number(model.maxTokens) || 8192,
                    supportsVision: Boolean(model.supportsVision),
                    supportsReasoning: Boolean(model.supportsReasoning),
                  })),
              }
            : {}),
        };
      }
      // 删除项显式标记，服务端据此移除
      for (const id of state.deletedProviders) {
        providers[id] = { id, name: id, hasApiKey: false };
      }
      params.providers = providers;
    }

    if (state.dirty.has("channels")) {
      const channels = {};
      for (const meta of CHANNELS) {
        const channel = state.draft.channels[meta.id];
        const filled = meta.fields.filter((field) => {
          const value = channel[field.key];
          return value !== "" && value !== undefined && value !== null && value !== false;
        });

        // 没有任何字段值、且原本也没有配置的通道不要提交，否则会写出一堆空配置
        if (filled.length === 0 && !channel.hasConfig) continue;

        const payload = { id: meta.id, name: meta.name, enabled: channel.enabled, hasConfig: true };
        for (const field of filled) {
          payload[field.key] = channel[field.key];
        }
        channels[meta.id] = payload;
      }
      params.channels = channels;
    }

    if (state.dirty.has("agent")) {
      params.agent = {
        defaultProvider: state.draft.agent.defaultProvider,
        defaultModel: state.draft.agent.defaultModel,
        maxTokens: state.draft.agent.maxTokens,
        thinkingLevel: state.draft.agent.thinkingLevel,
        systemPrompt: state.draft.agent.systemPrompt || undefined,
      };
    }

    if (state.dirty.has("server")) {
      params.server = { port: state.draft.server.port, host: state.draft.server.host };
      params.logging = { level: state.draft.server.logLevel };
    }

    if (state.dirty.has("memory")) {
      params.memory = {
        enabled: state.draft.memory.enabled,
        directory: state.draft.memory.directory || undefined,
      };
      params.skills = {
        enabled: state.draft.skills.enabled,
        userDir: state.draft.skills.userDir || undefined,
        workspaceDir: state.draft.skills.workspaceDir || undefined,
      };
    }

    return params;
  }

  async function save() {
    if (state.busy || state.dirty.size === 0) return;
    state.busy = true;
    renderSaveBar();

    try {
      const params = buildSaveParams();

      const validation = await request("config.validate", params);
      if (!validation.valid) {
        state.saveMessage = { kind: "error", text: `校验失败：${validation.errors.join("；")}` };
        addLog("error", `配置校验失败：${validation.errors.join("；")}`);
        return;
      }

      const result = await request("config.save", params);
      if (!result.success) {
        state.saveMessage = { kind: "error", text: result.message || "保存失败" };
        addLog("error", result.message || "保存失败");
        return;
      }

      const message = result.message || "已保存";
      addLog(result.requiresRestart ? "warn" : "info", message);
      await loadAll();
      // loadAll 会重置状态，成功提示要在它之后设置
      state.saveMessage = { kind: result.requiresRestart ? "warn" : "ok", text: message };
      renderSaveBar();
    } catch (error) {
      state.saveMessage = { kind: "error", text: `保存失败：${error.message}` };
      addLog("error", `保存失败：${error.message}`);
    } finally {
      state.busy = false;
      renderSaveBar();
    }
  }

  // ---------- 提供商弹窗 ----------
  function openProviderModal(id) {
    const modal = $("providerModal");
    const provider = id ? state.draft.providers[id] : null;

    $("modalTitle").textContent = provider ? `编辑 ${provider.name || id}` : "添加提供商";
    $("modalType").value = id ?? "custom-openai";
    $("modalType").disabled = Boolean(provider);
    $("modalName").value = provider?.name ?? "";
    $("modalBaseUrl").value = provider?.baseUrl ?? "";
    $("modalApiKey").value = "";

    modal.dataset.open = "true";
    modal.dataset.editing = id ?? "";
    updateModalFields();
  }

  function closeProviderModal() {
    $("providerModal").dataset.open = "false";
  }

  function updateModalFields() {
    const type = $("modalType").value;
    $("baseUrlField").classList.toggle("hidden", !NEEDS_BASE_URL.has(type));
  }

  function submitProviderModal() {
    const editing = $("providerModal").dataset.editing;
    const type = $("modalType").value;
    const name = $("modalName").value.trim();
    const baseUrl = $("modalBaseUrl").value.trim();
    const apiKey = $("modalApiKey").value.trim();

    if (editing) {
      const provider = state.draft.providers[editing];
      provider.name = name || provider.name;
      if (baseUrl) provider.baseUrl = baseUrl;
      if (apiKey) {
        provider.apiKey = apiKey;
        provider.hasApiKey = true;
      }

      state.dirty.add("providers");
    } else {
      if (state.draft.providers[type] && !confirm(`${PROVIDER_LABELS[type] ?? type} 已存在，覆盖它的配置？`)) {
        return;
      }
      state.draft.providers[type] = {
        id: type,
        name: name || PROVIDER_LABELS[type] || type,
        baseUrl,
        groupId: "",
        hasApiKey: Boolean(apiKey),
        apiKey,
        models: CUSTOM_PROVIDERS.has(type) ? [] : [],
      };
      state.deletedProviders.delete(type);
      state.addedProviders.add(type);
      if (CUSTOM_PROVIDERS.has(type)) state.modelsDirty.add(type);
      state.dirty.add("providers");
    }

    closeProviderModal();
    renderView();
    renderSaveBar();
  }

  // ---------- 模型行 ----------
  /** 追加一行空模型，直接在表格里填写 */
  function addModelRow(providerId) {
    const provider = state.draft.providers[providerId];
    if (!provider) return;
    provider.models.push({
      id: "",
      name: "",
      contextWindow: 1000000,
      maxTokens: 128000,
      supportsVision: true,
      supportsReasoning: true,
    });
    state.modelsDirty.add(providerId);
    state.dirty.add("providers");
    renderView();
    renderSaveBar();
    // 聚焦到新行的 ID 输入框
    const rows = document.querySelectorAll(`.card[data-provider="${providerId}"] .model-table tbody tr`);
    const input = rows[rows.length - 1]?.querySelector("input");
    input?.focus();
  }

  // ---------- 事件 ----------
  function bind() {
    $("nav").addEventListener("click", (event) => {
      const item = event.target.closest("[data-nav]");
      if (!item) return;
      state.view = item.dataset.nav;
      render();
    });

    $("panel").addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const action = target.closest("[data-action]");
      if (!action) return;

      switch (action.dataset.action) {
        case "provider-add":
          openProviderModal(null);
          return;
        case "provider-edit":
          openProviderModal(action.dataset.id);
          return;
        case "provider-delete": {
          const id = action.dataset.id;
          if (!confirm(`删除提供商 ${PROVIDER_LABELS[id] ?? id}？`)) return;
          delete state.draft.providers[id];
          state.deletedProviders.add(id);
          state.dirty.add("providers");
          renderView();
          renderSaveBar();
          return;
        }
        case "model-add":
          addModelRow(action.dataset.id);
          return;
        case "model-delete": {
          const provider = state.draft.providers[action.dataset.id];
          provider.models.splice(Number(action.dataset.index), 1);
          state.modelsDirty.add(action.dataset.id);
          state.dirty.add("providers");
          renderView();
          renderSaveBar();
          return;
        }
        default:
          return;
      }
    });

    $("panel").addEventListener("input", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) {
        return;
      }
      const path = input.dataset.path;
      if (!path) return;
      setPath(path, readInput(input));
    });

    $("panel").addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) return;
      const path = input.dataset.path;
      if (!path) return;
      setPath(path, readInput(input));
    });

    $("saveBtn").addEventListener("click", save);

    $("discardBtn").addEventListener("click", () => {
      if (state.dirty.size > 0 && !confirm("放弃未保存的修改？")) return;
      state.draft = toDraft(state.config);
      state.dirty.clear();
      state.deletedProviders.clear();
      state.addedProviders.clear();
      state.modelsDirty.clear();
      state.editedProviders.clear();
      state.saveMessage = { kind: "", text: "" };
      render();
    });

    $("modalCancel").addEventListener("click", closeProviderModal);
    $("modalSubmit").addEventListener("click", submitProviderModal);
    $("modalType").addEventListener("change", updateModalFields);
    $("providerModal").addEventListener("click", (event) => {
      if (event.target === $("providerModal")) closeProviderModal();
    });

    window.addEventListener("beforeunload", (event) => {
      if (state.dirty.size === 0) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  function start() {
    bind();
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
