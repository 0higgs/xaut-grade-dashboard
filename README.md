# 成绩与课表速查

面向西安理工大学本科教务系统的非官方成绩、课表、考试安排与执行计划看板。用户在同一个网页中完成验证码登录后，系统自动查询全部可用学期成绩、当前理论课表、考试安排和培养方案执行计划，并计算加权平均分、加权平均绩点、学分和学期趋势。

## 功能

- 手机和电脑浏览器直接使用，无需安装扩展或本地服务
- 官方验证码登录，自动遍历全部学期
- 学年、学期、课程性质筛选
- 加权平均分、加权平均绩点和已获学分
- 学期分析、课程明细、CSV 导入导出
- 自动读取“培养管理 → 我的课表 → 学期理论课表”，支持切换学期
- 直接读取教务系统首页官方本周课表，展示当天课表、当前课程和下一节课
- 自动读取“我的考试 → 考试安排查询”，支持切换学期、搜索课程并显示下一门考试
- 自动读取“培养管理 → 执行计划”，支持学期、类别与关键词筛选，并结合成绩标记完成情况
- 可选择在本机缓存完整查询结果 7 天或 30 天，期间无需登录即可查看
- 可选的考试邮件提醒（提前 3 天、24 小时或 2 小时），启用前必须验证邮箱
- 账号和密码不写入数据库或浏览器存储
- 上游会话使用 AES-256-GCM 加密，并通过短时 `HttpOnly` Cookie 保存

Pages Functions 仅通过学校官方 HTTPS 教务域名转发请求；非 HTTPS 上游地址会被拒绝。

## 架构

- `index.html`：静态单页应用
- `functions/api/[[path]].js`：Cloudflare Pages Function
- `/api/captcha`：建立上游会话并代理验证码
- `/api/login`：转发一次性登录请求
- `/api/grades`：自动获取全部学期成绩表
- `/api/schedule`：获取可用学期和所选学期理论课表
- `/api/week-schedule`：读取教务系统首页的当前周次、日期和本周课程
- `/api/exams`：读取可用学期和个人考试时间、考场、座位号等安排
- `/api/plan`：读取并结构化解析培养方案执行计划
- `/api/logout`：立即清除加密会话
- `/api/reminders/*`：订阅、验证、查询、停用和删除考试提醒
- `src/reminder-worker.js`：每 15 分钟扫描到期任务并通过 Resend 发信
- `migrations/0001_exam_reminders.sql`：D1 提醒订阅、考试和发送任务表

成绩、课表、考试安排与执行计划按用户选择在当前浏览器的 `localStorage` 中缓存 7 天或 30 天。只有用户主动开启邮件提醒时，邮箱、提醒时间和未来考试的必要信息才会保存到 D1；服务端不保存账号、密码、验证码、成绩或课表。

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

## 考试邮件提醒部署

邮件提醒使用 Cloudflare D1、Cron Worker 和 Resend。需要一个已在 Resend 验证的发信域名。

1. 创建 D1 并把数据库 ID 同时填写到 `wrangler.jsonc` 和 `wrangler.reminders.jsonc`。
2. 应用结构：`npx wrangler d1 migrations apply xaut-exam-reminders --remote --config wrangler.reminders.jsonc`。
3. 将 `REMINDER_FROM` 设置为已验证域名下的发件地址；当前生产环境使用 `XAUT 考试提醒 <reminders@xautjw.cn>`。
4. 分别为 Pages 项目和定时 Worker 设置 `RESEND_API_KEY` Secret，不能写进仓库。
5. 部署 Pages，再执行 `npx wrangler deploy --config wrangler.reminders.jsonc` 部署定时 Worker。

订阅默认处于待验证状态，用户点击验证邮件后才会开始发送。用户可以从网页停用提醒或彻底删除邮箱和提醒数据；最后一门考试结束 30 天后数据会自动清理。

## 发布前检查

- 阅读并根据实际运营者信息修改 `privacy.html`
- 取得学校或系统管理方对自动查询的许可
- 确认 Pages Function 日志没有记录请求体或响应正文
- 配置 API 速率限制，避免被用于高频访问教务系统
- 使用独立 Cloudflare 项目和强随机 `SESSION_SECRET`
- 不要把 `.dev.vars`、`.env` 或任何真实账号提交到 GitHub

## 免责声明

本项目为非官方辅助工具，统计结果仅供参考，正式成绩以学校教务系统为准。部署者应自行确认学校规定、个人信息保护要求和第三方平台使用条款。
