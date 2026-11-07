' 中科元晟 AI员工 —— 个人微信网桥看护（登录时静默启动）
' 由 setup-windows.ps1 生成，放到 shell:startup 目录
Option Explicit
Dim sh, fso, script, ps
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "supervisor.ps1")
ps = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"
sh.Run ps, 0, False
