# Vendor

运行时只使用这里的本地文件，页面不会请求 CDN。

| 包 | 版本 | 许可证 | 运行时文件 |
| --- | --- | --- | --- |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | 4.10.38 | Apache-2.0 | `pdfjs/pdf.min.mjs`、`pdfjs/pdf.worker.min.mjs`、`pdfjs/cmaps/`、`pdfjs/standard_fonts/` |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | `pdf-lib/pdf-lib.esm.min.js` |

许可证原文：

- `pdfjs/LICENSE`（Apache-2.0）
- `pdfjs/standard_fonts/LICENSE_FOXIT`、`pdfjs/standard_fonts/LICENSE_LIBERATION`
- `pdf-lib/LICENSE.md`（MIT）

`pdf.worker.min.mjs` 已内嵌图像解码器，因此没有再复制 `image_decoders/`。`pdf-lib.esm.min.js` 去掉了末尾的 `sourceMappingURL`，避免浏览器去请求不存在的 map。

刷新产物时在临时目录执行：

```sh
npm pack pdfjs-dist@4.10.38 pdf-lib@1.17.1
```

然后只复制上表中的文件。不要把 `node_modules` 或 source map 放进本仓库。
