/**
 * 工具结果错误标记的回归测试
 *
 * pi 的 AgentToolResult 没有 isError 字段，只有抛异常才被当作失败。
 * 我们的工具用返回值表达"拒绝访问/命令被拦截"，因此必须把 isError 挂在
 * 结果对象上，再由 runtime 的 afterToolCall 提升成 pi 的标志。
 * 这条链断了的话，失败会以成功身份进入提示词与日志。
 */

import { describe, it, expect } from "vitest";
import { jsonResult, textResult, errorResult } from "../src/tools/common.js";

describe("tool result error flag", () => {
  it("marks jsonResult failures so runtime can lift them", () => {
    const ok = jsonResult({ status: "ok" });
    const failed = jsonResult({ status: "error", error: "Access denied" }, true);

    expect(ok.isError).toBeUndefined();
    expect(failed.isError).toBe(true);
    // 内容必须照常返回，模型需要看到原因
    expect(failed.content[0]).toMatchObject({ type: "text" });
  });

  it("marks textResult failures", () => {
    expect(textResult("done").isError).toBeUndefined();
    expect(textResult("blocked", undefined, true).isError).toBe(true);
  });

  it("always marks errorResult as a failure", () => {
    expect(errorResult("boom").isError).toBe(true);
    expect(errorResult(new Error("boom")).isError).toBe(true);
  });
});
