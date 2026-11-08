# 文档允许、本人确认后修改并发布

Agent 判断文档是否适用、读取日志/代码/配置证据、提出精确修复值；插件负责确认边界和执行记录。没有“看到某个错误就改成某个固定值”的业务分支。默认关闭修复，公司配置也保持关闭。

## 使用流程

1. Agent 读到明确允许修复的手册，并核实本次故障条件。
2. 读取部署平台配置快照，提出包含环境、服务、版本、前后值、依据、发布动作、验证和失败处理的方案。此时没有写入。
3. 你引用这条方案，在群内回复 `/确认修复 R-xxxxxxxxxxxx`。
4. 插件核对群、本人账号、已发送方案、有效期及完整差异；在确认对应的 Agent 轮次才能执行。
5. 写入适配器检查旧版本和旧值，仅修改确认的键并发布，然后核对新值、生效版本和选定的只读检查，Agent 根据实际结果回复。

普通“同意”、测试人员回复、不引用方案或重复确认均不放行。确认15分钟有效；文档、代码 commit、目标平台、配置版本或差异变化需要重新出方案并确认。读取快照超过5分钟不能直接据此创建新方案。`/暂停`、`/结束` 撤销尚未执行的方案；已经发生的发布不能被暂停命令撤销。

执行前持久化操作意图和原值，使用方案编号作为平台幂等键。发布响应丢失时先查该操作，最多对平台确认不存在的同一操作补试一次，不生成新操作号盲目发布。验证失败不会报告“已恢复”，也不擅自回滚；恢复原值应另出精确方案，再由本人确认。报告尾部由程序按实际执行状态生成。

后续询问执行进展时，Agent 可用 `troubleshoot_repair_status` 只读核实操作和运行检查，不要求重新授权查询。它不会补写或重发发布；如果平台确定没有该操作，则旧方案失效，需要重新出方案确认。

## 文档授权

普通 FAQ 仍可用自然语言写现象、原因和处理步骤。允许执行的条目建议单独成文，增加小授权块：

````markdown
# 三方基础地址拼写错误

```repair-policy
{"environments":["test"],"services":["order-service"],"keys":["partner.api.base-url"],"checks":["partner-status"],"publish":true}
```

适用条件：同一请求日志中的实际三方地址与测试接入约定不符，且平台配置仍为该错误值。
允许修复：核实拼写错误后，将这个配置键改成接入约定中的完整地址。
必须先展示差异并由开发本人确认，再修改并发布。
验证：核对运行生效配置和只读状态请求。
失败处理：停止继续修改，报告实际状态；恢复原值另出方案确认。
````

授权块只限定可操作的环境、服务、配置键及检查项，不写“错误 → 正确值”的代码规则。如何诊断、改成什么仍由文档正文、现场证据和 Agent 决定。自然语言单独写“可以自动修复”不会直接授予工具写权限；加上授权块后仍必须由你逐次确认。JSON 条目或知识库模块也可以返回同结构的 `repairPolicy` 字段。

## 公司接入

配置示例：

```json
{
  "repair": {
    "enabled": true,
    "environments": ["test"],
    "allowedSources": ["company-repair-runbooks"],
    "adapterModule": "company/deployment-repair.mjs",
    "options": { "tokenEnv": "DEPLOY_REPAIR_TOKEN" }
  }
}
```

`allowedSources` 必须是 knowledge.sources 中管理员明确选用的修复手册源。环境取配置与手册授权的交集，不接受通配符或生产环境。当前仅支持最多10个非敏感标量配置键，不支持整份 YAML 替换、密码/令牌修改、业务数据操作、任意 Shell 命令或代码修复提交。

Agent 继续用现有 Harness、知识源、源码与日志工具，BrowserSkill 用于页面观察。写入需要公司部署平台适配器：它是平台级的通用配置接口，不是每个问题一套脚本。本版提供完整模拟适配器；没有猜测或实现公司尚未提供的写入 API。BrowserSkill 的观察提示不是账号权限隔离，建议观察账号只读、写入凭据按平台限制范围。

