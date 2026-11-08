# 通过现有 BrowserSkill 查看部署后台

本功能复用 `@wxg-prc-cpg/browser-skill-dsh-plugin` 的六个原生 `bsk_*` 工具。没有重新实现浏览器自动化，也没有把“登录→点菜单→点服务→读 YAML”写成固定脚本。Agent 根据每次真实页面观察决定操作，并遵循已安装插件附带的 Skill、共享控制与人工协助说明。

## 本机模拟

推荐使用 [桌面接入](desktop.md)：运行演示接口后，执行 `npm run install:desktop -- --config config/browser-demo.json`，复用日常 Harness 中的 BrowserSkill。以下为仍然保留的独立调试方式，不能与桌面插件同时占用相同 stateFile。

模拟后台入口：http://127.0.0.1:4317/deploy 。演示账号 `demo`、密码 `demo-only` 是公开样例。后台有登录、环境筛选、服务列表和只读 YAML 页；test 与 staging 返回不同配置，输入框 ID 每次加载会变化。没有保存/发布端点。

两个终端启动：

```sh
npm run mock
```

```sh
TROUBLESHOOT_CONFIG=config/browser-demo.json npm start
```

Windows PowerShell 用：

```powershell
$env:TROUBLESHOOT_CONFIG = 'config/browser-demo.json'
npm start
```

然后执行 `npm run demo:browser`。脚本只提交群消息和检查结果，不替 Agent 执行登录或点击。它要求 Agent 实际访问 test/order-service 的配置页，取得原生浏览器证据，再发现 `partner.api.base-url` 的 `sandobx` 拼写异常，并对照代码约定中的 `sandbox` 和日志中的实际请求地址。三方域名使用 `.invalid`，不需要访问或重放三方请求。

## 公司接入

在 `config/company.json` 中开启：

```json
{
  "deploymentBackend": {
    "enabled": true,
    "url": "https://your-deployment-platform",
    "instructions": "目标服务配置在平台管理。按本次问题的环境查看，只读，不发布。"
  }
}
```

只需入口和业务背景；不要求填写页面选择器或每个服务的配置链接。SSO 需要跳转到其他域名时，可配置 `allowedOrigins`（完整 origin 列表）。如需特定登录浏览器，在对应扩展中复制已验证的 Instance ID，再配置 `browser`；不使用 Chrome 的 profile 目录名代替 ID。

浏览器导航需要更多工具调用，示例公司配置采用 `maxToolCalls:60`、`turnTimeoutMs:360000`；可按实际站点调整。账号权限、后台菜单、登录表单和导航路径由页面与任务上下文决定，不在产品代码中为具体平台硬编码。

桌面模式复用已经挂载的 BrowserSkill，管理块只为其补充 lazyTools:false 和必要的 CLI 路径，不挂第二份插件；移除管理块时恢复原有配置。独立调试的启动脚本从 DSH_SOURCE_PROFILE（默认 desktop）解析已安装插件，另加载到调试运行时。两种方式都不自动升级插件。

CLI 路径优先使用 `BSK_PATH` 环境变量，其次 `deploymentBackend.bskPath`，然后项目 `.local/bin/bsk`，最后 PATH 中的 `bsk`。浏览器扩展、CLI/daemon 和 DSH 插件都必须可用；可运行 `bsk doctor --json` 检查。本机调试 CLI 安装在项目 `.local/bin`，没有修改系统 PATH 配置。

真实后台优先复用已有登录状态。需要账号密码、单点登录或验证码时，按原生 BrowserSkill 观察和协助机制处理。**不要把真实密码写入提交到仓库的配置或 instructions。** 当前未实现企业凭据库的秘密注入；普通工具调用的输入仍可能保存在 Harness 会话记录里。模拟使用公开演示账号，不代表真实凭据保护已完成。

## 证据和操作范围

- 只有启用后台时才向排障会话开放六个原生工具；已有 SSH、代码与群工具继续工作。
- 原生工具观察结果追加 evidenceId，可被最终报告引用；失败或被其他策略拒绝的结果不作为事实。
- 浏览器操作与源码查询共享本轮预算和超时；保留原生 contextId、observationId 和用户干预处理，不绕过浏览器确认设置。
- 导航地址限制在后台及配置的登录域；禁用任意 evaluate、文件传输、网络重放和嵌套 step。表单点击仍由 Agent 判断，只读用途需要平台账号权限配合，不能将提示约束当作账号级隔离。
- 模型只读取与故障有关的配置；任务证据做常见敏感字段脱敏，群报告不应粘贴整份 YAML。脱敏不保证覆盖所有业务自定义字段。
- 代码、日志、后台保存配置和运行时实际生效配置是不同证据，必须交叉核对。

官方说明：[BrowserSkill 的 Harness 插件](https://github.com/Tencent/BrowserSkill/tree/main/packages/dsh-plugin-browserskill#readme)。
