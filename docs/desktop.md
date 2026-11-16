# 随日常 Harness 启动

推荐将排障插件接入已经使用的 DeepSeek Harness 桌面版。插件使用宿主 `ctx.timeout` 轮询群消息、`ctx.interval` 维护标题，只有收到需要处理的新问题或补充消息时才调用 Agent。无需单独 `npm start`、独立 profile 或端口 4318，也不创建“每分钟提醒模型”的 Schedule 任务。

## 一次接入

保留本项目目录，安装 Node.js 22+，在项目根目录执行：

```sh
npm run install:desktop -- --config config/company.json
```

公司配置和聊天适配器需要先按 [Windows 使用说明](company-windows.md) 准备。脚本默认操作当前用户的 `.dsh/profiles/desktop/cordis.patch.yml`，可用 `DSH_HOME` 指定 Harness 数据目录，或用 `--profile 名称` 选择实际使用的 profile。不复制或改变当前模型、provider、账号和凭据；新排障会话使用这个 Harness 当时选定的默认模型。

公司同账号场景将 ownerId 与 botId 都填你的账号。插件通过你的账号自动追问和发送最终结果。你账号的群消息不作为新排障输入，插件回显不会引发循环；发送回执、任务编号及可选 clientMessageId 用于继续关联测试补充。

脚本为自己的配置块加管理标记，修改前生成权限受限的备份；可以重复执行，不重复加载插件。原有设置和 package.json 保留。项目入口、配置位置采用绝对路径，因此移动项目目录后要重新执行安装。它是加载本地代码的开发安装方式，不是将项目上传到插件市场。

安装后 Harness 会在配置重新加载时启动插件；本机已验证桌面版 0.2.2-rc.1 自动重新加载，无需另开进程。其他环境若未自动加载，重启 Harness。更新项目代码或配置内容后也需要重新加载插件或重启应用，单纯改动配置 JSON 不会自动刷新。

只检查计划而不写入：

```sh
npm run install:desktop -- --config config/company.json --dry-run
```

公司使用时不启动模拟服务。电脑和 Harness 必须保持运行，休眠或断网期间不能实时拉消息；恢复后按已保存游标继续。插件停用会取消定时器、群请求及排障执行，等待处理中任务退出后释放状态锁；未完成消息保留供下次继续。外部群适配器应遵守取消信号，避免停用被无限阻塞。

## 作为插件出现在插件列表

脚本写入的是一行直接指向 `src/desktop-plugin.mjs` 的开发配置：Loader 里有这一行，插件确实在运行，但侧栏「插件」页只管 bundle，设置里的只读清单也只能显示这行文件路径，没有标题、描述、图标和启停开关。希望它像普通插件一样可见、可管理时，改为 bundle 安装：

1. 在侧栏「插件」页用「添加插件」选择本项目目录，或让 Agent 用 `plugin_manager` 安装。bundle 自带的 `cordis.patch.yml` 会挂载 `test-troubleshooting`，默认读 `config/browser-demo.json`。
2. 再执行 `npm run install:desktop -- --config config/browser-demo.json --browser-only`：管理块只保留 `browserskill` 的 `lazyTools:false` 覆盖，不再插入排障行。两处都写 `test-troubleshooting` 会让同一个 id 挂载两次。
3. 部署后台用的 BrowserSkill 目录不再写进配置：插件启动时按运行 profile 里已安装的包解析（先读 `DSH_PROFILE_DIR`，没有就取 Loader 的 baseUrl），找不到就报错并停在该状态。

bundle 的配置固定为演示配置。公司接入仍用上面的脚本换成 `config/company.json`，此时不要安装 bundle，两种方式二选一；移动项目目录后两种情况都要重新安装。

## 在设置页改运行参数

bundle 安装后，「更多 → 设置 → 智能故障定位」里有四项可以热改：轮询间隔、知识源路径、排障前是否同步代码、群白名单。知识源路径留空时沿用 config 文件里的路径，保存后作用于第一个本地知识源；保存写入当前 profile 的 `cordis.patch.yml` 覆盖层，下一次轮询就按新值执行，不需要重启 Harness，也不重建会话；正在跑的一轮不受影响。「恢复默认」清掉覆盖层，回到 `cordis.patch.yml` 里 bundle 声明的值。

插件页不再提供这一行的配置入口，避免同一份配置出现两个位置。

这四项对应插件的 volatile Config 字段；`plugin.mjs` 声明 `Config` 依赖 `@deepseek-ai/schemastery`，所以项目根要先执行一次 `npm install`（生成 `node_modules/`，bundle 以 `link:` 安装时 pnpm 不会代装依赖）。

其余配置仍是文件级：群接口地址与账号、`adapterModule`、`stateFile`、`catalogFile`、知识源路径都需要重新接线或重启插件，继续在 `config/*.json` 里改；部署后台不需要配置，装好 BrowserSkill 即自动接入；入口和账号写在知识源「部署后台」章节。桌面 bundle 模式以 patch 和设置页为准，`install:desktop` 与 `npm start` 会把所选 config 文件里的同名值写进行配置。

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

安装 BrowserSkill 时，复用该 profile 已启用的 bundle，不再加载第二份。管理块为其追加 `lazyTools:false`，使排障会话能直接调用六个原生工具；这也会使其他会话可见这些原生工具，但排障工具的限制只加在本插件拥有的会话中。

CLI 路径由 BrowserSkill 自身的设置决定；安装时可用 `BSK_PATH` 或项目 `.local/bin/bsk[.exe]` 补齐。浏览器扩展/daemon 仍按 BrowserSkill 原有方式连接；脚本不安装、升级或重建它们。

## 停用与移除

```sh
npm run install:desktop -- --remove
```

只移除脚本管理的配置块，包含它追加的 BrowserSkill 覆盖项；原有 BrowserSkill 设置恢复。状态、证据和备份保留，不删会话。配置重新加载后插件停止；重新安装会继续未处理消息。想改用独立调试模式时，先移除桌面配置再 `npm start`，避免同一状态文件被两个实例占用。

## 公司认证与系统工具

群认证优先复用公司适配器已有的本机凭据机制。若适配器通过环境变量读取 token，变量必须存在于桌面 Harness 进程的环境中；仅在另一个终端临时设置不会传入已运行的 GUI。修改用户环境或 Git/SSH 的 PATH 后，需让 Harness 重新启动并继承这些设置。账号密码不写进安装命令或项目配置。

## 排队与追问

每条 @开发 的新问题进入同一个队列，按到达顺序串行排障。追问或补充消息归回原任务，不会另起任务，也不会丢失原队列位置：任务等待补充期间，后面的任务可以继续处理；补充消息到达后，该任务按最初创建的顺序优先恢复，仍排在之后进入的任务前面。
