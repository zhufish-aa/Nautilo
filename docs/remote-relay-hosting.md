# 自建中继与公共节点选择

Nautilo 使用 Iroh Relay 1.4.1。PC 的「远程连接 → 连接设置 → 中继模式」可选择 SDK 自带的公共节点或填写自建节点。手机拨号到 PC 公告的中继地址，无需在手机重复选择。PC 的端点身份与配对记录不会因为选择节点而重建。

## 公共节点与延迟

默认列表来自当前 Iroh SDK 的生产环境配置：新加坡、欧洲、北美东部、北美西部。不是任意代理、TURN 或第三方 VPN 节点。

- 「公共节点 · 自动选择」保留 SDK 的节点选择机制。
- 指定公共节点会保存该节点的 HTTPS 地址；自建节点保留已有的多地址设置，最多四个。
- 首次进入中继选择器时测量一次，之后缓存结果；点击「测速」才重新测量。测速不改变配置，不断开已连接的手机。
- 下拉菜单的 ms 是 **PC → 中继的 HTTPS `/ping` 往返时间**，预先建立 DNS/TLS，再测一次热连接响应。遵循当前中继的代理设置。它不等于手机 → PC 的实际 QUIC RTT；设备卡片仍显示后者。
- 「无法测速」表示探测失败，不代表已确诊中继离线。实际连接是否成功仍以远程连接状态和设备卡片为准。

## 服务器要求

自用低并发可从 Linux VPS、1 核 CPU、1 GB RAM 起步，这是运行建议而非官方最低承诺。编译镜像需要更多内存，建议在有至少 4 GB 可用内存的构建机上构建，再分发镜像。服务器需要公网可达、TCP 443，以及与域名或公网 IP 匹配的受信任证书。图片和文件的传输速度主要受带宽影响。

仅使用中继传输时，示例不启用 UDP 7842 的 QAD 服务。不要把它误当成业务中继的必需端口。普通 HTTP 网站、TURN、SOCKS 代理不能代替 Iroh Relay。

## Docker 部署

仓库 `deploy/iroh-relay/` 提供固定 Iroh v1.4.1 的源码构建、Compose 和原生 TLS 配置。无需另加反向代理。

1. 将该目录复制到服务器；准备 `certs/fullchain.pem` 和 `certs/privkey.pem`，证书必须对客户端使用的域名或 IP 有效。
2. 容器以 UID 10001 运行。只允许该 UID 读取私钥，例如目录属主设为 `10001:10001`、目录权限 `750`、私钥权限 `640`。不要使用全员可读的私钥权限。
3. 在该目录执行：

```sh
docker compose build
docker compose up -d
docker compose logs --tail=50 relay
curl --fail https://YOUR_DOMAIN_OR_IP/ping
```

4. 在 PC 选择「自建中继」，填写 `https://YOUR_DOMAIN_OR_IP`，点击「测速」后保存设置。

该模板将宿主机 TCP 443 映射到容器 8443，原生 `/relay` 和 `/ping` 均由 Iroh 服务提供。证书配置采用 `Reloading`，续期文件更新后原生服务会重新加载。应将证书真实文件复制/部署到挂载目录，不能只复制指向目录外的符号链接。

示例 `access = "everyone"` 允许端点使用中继，业务仍由 Nautilo 的端到端身份验证和配对保护。若要限制中继的使用范围，可按 Iroh 官方文档改成端点 ID allowlist，必须包含 PC 和手机的端点 ID。当前 Nautilo 未提供 relay bearer token 输入，不要使用 `shared_token` 配置后把 token 拼进 URL；客户端不接受带凭证的中继 URL。

## 没有域名

可直接使用公网 IPv4/IPv6，但 HTTPS 证书必须包含该 IP 的 SAN，并受系统信任。Let’s Encrypt 已提供约六天有效期的 IP 证书，必须自动续期。Certbot 5.4+ 支持相应申请流程。

使用 standalone 验证时，需开放 TCP 80 并让 Certbot 在该端口完成验证；示例中继仅占用 443，因此无需停止中继。下面的 `YOUR_PUBLIC_IP` 必须替换为实际公网地址，Certbot 也必须先完成安装与注册：

```sh
sudo certbot certonly --standalone \
  --preferred-profile shortlived \
  --ip-address YOUR_PUBLIC_IP
```

配置 Certbot 的续期 timer 与 deploy hook：续期后把 `fullchain.pem`、`privkey.pem` 复制到 Compose 的 `certs/`，保持上述目录属主和权限。以 HTTPS 的 `/ping` 验证证书和可达性，不要跳过证书验证。普通自签证书默认不受 Nautilo 信任。

参考：

- [Iroh v1.4.1 Relay README](https://github.com/n0-computer/iroh/blob/v1.4.1/iroh-relay/README.md)
- [Iroh 1.4.1 配置和 Reloading 实现](https://github.com/n0-computer/iroh/blob/v1.4.1/iroh-relay/src/main.rs)
- [Let’s Encrypt IP 证书公告](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
- [Certbot 的 IP 证书申请流程](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

模板已依据固定版本源码核对字段；未在用户的公网服务器上实际部署。
