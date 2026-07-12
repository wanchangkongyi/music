# cloudflare music

三端（网页/手机/平板）音乐播放器，带歌词锁屏展示、收藏/歌单/播放历史多端同步。


## 前置准备：创建 KV 命名空间

收藏/歌单/历史同步、歌词缓存都依赖 KV 存储，三种部署方式都需要它。

1. Cloudflare Dashboard → **存储和数据库 → KV** → 创建命名空间，比如叫 `music-kv`
2. 记下生成的 **命名空间 ID**，下面会用到

---

## 方式一：Workers Dashboard 部署（最简单，复制代码即可）

1. Cloudflare Dashboard → **Workers & Pages → 创建应用程序 → Workers → 创建 Worker**
2. 起个名字（比如 `otc-music`），创建后进入在线编辑器
3. 打开仓库里的 **[`_worker.js`](./_worker.js)**，全选复制里面的代码，粘贴进编辑器覆盖默认示例代码
4. 点 **部署 (Deploy)**
5. 部署完成后，进项目 → **设置 → 绑定 (Bindings) → 添加 KV 命名空间绑定**：
   - 变量名称填 `MUSIC_KV`（代码里写死的名字，必须一致）
   - 选择前面创建的 KV 命名空间
6. 同一页面 **设置 → 变量 (Variables)** 可选加 `SITE_NAME` / `MUSIC_API_BASE`（不加则用默认值）
7. 保存后自动生效

以后改代码，重新打开在线编辑器复制粘贴新代码、点部署即可，不需要装 Node/wrangler。

<details>
<summary>也可以用 CLI 部署（本地改代码、用 Git 管理更方便）</summary>

```bash
npm install
npx wrangler login          # 首次使用需要授权
```

打开 `wrangler.toml`，把 `id = "<替换为你的 KV 命名空间 ID>"` 换成 KV 命名空间 ID，然后：

```bash
npm run deploy
# 等价于: npx wrangler deploy
```

以后改完代码，重复 `npm run deploy` 即可。环境变量 `SITE_NAME` / `MUSIC_API_BASE` 已经写在 `wrangler.toml` 的 `[vars]` 里，改这个文件就行，不用去 Dashboard 点。

</details>

## 方式二：Cloudflare Pages（Git 集成，push 自动部署）

1. 把这个仓库推到 GitHub
2. Cloudflare Dashboard → **Workers & Pages → 创建应用程序 → Pages → 连接到 Git**，选这个仓库
3. 构建设置：
   - **构建命令**：留空
   - **构建输出目录**：`/`（仓库根目录，因为 `_worker.js` 就在根目录）
4. 部署一次后，进项目 → **设置 → 绑定 (Bindings)** → 添加 **KV 命名空间绑定**：
   - 变量名称填 `MUSIC_KV`（代码里写死的名字，必须一致）
   - 选择前面创建的 KV 命名空间
5. 同一页面下方 **环境变量** 可选加 `SITE_NAME` / `MUSIC_API_BASE`（不加则用默认值）
6. 重新部署一次让绑定生效

之后每次 `git push`，Pages 会自动重新部署。

> 这里特意用 Dashboard 配置绑定、不用 `wrangler.toml`，是因为 Pages 的 Wrangler 配置字段（`pages_build_output_dir`）和 Workers 的（`main`）不是一套东西，硬塞一个文件容易两边都配不对；且一旦给 Pages 项目挂了 Wrangler 配置文件，Dashboard 里对应字段就会变成只读。分开管理最不容易踩坑。

## 方式三：Cloudflare Pages（直接上传，不用 Git）

1. Dashboard → **Workers & Pages → 创建应用程序 → Pages → 上传资产**
2. 把整个仓库文件夹（含 `_worker.js`）拖进去上传，部署
3. 同「方式二」第 4-6 步，去 **设置 → 绑定** 加 KV 命名空间绑定 `MUSIC_KV`，重新部署

以后要更新，重新拖一次文件夹上传即可（会生成新版本）。也可以用 CLI 代替手动拖拽：

```bash
npm run pages:deploy
# 等价于: npx wrangler pages deploy .
```

---

## 本地开发调试

```bash
npm run dev          # 纯 Worker 模式
# 或
npm run pages:dev    # 模拟 Pages 环境
```

本地跑 KV 默认是本地模拟存储，不会影响线上数据。

## 环境变量说明

| 变量 | 作用 | 默认值 |
|---|---|---|
| `SITE_NAME` | 站点标题 | `OTC 音乐网` |
| `MUSIC_API_BASE` | 音源接口域名 | `https://music.haitangw.cc` |

## KV 绑定说明

| 绑定名 | 用途 |
|---|---|
| `MUSIC_KV` | 收藏/歌单/播放历史的多端同步数据 + 歌词缓存 |

三种部署方式**必须**都配好这个绑定，否则同步和歌词缓存会报错（不影响播放、搜索、下载等其他功能）。
