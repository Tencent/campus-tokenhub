# 在 Linux 服务器上安装 CodeBuddy CLI

[`QUICKSTART.md`](QUICKSTART.md) 是给 CodeBuddy CLI 执行的部署指引。本文只做一件事：把 CLI 装上。三步，五分钟。

支持 Ubuntu 和 CentOS。

---

## 1. 先装 Node

CodeBuddy CLI 要求 **Node.js ≥ 18.20**，系统自带的都不够：Ubuntu 22.04 是 12.22，Ubuntu 24.04 是 18.19（就差一点）。**不要用 `apt install nodejs` / `yum install nodejs`**，用官方源装 Node 22：

```bash
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS（8 及以上）
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
```

确认装了（npm 随 Node 一起来，不用单独装）：

```bash
node --version    # v22.x
npm --version
```

## 2. 装 CodeBuddy CLI

```bash
npm install -g @tencent-ai/codebuddy-code
codebuddy --version
```

输出版本号就成功了。报错看这两条：

| 报错 | 处理 |
| --- | --- |
| `EACCES` 权限不足 | **不要加 sudo**。`npm config set prefix "$HOME/.npm-global"`，再把 `$HOME/.npm-global/bin` 加进 `PATH`，重装 |
| `codebuddy: command not found` | `npm prefix -g` 看全局路径，把对应的 `bin` 加进 `PATH` |

## 3. 登录

进交付包里要部署的目录，启动 CLI：

```bash
cd ~/campus-tokenhub-deliver-*/campus-tokenhub-assign   # 成员站换成 campus-tokenhub-member
codebuddy
```

用方向键选 **Log in via Chinese Site**，回车，用学校的腾讯云账号登录。服务器没有桌面，浏览器不会自己弹，把终端打印的链接复制到你自己电脑上打开即可。

## 4. 开始部署

在交付包目录里对它说：

```
按 docs/QUICKSTART.md 帮我完成本地部署和调试
```

---

## 装不上时

- **CentOS 7 不行**：glibc 只有 2.17（`ldd --version` 可见），Node 18+ 起不来。换成 CentOS Stream 8/9 或 Ubuntu 22.04 以上再装。
- **`npm install` 很慢**：`npm config set registry https://registry.npmmirror.com`。
- 官方文档：<https://www.codebuddy.cn/docs/cli/installation>
