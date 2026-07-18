# 成绩速查

面向西安理工大学本科教务系统的非官方成绩看板。用户在同一个网页中完成验证码登录后，系统自动查询全部可用学期并计算加权平均分、加权平均绩点、学分和学期趋势。

## 功能

- 手机和电脑浏览器直接使用，无需安装扩展或本地服务
- 官方验证码登录，自动遍历全部学期
- 学年、学期、课程性质筛选
- 加权平均分、加权平均绩点和已获学分
- 学期分析、课程明细、CSV 导入导出
- 账号和密码不写入数据库或浏览器存储
- 上游会话使用 AES-256-GCM 加密，并通过短时 `HttpOnly` Cookie 保存

## 架构

- `index.html`：静态单页应用
- `functions/api/[[path]].js`：Cloudflare Pages Function
- `/api/captcha`：建立上游会话并代理验证码
- `/api/login`：转发一次性登录请求
- `/api/grades`：自动获取全部学期成绩表
- `/api/logout`：立即清除加密会话

成绩数据解析后仅保存在用户当前浏览器的 `localStorage`。Pages Function 不使用数据库，不保存账号、密码或成绩。

## 本地运行

1. 安装 Node.js 20 或更新版本。
2. 安装依赖：

   ```bash
   npm install
   ```

3. 复制 `.dev.vars.example` 为 `.dev.vars`，生成 32 字节随机密钥：

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. 把生成的 64 位十六进制内容写入 `.dev.vars` 的 `SESSION_SECRET`。
5. 启动：

   ```bash
   npm run dev
   ```

## Cloudflare Pages 部署

1. 将项目推送到 GitHub 仓库。
2. 在 Cloudflare 控制台进入 **Workers & Pages → Create → Pages → Connect to Git**。
3. 选择仓库，生产分支设置为 `main`。
4. 构建命令留空，构建输出目录填写 `public`。
5. 在 **Settings → Variables and Secrets** 添加加密 Secret：
   - 名称：`SESSION_SECRET`
   - 值：使用上面的 Node.js 命令生成，必须是 64 位十六进制字符。
6. 部署后打开 `*.pages.dev` 地址测试验证码、错误密码、全部成绩获取和退出登录。
7. 建议在 Cloudflare 中将 Functions 配置为 **Fail closed**，并为 `/api/captcha` 与 `/api/login` 添加速率限制。

每次推送到 GitHub 后，Cloudflare Pages 会自动重新部署。

## 发布前检查

- 阅读并根据实际运营者信息修改 `privacy.html`
- 取得学校或系统管理方对自动查询的许可
- 确认 Pages Function 日志没有记录请求体或响应正文
- 配置 API 速率限制，避免被用于高频访问教务系统
- 使用独立 Cloudflare 项目和强随机 `SESSION_SECRET`
- 不要把 `.dev.vars`、`.env` 或任何真实账号提交到 GitHub

## 免责声明

本项目为非官方辅助工具，统计结果仅供参考，正式成绩以学校教务系统为准。部署者应自行确认学校规定、个人信息保护要求和第三方平台使用条款。
