# 随日常 Harness 启动

推荐将排障插件接入已经使用的 DeepSeek Harness 桌面版。插件使用宿主 `ctx.timeout` 轮询群消息、`ctx.interval` 维护标题，只有收到需要处理的新问题或补充消息时才调用 Agent。无需单独 `npm start`、独立 profile 或端口 4318，也不创建“每分钟提醒模型”的 Schedule 任务。

## 一次接入

保留本项目目录，安装 Node.js 22+，在项目根目录执行：

```sh
npm run install:desktop -- --config config/company.json
```

公司配置和聊天适配器需要先按 [Windows 使用说明](company-windows.md) 准备。脚本默认操作当前用户的 `.dsh/profiles/desktop/cordis.patch.yml`，可用 `DSH_HOME` 指定 Harness 数据目录，或用 `--profile 名称` 选择实际使用的 profile。不复制或改变当前模型、provider、账号和凭据；新排障会话使用这个 Harness 当时选定的默认模型。

脚本为自己的配置块加管理标记，修改前生成权限受限的备份；可以重复执行，不重复加载插件。原有设置和 package.json 保留。项目入口、配置位置采用绝对路径，因此移动项目目录后要重新执行安装。它是加载本地代码的开发安装方式，不是将项目上传到插件市场。

安装后 Harness 会在配置重新加载时启动插件；本机已验证桌面版 0.2.2-rc.1 自动重新加载，无需另开进程。其他环境若未自动加载，重启 Harness。更新项目代码或配置内容后也需要重新加载插件或重启应用，单纯改动配置 JSON 不会自动刷新。

只检查计划而不写入：

```sh
npm run install:desktop -- --config config/company.json --dry-run
```

公司使用时不启动模拟服务。电脑和 Harness 必须保持运行，休眠或断网期间不能实时拉消息；恢复后按已保存游标继续。插件停用会取消定时器、群请求及排障执行，等待处理中任务退出后释放状态锁；未完成消息保留供下次继续。外部群适配器应遵守取消信号，避免停用被无限阻塞。

## 本机模拟

先停止之前的独立 `npm start` 进程，启动一次演示接口：

```sh
npm run mock
```

将插件接入日常 Harness：

```sh
npm run install:desktop -- --config config/browser-demo.json
```

打开 http://127.0.0.1:4317 ，点击“模拟：常见问题咨询”或“模拟：三方地址异常”。模型运行在日常 Harness 中，排障会话也出现在其会话列表。这里 `npm run mock` 只提供假的公司群、部署后台和日志演示接口，公司正式接入后由公司接口替代。

`.local/runtime.json` 中 `hostMode: "desktop"`、`scheduler: "harness-timer"` 和 `ready: true` 表示由桌面宿主运行。任务与证据文件位置由所选配置的 stateFile 决定；不需要读取应用的访问令牌。

## BrowserSkill

部署后台开启时，复用该 profile 已安装并启用的 BrowserSkill bundle，不再加载第二份。管理块为其追加 `lazyTools:false`，使排障会话能直接调用六个原生工具；这也会使其他会话可见这些原生工具，但排障工具的限制只加在本插件拥有的会话中。

CLI 路径优先采用 `deploymentBackend.bskPath`，再用安装时的 `BSK_PATH`，然后项目 `.local/bin/bsk[.exe]`；都未提供时保留现有 BrowserSkill 的 CLI 设置。浏览器扩展/daemon 仍按 BrowserSkill 原有方式连接；脚本不安装、升级或重建它们。

## 停用与移除

```sh
npm run install:desktop -- --remove
```

只移除脚本管理的配置块，包含它追加的 BrowserSkill 覆盖项；原有 BrowserSkill 设置恢复。状态、证据和备份保留，不删会话。配置重新加载后插件停止；重新安装会继续未处理消息。想改用独立调试模式时，先移除桌面配置再 `npm start`，避免同一状态文件被两个实例占用。

## 公司认证与系统工具

群认证优先复用公司适配器已有的本机凭据机制。若适配器通过环境变量读取 token，变量必须存在于桌面 Harness 进程的环境中；仅在另一个终端临时设置不会传入已运行的 GUI。修改用户环境或 Git/SSH 的 PATH 后，需让 Harness 重新启动并继承这些设置。账号密码不写进安装命令或项目配置。
