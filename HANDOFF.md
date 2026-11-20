# 小红书 AI 读取项目交接文档

## 项目目标

在手机 RikkaHub 中直接发送小红书链接，AI 自动读取标题、正文、作者、图片和评论摘要。不需要手动复制内容，也不需要鸿蒙无障碍权限。

## 工作流程

RikkaHub → Railway → 识别小红书链接 → 跟随 xhslink.cn 短链 → 读取文字、图片和评论 → 图片转 Base64 → 发送给 DeepSeek 或 OpenAI。

## 主要文件

- `index.js`：后端、解析小红书、图片处理、AI 转发
- `package.json`：Node.js 配置
- `README.md`：项目说明
- `HANDOFF.md`：本交接文档

## Railway 环境变量

必须设置：

`PROXY_API_KEY=自己设置的代理密码`

`DEEPSEEK_BASE_URL=中转站的 Base URL`

`DEEPSEEK_API_KEY=中转站 API Key`

`DEEPSEEK_MODEL=中转站支持的模型名称`

如果使用 OpenAI：

`OPENAI_BASE_URL=https://api.openai.com/v1`

`OPENAI_API_KEY=OpenAI API Key`

`OPENAI_MODEL=支持图片输入的模型名称`

注意：

- `DEEPSEEK_API_KEY` 不要填进 RikkaHub。
- RikkaHub 填的是 `PROXY_API_KEY`。
- Base URL 不要写 `/chat/completions`。
- API Key 不要提交到 GitHub。
- 修改 Railway 变量后必须点击 `Deploy`。

## RikkaHub 配置

DeepSeek：

- 类型：`OpenAI Compatible`
- Base URL：`https://你的Railway域名/v1/deepseek`
- API Path：`/chat/completions`
- API Key：Railway 中的 `PROXY_API_KEY`
- 模型：`DEEPSEEK_MODEL` 的值

OpenAI：

- 类型：`OpenAI Compatible`
- Base URL：`https://你的Railway域名/v1/openai`
- API Path：`/chat/completions`
- API Key：Railway 中的 `PROXY_API_KEY`
- 模型：`OPENAI_MODEL` 的值

## 主要接口

健康检查：`GET /`

DeepSeek 对话：`POST /v1/deepseek/chat/completions`

OpenAI 对话：`POST /v1/openai/chat/completions`

结构化解析：`GET /api/parse?url=小红书链接`

结构化解析需要请求头：

`Authorization: Bearer PROXY_API_KEY`

## 修改位置

小红书解析：`parseXhs()`、`readInitialState()`、`readMeta()`

图片处理：`imageToBase64()`、`buildXhsMessage()`

AI 转发：`getProvider()`、`chatHandler()`

接口密码：`requireProxyKey()`

## 常见错误

`Application not found`

说明 Railway 域名失效。到 Railway → 服务 → Settings → Networking → Public Networking，复制当前公网域名，然后更新 RikkaHub 的 Base URL。

`PROXY_API_KEY is not configured`

检查变量名是否完全为 `PROXY_API_KEY`，是否在 `production` 环境，以及是否点击了 `Deploy`。

`Invalid API key`

RikkaHub 中的 API Key 和 Railway 的 `PROXY_API_KEY` 不一致。

`AI provider is not configured`

检查 `DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`。

`Cannot find note data`

可能是小红书页面结构改变、笔记需要登录、笔记已删除，或者新代码没有部署成功。

AI 只有思考没有最终回答：

检查 `index.js` 中是否保留 `const stream = req.body.stream === true;`，并且发送给上游 AI 时使用 `stream`。

## 测试方法

在 RikkaHub 发送：

请读取这个小红书链接，并告诉我标题、正文摘要、图片内容和评论区主要观点：

https://xhslink.cn/o/7TIAfyJTtSw

如果 AI 能回答标题、正文、图片和评论，说明项目正常。

## 维护说明

通常不需要为每个新链接修改代码。

只有小红书网页结构变化、中转站地址变化、模型名称变化、Railway 域名变化或 RikkaHub 接口格式变化时，才需要维护。
