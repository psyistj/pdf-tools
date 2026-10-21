# PDF Tools 静态部署

线上地址：https://hub.plustech.cc/pdf-tools/

站点由现有 Nginx 网关静态托管。解析、渲染、裁剪和导出都在浏览器内完成。**不部署** Node 运行时、容器、监听端口或数据库，也不改共享网关里的其他 location。本目录只提供 `/pdf-tools/` 片段和发布脚本。

## 发布

在项目根目录、检查通过后执行：

```sh
node --test tests/unit.test.mjs
python3 -m unittest discover -s deploy -p 'test_*.py' -v
node tests/e2e-check.mjs

RELEASE=$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)
STAGE=/home/ecs-user/.cache/pdf-tools-deploy/$RELEASE
SSH='ssh -p 22 -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 -o ControlMaster=no -o ControlPath=none'

$SSH ecs-user@106.14.204.185 "mkdir -p '$STAGE' && chmod 700 '$STAGE'"
tar -czf "$TMPDIR/pdf-tools-$RELEASE.tar.gz" index.html style.css favicon.svg src vendor
scp -p -P 22 -o BatchMode=yes -o StrictHostKeyChecking=yes \
  "$TMPDIR/pdf-tools-$RELEASE.tar.gz" deploy/nginx-location.conf deploy/remote-deploy.py \
  ecs-user@106.14.204.185:$STAGE/
$SSH ecs-user@106.14.204.185 "sudo -n python3 '$STAGE/remote-deploy.py' \
  --archive '$STAGE/pdf-tools-$RELEASE.tar.gz' --routes '$STAGE/nginx-location.conf' --release '$RELEASE'"
curl -fsSI https://hub.plustech.cc/pdf-tools/
```

脚本拒绝未知的 domain 布局。它把公开产物解压到 `/srv/pdf-tools/releases/<release>`，把 domain、routes 和上一个 release 备份到 `/srv/pdf-tools/backups/`，原子切换 `current`，用 `nginx -t -c /etc/nginx/novelco-gateway.conf` 校验真实生效配置，再 `systemctl reload nginx`。冒烟检查 `/pdf-tools/`、`/`、`/qr/`、`/id-photo/`、`/ag/`。任何一步失败都会回滚 domain、routes 和 `current` 符号链接。

页面里的 CSP `<meta>` 与 Nginx 头一致，但去掉了 `frame-ancestors`：这个指令写在 meta 里会被浏览器忽略并在控制台报错，只在响应头里生效。

打包内容是 `index.html`、`style.css`、`favicon.svg`、`src/`、`vendor/`。**不要**把测试、部署脚本、`node_modules` 或凭据打进公开 release。`/pdf-tools` 会 308 到 `/pdf-tools/` 并保留查询串。页面与资源一律 `Cache-Control: no-cache`。

导航条目不在本次发布范围内，由调用方之后接到 pagerouter。

## 回滚

部署脚本会打印备份目录。`previous-release.txt` 记录上一个 release 的路径。恢复备份里的 `pagerouter-domain.conf`；若此前没有 `pdf-tools.locations.conf`，删除该文件，否则用备份覆盖。然后把 `/srv/pdf-tools/current` 指回 `previous-release.txt` 中的路径（首次部署则删除 `current`），再执行：

```sh
sudo nginx -t -c /etc/nginx/novelco-gateway.conf && sudo systemctl reload nginx
```

保留历史 release 目录，便于再次切回。