模块导出 `createRepairAdapter(options)`，返回：

```js
export async function createRepairAdapter(options) {
  return {
    capabilities: { conditionalWrite: true, idempotency: true, publish: true },
    async read({ environment, service, keys }, signal) {
      return { revision: 'opaque-revision', activeRevision: 'opaque-revision',
        values: { 'example.key': 'current-value' },
        checks: [{ id: 'read-only-health', description: '检查运行实例的只读健康状态' }] };
    },
    async apply({ operationId, environment, service, expectedRevision, changes, publish }, signal) {
      // changes 是 [{key,before,after}]；平台必须原子校验 revision 和全部 before。
      // 只修改这些键；保留其他 YAML 配置。成功保存且发布后才返回 published。
      // operationId 必须持久幂等：同键同请求返回原结果，不同请求必须拒绝。
      return { operationId, environment, service, state: 'published',
        revision: 'new-revision', changes };
    },
    async getOperation({ operationId }, signal) {
      // 返回已保存操作结果；只有确定未执行过才能返回 not_found。
      return { state: 'not_found' };
    },
    async verify({ operationId, environment, service, checks }, signal) {
      // 仅执行已登记的只读检查，不接受任意 URL、Shell 或业务写操作。
      return { effectiveRevision: 'new-revision',
        checks: [{ id: 'read-only-health', passed: true, detail: '真实观测结果' }] };
    },
  };
}
```

上面仅描述接口形状，不是可用于公司的实现。适配器必须响应取消信号、处理有界超时、保存部分执行状态，并从公司现有凭据机制取认证信息。`capabilities` 声明不能代替平台真实保证：如果平台不能条件写入或持久幂等，保持修复关闭。保存与发布分两步的平台需记录各阶段；只保存、发布失败或状态不明时，本引擎停止并报告，不会擅自继续。验证也必须是实际运行侧结果，不能只把“保存成功”转换成健康检查通过。

真实群的 senderId 必须来自公司平台的认证消息，不能从聊天正文或用户可伪造字段取得。复制配置、接好适配器后，按桌面接入方式安装；更新项目代码后重启 Harness，以加载新代码。真实公司登录、版本字段和发布接口仍需现场验证。

## 本机模拟

本次演示使用独立端口和状态目录，不影响当前桌面只读演示。PowerShell 的第一个终端：

```powershell
$env:MOCK_PORT = '4320'
$env:MOCK_STATE_DIR = '.local/repair-demo'
$env:MOCK_RUNTIME_FILE = '.local/repair-demo/runtime.json'
npm run mock
```

第二个终端：

```powershell
$env:TROUBLESHOOT_CONFIG = 'config/repair-demo.json'
$env:DSH_TROUBLESHOOT_PROFILE = 'troubleshooting-repair'
$env:HARNESS_PORT = '4321'
npm start
```

打开 http://127.0.0.1:4320 ，点击“模拟：申请配置修复”。收到方案后，点“填入确认指令”只会把确认文字填进输入框；检查差异后仍需你点击发送。也可以在第三个终端运行 `npm run demo:repair` 提交问题并检查确认前没有写入。

自动化验证使用 `npm run demo:repair -- --confirm-demo`：仅在本机模拟群用假测试账号和假开发账号依次确认，检查测试账号被拒绝、本人确认后恰好一次发布及新配置验证通过。这个标志只用于演示测试，不是替真实开发自动确认的功能。

执行后可以停止并重启这个隔离调试 Harness，再用 `npm run demo:repair -- --status-demo` 验证恢复原会话、只读核实状态而不重复发布。

模拟平台将配置和操作记录一起保存在 `.local/repair-demo/mock-deployment.json`，重启保留幂等记录。成功修复后重复提交相同故障时，配置已是新值，不能再次创建相同前后值的方案。域名使用 .invalid，检查只运行模拟应用，不会向真实三方发请求。
