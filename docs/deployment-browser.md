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

本插件不需要配置部署后台：只要当前 profile 安装并启用 BrowserSkill，启动时会自动接入六个原生工具。入口和账号写在知识源的「部署后台」章节。

知识源 Markdown 增加一个标题包含「部署后台」的章节，列出各环境地址、账号和登录说明：

```md
## 部署后台

- test：https://deploy-test.example/deploy 账号 demo，密码：demo-only
- staging：https://deploy-staging.example/deploy 账号 demo，密码：demo-only

只查看目标环境和服务的 YAML，不修改、保存、发布或重启。
```

插件不做额外的地址解析：知识源 Markdown 直接交给 Agent，Agent 检索后自己判断目标环境、入口和登录方式，再使用原生浏览器工具访问，不猜测或拼接未出现的 URL。

默认不限制后台域名，只拦非 HTTP(S)、带内嵌凭证的 URL，以及 evaluate/upload/debug/借用标签页等动作。如果公司希望保留一层硬限制，可在可选的插件配置里写 `deploymentBackend.allowedOrigins`（完整 origin 列表）；不配置就完全由 Agent 按知识源判断。

注意：知识检索会把英文 `password:` 脱敏成 `[REDACTED]`，账号密码请用中文「账号：」「密码：」书写。账号密码会进入模型上下文和会话记录，只应放内部可见的只读后台凭据。

浏览器导航可能耗时较长，账号权限、后台菜单、登录表单和导航路径由页面与任务上下文决定，不在产品代码中为具体平台硬编码。

桌面模式复用已经挂载的 BrowserSkill，管理块只为其补充 lazyTools:false 和必要的 CLI 路径，不挂第二份插件；移除管理块时恢复原有配置。独立调试的启动脚本从 DSH_SOURCE_PROFILE（默认 desktop）解析已安装插件，另加载到调试运行时。两种方式都不自动升级插件。

CLI 路径由 BrowserSkill 插件自身的设置决定；本机调试可用 `BSK_PATH` 或项目 `.local/bin/bsk`。浏览器扩展、CLI/daemon 和 DSH 插件都必须可用；可运行 `bsk doctor --json` 检查。本机调试 CLI 安装在项目 `.local/bin`，没有修改系统 PATH 配置。

真实后台优先复用已有登录状态。需要账号密码、单点登录或验证码时，按原生 BrowserSkill 观察和协助机制处理。普通工具调用的输入仍可能保存在 Harness 会话记录里，报告和群消息中不要复述账号密码。

## 证据和操作范围

- 只有启用后台时才向排障会话开放六个原生工具；已有 SSH、代码与群工具继续工作。
- 原生工具观察结果追加 evidenceId，可被最终报告引用；失败或被其他策略拒绝的结果不作为事实。
- 浏览器操作与源码查询共用同一轮任务和证据；保留原生 contextId、observationId 和用户干预处理，不绕过浏览器确认设置。
- 导航地址限制在后台及配置的登录域；禁用任意 evaluate、文件传输、网络重放和嵌套 step。表单点击仍由 Agent 判断，只读用途需要平台账号权限配合，不能将提示约束当作账号级隔离。
- 模型只读取与故障有关的配置；任务证据做常见敏感字段脱敏，群报告不应粘贴整份 YAML。脱敏不保证覆盖所有业务自定义字段。
- 代码、日志、后台保存配置和运行时实际生效配置是不同证据，必须交叉核对。

官方说明：[BrowserSkill 的 Harness 插件](https://github.com/Tencent/BrowserSkill/tree/main/packages/dsh-plugin-browserskill#readme)。
