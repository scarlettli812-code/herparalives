# 她的平行人生 Web

移动端优先的轻量人生模拟游戏。当前版本已包含完整的本地 Demo 闭环：游客进入、预设与自定义角色、五章剧情、三选一、因果状态与事件账本、章节 Coach、人生地图、回溯分支、固定角色视觉、阶段结局和图鉴。

## 本地运行

```bash
pnpm install
pnpm dev
```

打开 `http://localhost:3000`。未配置云服务时自动使用安全模板与浏览器本地存储，团队演示不依赖模型。

## 环境变量

复制 `.env.example` 为 `.env.local`，填写百炼和 CloudBase 凭证。所有密钥只允许存在服务端环境变量，不得使用 `NEXT_PUBLIC_` 前缀。

## 内容发布

预设内容目前位于 `lib/presets.ts`，API 通过 `/api/presets` 提供带版本的只读内容。接入飞书发布脚本时，应将审核后的内容转换为相同结构并冻结为版本化 JSON；Demo 环境只引用冻结版本。

## 部署

1. 在 EdgeOne Makers 导入此目录，框架选择 Next.js。
2. 为 `development / staging / demo / production` 分别配置环境变量与 CloudBase 环境。
3. Demo 使用平台临时域名；正式域名完成 ICP 备案后再绑定。
4. 发布前执行 `pnpm build`，并在 375、390、430px 与桌面宽屏完成验收。

故事生成 V4 的因果模型、生成状态和失败验收矩阵见 [STORY_GENERATION_V4.md](./STORY_GENERATION_V4.md)。

## 数据安全约束

- 原始处境仅存在于生成请求内，不进入数据库、分析事件和错误日志。
- 浏览器 Demo 会话 24 小时过期。
- 危机内容停止游戏化生成并返回现实安全提示。
- 五维只记录变化，不计算幸福总分。
- 模型不可用时回退到安全故事模板，预设故事始终可玩。
