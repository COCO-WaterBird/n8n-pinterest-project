# n8n：表格数据 → Pinterest 发 Pin

用 n8n 从 **Google Sheet** 或 **本地 Excel（.xlsx，Docker 挂载）** 读取 `board_id`、`title`、`description`、`alt`、`link`、`image_url`，调用 [Pinterest API v5](https://developers.pinterest.com/docs/api/v5/) 创建 Pin。

## 仓库内容

| 路径 | 说明 |
|------|------|
| `workflows/pinterest-pins-from-sheet.json` | 主流程：Google Sheet → POST `/v5/pins` |
| `workflows/pinterest-pins-from-xlsx-docker.json` | 主流程：**本地** `pins.xlsx`（容器内 `/data`）→ 解析 → POST `/v5/pins` |
| `workflows/pinterest-list-boards.json` | 辅助：GET `/v5/boards` 查看 `board_id` |
| `sheet-data/` | 宿主机放 `pins.xlsx`，挂载为容器 `/data`（见 `docker-compose.yml`） |
| `sheet-template/headers.csv` | 表头模板（可导入或复制到首行） |
| `docker-compose.yml` | 本地跑 n8n 并注入环境变量 |
| `.env.example` | 环境变量模板 |
| `scripts/pinterest-login.mjs` | 浏览器登录 Pinterest 并换取 `access_token`（OAuth2） |
| `package.json` | `npm run pinterest:login` 快捷命令 |

## 用脚本登录 Pinterest 并获取 token

1. 打开 [Pinterest Developers](https://developers.pinterest.com/apps/) → 你的应用 → **Manage**，在 **Redirect link** 里添加：  
   `http://localhost:8085/`  
   （若改端口，须同步改 `.env` 里的 `PINTEREST_REDIRECT_URI`，并与后台**逐字一致**。）
2. 在 `.env` 中填写 `PINTEREST_APP_ID`、`PINTEREST_APP_SECRET`（应用 ID 与 Secret）。  
3. Sandbox 应用在换 token 时通常使用 `PINTEREST_API_URI=https://api-sandbox.pinterest.com`；生产用 `https://api.pinterest.com`。  
4. 在项目根目录执行：

```bash
npm run pinterest:login
# 或：node scripts/pinterest-login.mjs
```

浏览器会打开 Pinterest 登录与授权；成功后终端会打印 **PINTEREST_ACCESS_TOKEN**，并写入 `local-files/pinterest-token.json`（该目录已在 `.gitignore` 中忽略）。把 token 复制到 `.env` 的 `PINTEREST_ACCESS_TOKEN` 即可配合 n8n / Docker 使用。

## 审核演示（完整 OAuth + Integration 可见）

为避免被反馈“未展示完整 OAuth flow / 未展示 Pinterest integration”，可按下面录屏：

1. 展示产品里触发授权的入口（或终端执行 `npm run pinterest:login` 作为本地授权入口）。  
2. 录到浏览器跳转 Pinterest 授权页，用户登录并同意授权。  
3. 录到回调成功页与终端显示 token（可打码），证明 **OAuth code → token** 完整闭环。  
4. 执行：

```bash
npm run pinterest:demo
```

脚本会调用 `GET /v5/user_account` 和 `GET /v5/boards`，用于证明你的产品已真实连上 Pinterest（不是只展示表单/文档）。

5. 如需演示“仅在明确同意后执行写操作”，执行：

```bash
npm run pinterest:demo -- --create-pin
```

脚本会二次询问同意词 `I CONSENT`，只有输入正确才调用 `POST /v5/pins`；不输入则取消，不会代用户执行。

### 可录屏的 Connect Pinterest 页面（推荐）

如果你要严格按审核要求展示“从点击 Connect Pinterest 开始”的完整流程，可直接运行：

```bash
npm run pinterest:oauth-demo
```

然后在浏览器打开 `http://127.0.0.1:<端口>`（端口与 `.env` 里 `PINTEREST_REDIRECT_URI` 一致，例如 `http://localhost:3000/pinterest/callback` 则打开 `http://127.0.0.1:3000`），按以下顺序录屏：

1. 点击 **Connect Pinterest**。  
2. 跳转 Pinterest 官方登录/授权页，展示权限说明并点击授权。  
3. 跳回本地 Demo 页面，显示 **Connected Successfully** 与 `GET /v5/user_account` 返回数据。  
4. 点击 **Load Boards**，展示 `GET /v5/boards` 返回数据（证明真实 integration）。  
5. 点击 **Load PinterestDoc Rows** 从 `sheet-data/pinterestdoc.xlsx` 读取候选内容，选择单条素材后可自动填充表单。  
6. 在页面中确认目标 board 与单条 Pin 素材（title/image），完成一次性审批。  
7. 点击 **Publish this pin**，输入 `I CONSENT` 后才会调用 `POST /v5/pins`（体现“用户逐条决策”，非批量无感自动化）。

## 快速开始

### 1. Google 表格

第一行表头建议与模板一致：

`board_id`, `title`, `description`, `alt`, `link`, `image_url`

- `image_url`：公网 **HTTPS** 直链，Pinterest 能访问。
- `board_id`：可先导入 **list boards** 工作流，执行后在输出里复制。

### 2. Pinterest 开发者

1. 在 [Pinterest Developers](https://developers.pinterest.com/) 创建应用，配置 Redirect link，使用上文 **用脚本登录** 或自行走 OAuth 取得 **access token**。  
2. Sandbox 使用 `https://api-sandbox.pinterest.com`；上线后改用 `https://api.pinterest.com` 与生产 token。

### 3. 本地 n8n（Docker）

```bash
cp .env.example .env
# 编辑 .env，填入 PINTEREST_ACCESS_TOKEN（可选改 PINTEREST_API_BASE）
docker compose up -d
```

浏览器打开 `http://localhost:5678`，完成向导。

### 4. 导入工作流（二选一）

**A. Google Sheet 版** `workflows/pinterest-pins-from-sheet.json`  

1. 打开 **Pin data**（Google Sheets）：连接 **Google Sheets OAuth2**（或 Service Account），选择表格与工作表；**By ID** 时把占位换成表格 ID。  
2. **API Pinterest** 默认读环境变量 `PINTEREST_ACCESS_TOKEN`、`PINTEREST_API_BASE`；无环境变量时可改用 [Header Auth](https://docs.n8n.io/integrations/builtin/credentials/httprequest/#header-auth)。  
3. 不需要定时跑时，断开 **Daily schedule → Pin data**。

**B. 本地 XLSX 版（Docker）** `workflows/pinterest-pins-from-xlsx-docker.json`  

1. 在宿主机将 Excel 保存为 **`sheet-data/pins.xlsx`**（首行表头与上文一致）。`docker-compose.yml` 已把 `./sheet-data` 只读挂载到容器 **`/data`**，并设置 `N8N_RESTRICT_FILE_ACCESS_TO=/data`（n8n 2.x 下读盘节点通常需要白名单目录）。  
2. 导入工作流后，**Read pins.xlsx** 默认路径为 **`/data/pins.xlsx`**；换文件名或子目录时请同步修改 **File(s) Selector**。  
3. **Extract pin rows** 使用「Extract From XLSX」；若表不在第一个 Sheet，在 **Options → Sheet Name** 填写工作表名称。  
4. 若升级 n8n 后读盘仍报错，可查 [Security 环境变量](https://docs.n8n.io/hosting/configuration/environment-variables/security/)，视版本补充 `N8N_FILE_ACCESS_WHITELIST` 等（与官方文档保持一致）。  
5. 宿主目录权限：容器内 n8n 一般以 `node`（常见 UID **1000**）运行，若遇权限问题可执行：`sudo chown -R 1000:1000 sheet-data`。

### 5. 导入「查 Board ID」辅助流

导入 `workflows/pinterest-list-boards.json`，执行后查看返回 JSON 中的 `id` 填入表格 `board_id` 列。

## 数据列与 API 对应

| 列名 | Pinterest 请求字段 |
|------|---------------------|
| `board_id` | `board_id` |
| `title` | `title` |
| `description` | `description` |
| `alt` | `alt_text` |
| `link` | `link`（空则不发该字段） |
| `image_url` | `media_source.url`（`source_type`: `image_url`） |

若执行后字段对不上，在 n8n **Executions** 里看 **Pin data** 输出的 JSON 键名，可能与表头不完全一致（例如多出空格），再在 **API Pinterest** 里把表达式改成实际路径。

## 安全

- 勿将 `.env` 或含 token 的导出 JSON 提交到 Git。  
- 本仓库已忽略 `.env`、`.n8n/`（见 `.gitignore`）。

## 许可

按你的需要自行补充；流程与配置仅供参考，以 Pinterest / Google 当前文档为准。
