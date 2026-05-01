# Gemini Web Brancher

一个 Chrome MV3 扩展原型：在 Gemini Web 的最新回复下插入 `Branch` 按钮，点击后用 Gemini 的分享链接创建一个最小化分支 worker 窗口，并把这个分支会话的输入和输出镜像回当前页面。

> 当前项目不调用 Gemini 可能存在的原生 branch 功能。MVP 只走「分享链接 + 最小化 worker 窗口 + 页面镜像」方案。

## 当前状态

- 可直接作为「加载已解压的扩展」安装。
- 支持在 `https://gemini.google.com/*` 注入 Branch UI。
- 点击 Branch 后自动尝试打开 Gemini 分享面板、创建/复制分享链接。
- 创建临时可见的 popup worker 窗口作为 branch 会话，ready 后自动最小化。
- 在原页面每个 branch 面板里输入 prompt，并转发到对应 worker 窗口。
- 从 worker 窗口监听最新 Gemini 回复文本，并同步显示到原页面。
- Branch 会持续等待 Gemini 生成分享链接，并自动完成链接提取。
- 可用页面里的 Mark Trunk 按钮把当前主对话标题标记为 `--TRUNK`；创建 branch 时不会自动弹出重命名窗口。
- Branch 面板会按当前主对话分组显示，并最多三列并排显示，桌面端宽度为页面宽度减去 160px。
- 主页面会主动轮询正在生成的 branch worker，并忽略 Gemini 的中间理解/思考状态，等真实回答稳定后才结束回传。
- 关闭 branch 后不会继续占用编号，新建 branch 会按当前可见分支重新编号。
- 可从 branch 面板或扩展弹窗打开 branch worker 窗口进行人工排查。

## 重要限制

1. Gemini 的分享链接是公开链接。这个扩展会为了创建分支而触发公开分享链接，敏感内容不要使用。
2. Gemini Web 没有公开稳定的页面自动化 API，按钮文案和 DOM 改版都会影响成功率。
3. Chrome 扩展无法真正运行一个完全不可见的第三方 Gemini 页面。MVP 会短暂打开 popup worker 窗口，等 Gemini 输入框 ready 后再自动最小化。
4. Workspace 管理员、账号类型、地区、年龄或 Gemini 产品限制都可能阻止分享或继续聊天。
5. 当前只面向文字对话。文件、图片、Canvas、Deep Research 等复杂上下文没有保证。
6. 扩展声明了 `clipboardRead` 权限，用于自动读取 Gemini 复制出的分享链接。

## 本地安装

### 从 GitHub 下载源码 zip 安装

1. 在 GitHub 仓库点击 Code -> Download ZIP。
2. 解压 zip。
3. 找到里面真正包含 `manifest.json` 的文件夹。通常是：

   ```text
   gemini-web-brancher-main/
     manifest.json
     src/
     README.md
   ```

4. 打开 Chrome: `chrome://extensions`
5. 开启 Developer mode
6. 选择 Load unpacked
7. 选择第 3 步那个包含 `manifest.json` 的文件夹。
8. 打开 `https://gemini.google.com/app` 并开始一段对话。

如果 Chrome 提示「清单文件缺失或不可读取」，说明选中的目录不是扩展根目录。不要选择 zip 文件、下载目录、外层解压目录、`src`、`docs` 或 `dist`；请选择第一层就能看见 `manifest.json` 的目录。

### 从构建包安装

如果你拿到的是 `gemini-web-brancher.zip` 构建包，先解压它，然后在 Load unpacked 里选择解压后的文件夹。该文件夹第一层也必须能看到 `manifest.json`。

## 开发命令

```bash
npm run validate
npm run package
```

`npm run package` 会生成 `dist/gemini-web-brancher.zip`。

## 架构

- `src/content/content-script.js`
  - 注入 Gemini 页面 UI
  - 自动提取分享链接
  - 在 branch worker 窗口中自动点击继续聊天
  - 在 branch worker 窗口中提交 prompt 并监听回复
- `src/background/service-worker.js`
  - 管理 branch 状态
  - 创建最小化 worker 窗口
  - 在 parent tab 和 branch worker 窗口之间转发消息
- `src/popup/*`
  - 展示当前已创建 branch 和隐私提示

## 路线图

- 更强的 Gemini DOM selector 适配。
- 更强的自动复制分享链接 fallback。
- 更强的主对话 `--TRUNK` 手动标记。
- 更准确的流式输出结束检测和中间状态识别。
- 支持导出 branch 树。

## 隐私

见 [docs/PRIVACY.md](docs/PRIVACY.md)。
