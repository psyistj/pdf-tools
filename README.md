# PDF Tools

纯客户端、可离线使用的 PDF 工具集。第一个模块是**单页裁剪导出**：在浏览器里打开 PDF，只对当前页设置裁剪框，再导出矢量 PDF 或 PNG / JPG。

文件不会上传，没有埋点，也不会写 cookie。解析用本地的 pdf.js 4.10.38，矢量导出用本地的 pdf-lib 1.17.1。不需要 webpack 或 vite。

## 本地预览

```sh
npm run preview
```

打开 http://127.0.0.1:4173/pdf-tools/ 。相对路径同样支持直接挂在站点根目录。不要用 `file://` 打开，模块 worker 会被浏览器拦截。

## 检查

```sh
node --test tests/unit.test.mjs
python3 -m unittest discover -s deploy -p 'test_*.py' -v
node tests/e2e-check.mjs
```

`tests/e2e-check.mjs` 会自己起静态服务，并用本机 headless Chrome 打开 `/pdf-tools/` 子路径。

## 单页裁剪

- 选择文件、拖拽到工作区，或 `Ctrl` / `⌘` + `V` 粘贴。只接受 `application/pdf`。
- 左侧缩略图滚动到可视区域才渲染。页码框、上一页 / 下一页，以及页面列表里的 ←/→ 用来翻页。
- 预览按容器 contain 显示，分辨率跟随 `devicePixelRatio`，并有像素上限。
- 裁剪框可拖动，有 8 个控制点。比例包括自由、1:1、4:3、3:4、16:9、A4 纵向、A4 横向、身份证（85.6×54 mm）。
- X / Y / 宽 / 高可用 px 或 mm，mm 与 px 按 300 DPI 换算。全选、重置、居中可用。
- 预览区方向键微调 1px，Shift 为 10px；`⌘` / `Ctrl` + ←/→ 在任意位置翻页。
- 矢量 PDF 只保留当前页，并写入 MediaBox 与 CropBox。PNG / JPG 可选 96 / 150 / 300 / 600 DPI，JPG 有质量滑块。
- 超过 100MB 会先确认再继续；超过 500 页会提示性能风险，不阻断操作。

## 部署

只新增 `/pdf-tools/` 的 Nginx 片段，见 [deploy/README.md](deploy/README.md)。不修改 pagerouter 或 ID Photo Studio 仓库。

## 已知限制

- 不打开加密或需要密码的 PDF。
- 矢量导出通过 CropBox / MediaBox 裁切，裁剪区域外的内容流仍留在文件里，查看器不显示，体积也不一定会变小。
- 栅格导出上限约 4000 万像素，超出时提示降低 DPI 或缩小裁剪框。
- 超大页面的预览会降低渲染倍率，屏幕上可能比导出结果略糊。
- 栅格结果是 pdf.js 的绘制结果；注释和表单以画布上看到的为准。矢量导出保留原页面对象。
- JPG 使用白底，不保留透明。
- 需要通过 HTTP 访问。`file://` 下 pdf.js 的 module worker 无法启动。
- 当前只有单页裁剪，没有多页批量导出。
