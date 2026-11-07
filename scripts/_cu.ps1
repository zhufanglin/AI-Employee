$ErrorActionPreference="Continue"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CU8 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra);
}
"@
function Shot($name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save("C:\Users\30290\Desktop\fcmediaagent-replica\_cu_$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
function Click($x,$y) {
  [void][CU8]::SetCursorPos($x,$y); Start-Sleep -Milliseconds 200
  [CU8]::mouse_event(0x0002,0,0,0,0); Start-Sleep -Milliseconds 90
  [CU8]::mouse_event(0x0004,0,0,0,0); Start-Sleep -Milliseconds 350
}
$p = Get-Process msedge | Where-Object { $_.MainWindowTitle -like "*运营后台*" } | Select-Object -First 1
[void][CU8]::BringWindowToTop($p.MainWindowHandle)
[void][CU8]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 700
# 1) 空密码点登录，验证「点击 → 应用有反应」
Click 960 552
Start-Sleep -Milliseconds 1200
Shot "11_click_only"
# 2) 剪贴板 + Ctrl+V，验证键盘通道
Set-Clipboard -Value "admin"
Click 960 492
[CU8]::keybd_event(0x11,0,0,0); Start-Sleep -Milliseconds 60
[CU8]::keybd_event(0x56,0,0,0); Start-Sleep -Milliseconds 60
[CU8]::keybd_event(0x56,0,2,0); Start-Sleep -Milliseconds 60
[CU8]::keybd_event(0x11,0,2,0)
Start-Sleep -Milliseconds 600
Shot "12_paste"
"ok"