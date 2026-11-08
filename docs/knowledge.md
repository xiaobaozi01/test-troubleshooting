# 常见问题与知识源扩展

先给助手一份 Markdown 常见问题列表即可，不用配置“错误 → 服务 → 解决方案”的规则表。Agent 检索资料、阅读适用条件，再判断能否直接答复或需要日志/代码/后台验证。接入层不根据关键词直接认定根因，也不执行文档中的修复命令。

## 公司使用

在项目根目录建立 `knowledge/company/`，将资料放进去（该目录已被 Git 忽略）。在 `config/company.json` 配置：

```json
{
  "knowledge": {
    "sources": [
      { "id": "company-faq", "title": "公司测试环境常见问题", "path": "knowledge/company" }
    ]
  }
}
```

`path` 可以是一份文件或目录，支持 Markdown、TXT 和 JSON，也可使用公司电脑上的绝对路径。可以配置多个源。配置变动后重启；本地文档每次检索/读取都会重新扫描，更新正文不用重启。只有管理员配置的知识路径会被读取，Agent 不能传任意本地路径。

Markdown 不要求固定格式，建议每条有：现象/报错、适用环境和服务、验证步骤、处理方法、复验方式、内容审核日期。多条问题可放在同一列表里；列表很长时拆成多个文件，检索效果更好。正文避免放密码和完整敏感配置。

JSON 可用数组，或 `{ "documents": [...] }`：

```json
[
  {
    "id": "account-locked",
    "title": "测试账号锁定",
    "tags": ["登录", "ACCOUNT_LOCKED"],
    "updatedAt": "2026-11-09",
    "content": "适用条件：……\n验证：……\n处理：……\n复验：……"
  }
]
```

每条必须有 `title`、`content`；其余可选。`id` 在同一文件内需唯一，未填写时使用数组位置。审核日期可填 `updatedAt`；文件修改时间单独返回，不当作审核日期。

## Agent 如何使用

启用知识源后，会话增加两个查询工具，共享原来的查询预算：

1. `troubleshoot_knowledge_search`：按现象、错误码、异常类或配置键检索候选，返回 sourceId/documentId、摘要、位置与版本。
2. `troubleshoot_knowledge_read`：读取正文和行号，长文档按 nextLine 继续。结果作为 `knowledge-document` 证据保存并可引用。

若某条问题允许修改配置，在正文加上限定范围的 repair-policy 授权块，并由管理员启用修复源；Agent 仍需提出精确方案、等待开发本人确认。自然语言的诊断和修复内容无需写成代码。见 [确认后修复](repair.md)。

本地检索采用字面关键词及中文相邻字匹配，不是语义向量检索；Agent 可以换短词重试。检索失败会返回 warnings，无匹配不代表问题不存在。不同知识源各自返回最多 limit 条（默认5，最多10），不跨源伪造统一置信度。

资料问答可直接回答处理步骤，不强制 SSH 或浏览器操作。当前故障则需核实资料要求的关键条件；仅凭文档相似不能声称根因已确认或问题已解决。发现过时或冲突内容时明确说明并继续验证。现有“排障前同步代码”的前置流程仍保留，知识问答不绕过原有 Git 同步要求。

扫描跳过隐藏文件、符号链接与 node_modules；目录深度最多8、访问2000项、200份文件，总读取上限4MiB，单文件512KiB，单JSON最多500条。达到边界或文件异常会报告不完整结果。只读取本机资料，不自动跟随文档里的网页链接。

## 接公司知识库或其他文档服务

实现一个可信本地模块，导出 `createSource(options)`。鉴权和调用公司 API 由模块负责；不在插件中写死某家知识库的协议，也不另外调用模型：

```js
export async function createSource(options) {
  return {
    async search({ query, limit }, signal) {
      // 将公司 API 结果转换为以下结构；尊重 signal 和 limit。
      return {
        documents: [{ id: 'opaque-id', title: '问题标题', excerpt: '相关摘要',
          location: '文档链接或位置', updatedAt: '2026-11-09', version: 'v3' }],
        warnings: [], truncated: false,
      };
    },
    async read({ documentId }, signal) {
      // 只读取该知识源的文档，不把 documentId 当作任意 URL 或文件路径。
      return { title: '问题标题', text: '完整正文',
        location: '文档链接或位置', updatedAt: '2026-11-09' };
    },
  };
}
```

```json
{
  "knowledge": {
    "sources": [
      { "id": "wiki", "title": "公司知识库", "type": "module", "module": "company/wiki-source.mjs",
        "options": { "tokenEnv": "COMPANY_WIKI_TOKEN" } }
    ]
  }
}
```

`options` 原样传给模块；这里只声明环境变量名，实际由适配器读取令牌。模块是有本机代码权限的受信任接入代码，不能来自群消息或文档内容。检索摘要与读取正文做常见凭证脱敏和大小限制，不保证识别所有业务敏感字段。公司知识库 API 接入需在拿到协议后实现。

## 本机演示

默认 demo 和 browser-demo 已启用 `fixtures/knowledge/常见问题.md`。点击模拟群的“模拟：常见问题咨询”，或 @开发发送：

> 只咨询演示文档：DEMO_ACCOUNT_LOCKED 应该怎么处理？请引用资料中的适用条件和复验步骤，不用查运行日志。

应看到真实 Agent 调用检索/阅读工具并引用文档答复；没有预置 FAQ 回复模板。该错误码和处理时长都是公开演示规则，不代表公司策略。

也可执行 `npm run demo:knowledge` 自动提交上面的消息并检查实际知识工具调用、正文证据引用，以及没有运行日志/浏览器查询；检查脚本不生成答案。报告保存到 `.local/knowledge-demo-result.json`。
