# cafe astro blog

cafe自己摸一摸出来的blog项目，使用[astro](https://github.com/withastro/astro)框架

诶诶……还能写什么唔唔……

## 文章控制台（本地写文章用的 GUI）

```bash
pnpm admin        # → http://127.0.0.1:8361
```

只监听 `127.0.0.1`，页面放在 `server/admin/`（不在 `public/` 里，所以不会被构建进 `dist/`，生产站点零改动）。写操作全部限制在 `src/content/blog/` 与 `src/assets/` 内，并校验 `Origin`/`Host`，挡掉其它网页隔空调用本机接口。

界面分三栏：

- **左**：文章列表，可搜标题 / slug / 标签，草稿带角标，`＋ 新建`
- **中**：frontmatter 表单（标题、slug 自动生成可改、摘要、日期、更新日期、标签、草稿、MDX）+ Markdown 编辑器（工具条、`Ctrl+S` 保存、离开前拦未保存改动）
- **右**：三个标签页
  - **预览**：iframe 嵌真实的 astro dev 页面，保存后自动刷新；顶栏可以一键启动/停止 dev server、看它的日志
  - **封面图**：上传或点选 `src/assets/` 里的图片，自动换算成 `image()` 需要的相对路径（上传会按文件头校验是不是真图片）
  - **发布**：一键跑 `pnpm build`（astro build + pagefind），日志实时滚；下方是 git 改动列表 + 提交信息 + 提交并推送（新分支自动用 `git push -u origin <branch>`）

几个约定：

- 重命名文章（改 slug）会弹确认，因为 URL 会变、旧链接会 404
- `draft: true` 目前只把文章从首页 / 列表 / 标签 / 归档里隐藏；`src/pages/blog/[...slug].astro` 和 `src/pages/rss.xml.js` 用的是未过滤的 `getCollection`，草稿页仍会被构建、可被 URL 访问并进入 RSS。界面上有对应提示。
- 端口被占用时：`ADMIN_PORT=8362 pnpm admin`

## 开发

```bash
pnpm astro dev --background   # 起开发服务器（status / logs / stop 管理）
pnpm test                     # node:test 单元测试
pnpm build                    # 构建 + pagefind 搜索索引
```
