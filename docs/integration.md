# 公司接口接入约定

## 聊天适配器

`src/chat.mjs` 是可工作的模拟 HTTP 协议适配器。公司协议不同可实现模块，导出 `createAdapter(chatConfig)`，返回以下对象：

```js
export async function createAdapter(config) {
  return {
    async poll(cursor, signal) { /* 返回 { messages, nextCursor }；遵守取消信号 */ },
    async send(reply, signal) { /* 自动追问和报告需要；返回 { id: '平台消息ID' } */ },
    async attachment(id) { /* 返回 { mediaType: 'image/png', data: '标准base64' } */ },
  };
}
```

把公司配置文件中的 `chat.adapterModule` 指向模块路径（相对项目 root），用 `npm run install:desktop -- --config config/company.json` 接入现有桌面 Harness。也支持在 Harness 插件配置里提供 `chatAdapterModule`；例如插件配置为：

```json
{ "root": "/path/to/project", "configFile": "config/company.json", "chatAdapterModule": "company/chat-adapter.mjs" }
```

`poll(null)` 表示首次启动，请返回当前游标和空消息数组；其他游标用于增量拉取。游标作为不透明字符串处理。按平台顺序返回消息；单次分页不要跳过仍未返回的消息。重叠结果允许，程序根据 `groupId + id` 去重。群消息 ID 必须稳定。

统一消息：

```json
{
  "id": "message-123",
  "groupId": "qa-test",
  "senderId": "tester-account-id",
  "timestamp": "2026-11-09T02:01:00+08:00",
  "text": "@开发 下单报错，附截图",
  "mentions": ["developer-account-id"],
  "replyTo": null,
  "attachments": [{ "id": "image-123", "name": "报错.png" }]
}
```

`mentions` 使用账号 ID，不按昵称或文本中的 @ 字符猜测。`replyTo` 必须转换为被回复消息的稳定 ID。若平台不支持引用，后续补充需要包含助手显示的任务编号，例如 `#T-1234abcd`。消息时间不等于故障时间。

send(reply) 包含 groupId、replyTo、text、senderId、taskId、idempotencyKey，自动模式需实现它，并通过幂等键或发送记录核对避免重发。send 必须返回实际消息 ID，轮询中的引用 ID 也必须与其一致。只使用 deliveryMode: "draft" 时才不会调用 send。

公司同账号设置 ownerId 与 botId 为同一个账号，显式使用 deliveryMode: "auto"：追问和最终报告通过你的账号自动发回原群并引用原消息。修复方案的审批在 Harness 中进行，不通过群消息确认。company.example.json 已采用这个设置；未指定投递方式的旧同账号配置仍保留草稿行为，升级时明确改成 auto。

同账号下来自你账号的群消息不触发 Agent，也不能批准修复，包括插件自身回显和你的人工发言；它们只保留任务关联。已知发送回执 ID、发送关联键、正文 #T-xxxxxxxx 或引用已知任务可用于关联，测试引用追问补充后继续原任务。修复仍使用 Harness 原生一次性审批。

如果平台支持 clientMessageId 或类似消息扩展字段，发送时传入 idempotencyKey，轮询回显时映射为可选的 clientMessageId。这样即使回显早于发送回执、或回执丢失且平台修改了显示文本，也能归回原任务。没有此字段时必须保留正文任务编号或引用关系作为回执前的关联依据；不要删掉这些信息。回显不直接当成发送成功，重试仍使用同一幂等键并由适配器保证不重发。

## 当前模拟 HTTP 接口

| 接口 | 行为 |
|---|---|
| `GET /messages?after=latest` | 空结果和当前游标 |
| `GET /messages?after=<cursor>` | 增量消息、下一游标；最多100条 |
| `POST /replies` | 发送回复；同一 idempotencyKey 返回同一消息 ID |
| `GET /attachments/<id>` | 图片类型及 base64 |

模拟界面还有 `POST /messages` 和 `GET /snapshot`，仅用于调试，不是公司接口必须提供的功能。

## 服务目录与查询

公司配置参考 `config/company.example.json` 和 `config/services.example.json`。只提供环境、服务器别名和本地代码根目录：

```json
{
  "environments": ["test"],
  "hosts": [{ "environment": "test", "host": "qa-apps" }],
  "repositoryRoots": ["C:/work/repos"]
}
```

工具查询配置主机的 `docker ps -a --format '{{json .}}'`，优先用 Compose service 标签识别服务，否则使用镜像名作为候选 ID。多副本各有稳定 instanceId；不指定实例的多副本日志查询会拒绝并列出候选。只查询请求的环境，每批最多并发4台主机。

命令输出约定参考 [Docker 容器列表文档](https://docs.docker.com/reference/cli/docker/container/ls/)，Spring 类与方法映射的组合参考 [Spring 映射请求文档](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-requestmapping.html)。本项目仅静态提取常见字面量写法，不等同于框架运行时解析器。

代码根目录递归发现 `.git`、pom.xml、build.gradle、pyproject.toml 等项目边界，检索 Spring 类/方法级字面量映射及 Python 路由装饰器。`troubleshoot_find_endpoint` 返回匹配路径、方法、文件行号、代码仓标识和可能关联的实例；没有关联时可以直接用返回的 repository 标识读代码。网关 Path/RewritePath 等只作为文本线索，不自动宣称完成网关解析。

仓库和容器按项目目录名、spring.application.name、Compose 标签、镜像名等产生候选关联，不验证运行代码版本。同名仓库或多个实例保留歧义；名称不一致的少量例外可用可选 `services` 条目指定 environment/id/host/container/repository，**不需要配置 routes**。旧的显式服务条目仍兼容。

索引和容器发现缓存30秒，工具可 `refresh=true` 强制更新；重启后重建。代码扫描跳过构建产物和符号链接，最多访问10000个文件、5000个目录、深度25、读取32MiB源码，单文件上限1MiB。命中扫描边界或访问失败时返回 truncated/warnings，不把结果当作完整目录。代码静态提取不覆盖表达式、继承路由或跨文件动态注册；候选需通过上下文与日志确认。

SSH 复用本机 config、密钥及跳板机配置；使用 BatchMode，不弹交互密码框。当前固定操作包括容器发现、限定时间的 docker logs、容器 .State，不接受任意远程命令。只写文件或没有可识别时间戳的日志仍需适配。

部署平台数据导入尚未实现，待公司接口明确后可替换主机/部署信息来源；现在无需人工整理平台中的全部接口，也不依赖构建平台。

## 安装方式

推荐 [桌面接入](desktop.md)：安装脚本在现有 profile 的用户 patch 中维护一个有标记的配置块，复用日常 Harness。插件注入 timer 服务，以 ctx.timeout 调度增量群轮询和退避，以 ctx.interval 维护标题；没有新消息时不唤醒模型。停用取消定时器与群请求，并等待任务退出后释放状态锁。自定义适配器应响应 signal；停止时已完成但响应未确认的发送仍按幂等键恢复。

`npm start` 保留为独立 profile 的调试入口；先停用桌面配置，防止重复实例。项目还提供 dsh.bundle.patch 和 cordis.patch.yml 供标准包安装使用，该插件管理器安装路径尚未验证。

公司协议、部署平台 API 和自定义模型 provider 都还没有真实样例，因此这些接入仍需回公司后验证；已完成的真实模型测试只使用本地模拟数据。
