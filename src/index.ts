/**
 * Mozi - 国产AI模型 + 国产通讯软件的智能助手
 *
 * 主入口文件
 */

// 类型导出
export * from "./types/index.js";

// 配置
export { loadConfig, validateRequiredConfig } from "./config/index.js";

// 模型提供商
export {
  initializeProviders,
  getAllProviders,
  getAllModels,
  resolveModel,
  getApiKeyForProvider,
  isProviderAvailable,
} from "./providers/index.js";

// 通道
export {
  BaseChannelAdapter,
  FeishuChannel,
  DingtalkChannel,
  createFeishuChannel,
  createDingtalkChannel,
  FeishuApiClient,
  DingtalkApiClient,
  registerChannel,
  getChannel,
  getAllChannels,
  setGlobalMessageHandler,
} from "./channels/index.js";

// Agent
export {
  Agent,
  createAgent,
  AgentRuntime,
  createAgentRuntime,
  sessionKeyFor,
  type ChatOptions,
  type ChatResponse,
  type StreamEvent,
} from "./agents/index.js";

// Tools
export {
  type Tool,
  type ToolCall,
  type ToolCallResult,
  type ToolResult,
  type ToolPolicy,
  registerTool,
  registerTools,
  getTool,
  getAllTools,
  filterToolsByPolicy,
  createBuiltinTools,
  jsonResult,
  errorResult,
  textResult,
} from "./tools/index.js";

// Hooks
export {
  type HookEventType,
  type HookEvent,
  type HookHandler,
  registerHook,
  registerHooks,
  triggerHook,
  triggerHookSync,
  clearHooks,
  getHookCount,
  emitMessageReceived,
  emitMessageSending,
  emitAgentStart,
  emitAgentEnd,
  emitToolStart,
  emitToolEnd,
  emitError,
} from "./hooks/index.js";

// Plugins
export {
  type PluginMeta,
  type PluginApi,
  type PluginDefinition,
  registerPlugin,
  unregisterPlugin,
  getLoadedPlugins,
  isPluginLoaded,
  unregisterAllPlugins,
  definePlugin,
  defineToolPlugin,
} from "./plugins/index.js";

// Gateway
export { Gateway, createGateway, startGateway } from "./gateway/index.js";

// Durable execution (追加日志 + 崩溃恢复 + 投影)
export {
  DurableStore,
  DurableJournal,
  TurnRecorder,
  getDurableStore,
  initDurableStore,
  buildSnapshot,
  projectTurns,
  replayClassFor,
  DURABLE_FORMAT_VERSION,
  type DurableRecord,
  type JournaledRecord,
  type DurableSessionSnapshot,
  type DurableTurnView,
  type DurableLiveEvent,
  type SequencedLiveEvent,
  type RecoveryReport,
} from "./durable/index.js";

// Utils
export { getLogger, createLogger, setLogger, getChildLogger } from "./utils/logger.js";
export {
  generateId,
  getEnvVar,
  requireEnvVar,
  delay,
  retry,
  truncate,
  safeJsonParse,
  deepMerge,
  computeHmacSha256,
  aesDecrypt,
} from "./utils/index.js";

// Memory
export {
  MemoryManager,
  createMemoryManager,
  JsonMemoryStore,
  SimpleEmbedding,
  type MemoryEntry,
  type MemoryStore,
  type EmbeddingProvider,
} from "./memory/index.js";

// Outbound (主动发消息)
export {
  deliverMessage,
  deliverMessages,
  deliverOutboundPayloads,
  sendText,
  parseDeliveryTarget,
  getAvailableChannels,
  isChannelAvailable,
  type DeliveryTarget,
  type DeliveryPayload,
  type DeliveryOptions,
  type DeliveryResult,
} from "./outbound/index.js";

// Cron (定时任务)
export {
  CronService,
  getCronService,
  CronStore,
  createCronExecutor,
  createDefaultCronExecuteJob,
  computeNextRunAtMs,
  computeJobNextRunAtMs,
  validateCronExpr,
  formatSchedule,
  type CronJob,
  type CronJobCreate,
  type CronJobUpdate,
  type CronSchedule,
  type CronPayload,
  type PayloadSystemEvent,
  type PayloadAgentTurn,
  type CronEvent,
  type CronExecutionResult,
  type AgentExecutor,
} from "./cron/index.js";
