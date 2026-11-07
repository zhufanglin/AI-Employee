# 本机故障记录：node 24 无法写文件（EPERM）——工具链被打了 Low 完整性标签

## 现象（2026-11-06 04:28 起）
- 便携 Node `C:\Users\30290\Desktop\REA逆向\toolchain\node-v24.22.1-win-x64\node.exe` 运行后**任何写操作都 EPERM**：
  `fs.mkdirSync`/`fs.writeFileSync`/`fs.appendFileSync` 全部 `EPERM: operation not permitted`，连 `%TEMP%` 也不行。
- 同一条 pwsh 里用 workbuddy 的 `C:\Users\30290\.workbuddy\binaries\node\versions\22.22.2\node.exe` 写入正常。
- 把 node24.exe **复制到 %TEMP% 后运行却能写** → 不是二进制问题，是**文件标签**问题。
- 连带表现：`prisma migrate dev` 报 `Failed to create a new migration directory: EPERM: operation not permitted, mkdir ...migrations\2026...`；`prisma generate` 报 `EPERM: rename ...query_engine-windows.dll.node.tmpNNN`。

## 根因
该目录被 Codex 沙箱跑过，ACL 被写成：
- `XII\CodexSandboxUsers:(I)(OI)(CI)(RX)`
- `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)`（整棵 `C:\Users\30290\Desktop\REA逆向\toolchain` 都是）
- `Everyone:(I)(CI)(DENY)(DC)`
⇒ 从该 exe 启动的进程 token 完整性级别是 **Low (S-1-16-4096)**，Windows 强制策略禁止低完整性进程写中完整性对象 ⇒ 所有写操作 EPERM。

## 修复（已执行，2462 个文件）
```powershell
icacls "C:\Users\30290\Desktop\REA逆向\toolchain" /setintegritylevel Medium /T /C /Q
```
标签变为 `Medium Mandatory Level`，node24 立刻恢复写入（`WRITE_OK`）。

## 以后遇到同类问题的判定方法
1. `& <node> -e "require('child_process').execSync('whoami /groups')"` 看 Mandatory Label 是不是 Low。
2. `icacls <exe>` 看有没有 `Low Mandatory Level ... (NW)` / `*SandboxUsers`。
3. 复制 exe 到 %TEMP% 试写：能写 ⇒ 标签问题，不是二进制/杀软问题。
4. 临时绕过：用 workbuddy 的 node 22.22.2 跑脚本（Prisma CLI、smoke、seed 都兼容；REA 本体仍要求 node 24）。
