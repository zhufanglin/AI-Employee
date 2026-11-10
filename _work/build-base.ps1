$ErrorActionPreference = 'Stop'
$root = 'C:\Users\30290\Desktop\数字人\素材包\工厂素材'
$out  = 'C:\Users\30290\Desktop\fcmediaagent-replica\_work\edit'
New-Item -ItemType Directory -Force -Path "$out\seg" | Out-Null
$files = Get-ChildItem $root -Filter *.mp4 | Sort-Object Name

# name, 1-based index in sorted list, in-point(s), duration(s)
$edl = @(
  @('01', 21, 1.0, 3.2),
  @('02',  7, 0.3, 2.9),
  @('03',  1, 0.3, 3.8),
  @('04', 23, 0.5, 4.8),
  @('05', 21, 4.0, 2.3),
  @('06', 30, 0.5, 3.5),
  @('07', 36, 0.5, 2.7),
  @('08',  4, 0.5, 4.2),
  @('09', 34, 0.5, 3.0),
  @('10',  9, 0.5, 3.2),
  @('11',  2, 0.5, 4.0),
  @('12', 11, 0.5, 2.7),
  @('13',  5, 0.5, 2.5),
  @('14', 13, 0.5, 3.3),
  @('15', 23, 5.5, 2.1),
  @('16', 26, 0.5, 2.4),
  @('17', 27, 0.5, 3.7),
  @('18', 37, 0.5, 4.4)
)

$list = New-Object System.Collections.Generic.List[string]
foreach ($e in $edl) {
  $name = $e[0]; $idx = [int]$e[1]; $inp = [double]$e[2]; $dur = [double]$e[3]
  $src = $files[$idx - 1].FullName
  $dst = Join-Path $out "seg\$name.mp4"
  & ffmpeg -y -v error -ss $inp -t $dur -i $src -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=25,format=yuv420p" -an -c:v libx264 -crf 18 -preset veryfast $dst
  if (-not (Test-Path $dst)) { throw "segment failed: $name" }
  $list.Add("file '$(($dst -replace '\\','/'))'")
}
[IO.File]::WriteAllLines((Join-Path $out 'list.txt'), $list)
& ffmpeg -y -v error -f concat -safe 0 -i (Join-Path $out 'list.txt') -c copy (Join-Path $out 'base.mp4')
$p = ffprobe -v error -show_entries format=duration -of csv=p=0 (Join-Path $out 'base.mp4')
"base.mp4 duration = $p"
