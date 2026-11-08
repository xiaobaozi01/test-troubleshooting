# Windows 公司电脑接入步骤

当前公司接口尚未对接，不能只改地址就连通公司群。已验证的是 macOS 上真实 Harness 配合模拟接口；Windows 启动适配已加入，但还没有在 Windows 机器上运行验证。

## 1. 拷贝项目并先运行模拟版

把项目放在例如 `C:\work\test-troubleshooting`，安装 Node.js 22+，使用公司已经安装的 DeepSeek Harness 配套 CLI。PowerShell 中执行：

```powershell
cd C:\work\test-troubleshooting
dsh --version
npm run mock
```

再开一个 PowerShell：

```powershell
cd C:\work\test-troubleshooting
npm start
```

若全局 `dsh` 版本不匹配，设置 `$env:DSH_CLI` 为当前桌面版配套 CLI 的实际路径，再启动。启动脚本支持通过 PowerShell 调用 `.cmd` 和 `.exe`。已验证接口版本为 0.2.2-rc.1；其他版本需要检查兼容性。

先打开 http://127.0.0.1:4317 测试模拟流程。公司数据接入前，确认排障会话确实连接内网模型。独立 profile 只自动复用默认模型选择和 Harness 原有凭证；**若内网连接依赖自定义 provider、端点配置或插件，需要先把相同连接配置接入独立 profile，或将插件加载到原有 Harness 运行上下文。不能只按模型名判断请求去了哪里。**

## 2. 提供环境与服务信息

复制模板：

```powershell
Copy-Item config\company.example.json config\company.json
Copy-Item config\services.example.json config\services.company.json
```

`services.company.json` 只需配置环境、服务器别名和一个或多个本地代码根目录，例如：

```json
{
  "environments": ["test"],
  "hosts": [
    { "environment": "test", "host": "qa-order" },
    { "environment": "test", "host": "qa-stock" }
  ],
  "repositoryRoots": ["C:/work/repos"]
}
```

不用逐个填写接口、容器名或下游依赖。工具通过固定的 `docker ps -a` 查询发现容器，通过代码根目录中的项目标记发现仓库；收到接口后跨仓检索 Spring/Python 字面量路由与网关配置文本。

- 使用已检出的代码根目录（Windows 路径推荐正斜杠），允许一个目录下有多个仓库或多模块项目。
- 服务器只登记 SSH 别名及所属环境；多副本自动返回不同 instanceId，查询时明确选实例。
- Compose service 标签、镜像名和代码项目名称用于产生关联候选；名称不一致时只对少量例外添加 `services` 覆盖条目或由开发确认，不需要维护接口表。
- 动态路由、继承映射、跨文件 Python 路由前缀和网关改写不能保证静态还原，工具保留文件行号供 Agent 继续核查。未匹配不代表接口不存在。
- 部署平台 API 仍未对接；当前发现路径为已配置服务器的 Docker 查询，不依赖构建平台。

公司模式每轮定位前会自动同步代码根目录内的 Git 仓库，不用逐仓执行 pull。请先安装 Git，设置每个 clone 所需分支的远端跟踪关系与非交互认证。工具只快进更新，不切分支、不 stash、不覆盖修改；本地修改或同步失败会停止定位并提示。建议使用独立排障 clone。更新后自动刷新接口索引，每轮分支和 commit 记录在任务证据中。

## 3. SSH 信息放到本机 OpenSSH 配置

位置：`$env:USERPROFILE\.ssh\config`。参考 `config/ssh.example.conf`，按实际服务器添加 Host 块；有现有 SSH 配置时合并条目，不覆盖整个文件。

```sshconfig
Host qa-order
    HostName 192.0.2.10
    User YOUR_SSH_USER
    Port 22
    IdentityFile ~/.ssh/YOUR_EXISTING_PRIVATE_KEY
    IdentitiesOnly yes
```

以上 IP 是文档样例，需替换。复用你自己的现有密钥；私钥内容不需要交给模型或填进项目配置。已有跳板机时复用 `ProxyJump` 配置。

先手动连接该别名，按公司流程核对并保存服务器指纹，然后验证自动查询所需的非交互登录和 Docker 权限：

```powershell
ssh qa-order
ssh -o BatchMode=yes qa-order 'docker ps --format "{{.Names}}"'
ssh -o BatchMode=yes qa-order 'docker logs --tail 20 order-service'
```

如果密钥有口令，先通过公司现有的 ssh-agent 加载密钥；不能在每次查询时弹出密码框。若你的日常终端与插件使用不同的 SSH 客户端/agent，需要先让系统 `ssh` 的 BatchMode 查询成功。账号须能执行对应 Docker 查询；当前工具不自动添加 sudo。

纯密码、验证码和交互式堡垒机目前没有实现自动登录；因为你同时支持密钥，可以优先用密钥方式接入。

## 4. 公司群适配完成后再切真实模式

将公司拉消息、下载截图、发回复接口封装到 `company/chat-adapter.mjs`。契约见 `docs/integration.md`。填写 `config/company.json` 的群 ID、被 @ 的开发账号 ID、接入账号 ID；`adapterModule` 指向这个模块。

真实群认证信息留在适配器使用的本地凭证机制中。模板的 `tokenEnv` 只是环境变量名；公司适配器要按公司实际认证协议读取它，不能认为填名字就完成认证。

确认接口、SSH、服务目录以及内网模型路由后，在 PowerShell 启动：

```powershell
$env:TROUBLESHOOT_CONFIG = 'config/company.json'
npm start
```

公司模式不需要运行模拟群服务。任务状态和证据保存在 `.local/company-tasks.json`，与模拟任务分开。首次连接从当前群游标开始，之后按已保存游标增量处理。电脑需保持运行并能访问公司网络。

正式接入前先在专用测试群验证一个明确问题：@你的账号 → 追问 → SSH 查询 → 群回复；再加入日常测试群。
