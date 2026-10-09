<#
  bootstrap-android.ps1
  Provisions a portable JDK + Android command-line SDK into a local tool cache so the
  PodiumCast Android APKs can be built on a Windows machine without Java/Android Studio.

  Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/toolchain/bootstrap-android.ps1
  Result: <ToolsRoot>\jdk-21, <ToolsRoot>\android-sdk, <ToolsRoot>\env.txt

  Mirrors are chosen for reachability from mainland China; every source has a fallback.
#>
[CmdletBinding()]
param(
  [string]$ToolsRoot = (Join-Path $env:USERPROFILE '.podiumcast-tools'),
  [int]$JdkMajor = 21,
  [int[]]$CompileSdks = @(36, 35),
  [string[]]$BuildToolsVersions = @('36.0.0', '35.0.0'),
  [string]$Proxy = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Info($m) { Write-Host "[toolchain] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[toolchain] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[toolchain] $m" -ForegroundColor Yellow }

# PowerShell promotes ANY stderr line from a native command into a terminating error while
# $ErrorActionPreference is 'Stop' (java -version and sdkmanager both write to stderr).
# Run native tools through this helper and read $script:NativeExit for the exit code.
$script:NativeExit = 0
function Invoke-Native {
  param([string]$Exe, [string[]]$Argv, [string[]]$Stdin = @())
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Stdin.Count -gt 0) { $out = $Stdin | & $Exe @Argv 2>&1 } else { $out = & $Exe @Argv 2>&1 }
    $script:NativeExit = $LASTEXITCODE
    return $out
  } finally { $ErrorActionPreference = $prev }
}

New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
$downloads = Join-Path $ToolsRoot 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

$curlBase = @('-L', '--fail', '--ssl-no-revoke', '--retry', '5', '--retry-delay', '2',
              '--retry-all-errors', '--connect-timeout', '30', '-sS')
if ($Proxy) { $curlBase += @('--proxy', $Proxy) }

function Get-File($urls, $dest) {
  if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 1MB) {
    Info "cached: $(Split-Path $dest -Leaf) ($([math]::Round((Get-Item $dest).Length/1MB,1)) MB)"; return $dest
  }
  $tmp = "$dest.part"
  foreach ($u in $urls) {
    Info "downloading $u"
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    & curl.exe @curlBase -o $tmp $u
    if ($LASTEXITCODE -eq 0 -and (Test-Path $tmp) -and (Get-Item $tmp).Length -gt 1MB) {
      Move-Item -Force $tmp $dest
      Ok "saved $(Split-Path $dest -Leaf) ($([math]::Round((Get-Item $dest).Length/1MB,1)) MB)"
      return $dest
    }
    Warn "source failed (exit $LASTEXITCODE): $u"
  }
  throw "all download sources failed for $(Split-Path $dest -Leaf)"
}

# ---------------------------------------------------------------- 1. JDK ----
# NOTE: keep $jdkHome a plain string everywhere — mixing DirectoryInfo (from Get-ChildItem)
# and String (from Join-Path) makes `$jdkDir.FullName` silently evaluate to $null.
$jdkHome = (Get-ChildItem $ToolsRoot -Directory -Filter 'jdk-*' -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'bin\javac.exe') } |
            Select-Object -First 1).FullName
if (-not $jdkHome) {
  $jdkZip = Get-File @(
    "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/$JdkMajor/jdk/x64/windows/OpenJDK${JdkMajor}U-jdk_x64_windows_hotspot_21.0.12.1_1.zip",
    "https://mirrors.ustc.edu.cn/adoptium/$JdkMajor/jdk/x64/windows/OpenJDK${JdkMajor}U-jdk_x64_windows_hotspot_21.0.12.1_1.zip",
    "https://api.adoptium.net/v3/binary/latest/$JdkMajor/ga/windows/x64/jdk/hotspot/normal/eclipse"
  ) (Join-Path $downloads "temurin-jdk$JdkMajor-win-x64.zip")

  $jdkHome = Join-Path $ToolsRoot "jdk-$JdkMajor"
  if (Test-Path $jdkHome) { Remove-Item -Recurse -Force $jdkHome }
  New-Item -ItemType Directory -Force -Path $jdkHome | Out-Null
  Info 'extracting JDK ...'
  Expand-Archive -Path $jdkZip -DestinationPath $jdkHome -Force
  $inner = Get-ChildItem $jdkHome -Directory | Select-Object -First 1
  if ($inner -and (Test-Path (Join-Path $inner.FullName 'bin\javac.exe'))) {
    Get-ChildItem $inner.FullName -Force | Move-Item -Destination $jdkHome -Force
    Remove-Item -Recurse -Force $inner.FullName
  }
}
if (-not (Test-Path (Join-Path $jdkHome 'bin\javac.exe'))) { throw "JDK layout unexpected: $jdkHome" }
$env:JAVA_HOME = $jdkHome
$env:PATH = "$jdkHome\bin;$env:PATH"
Ok "JAVA_HOME=$env:JAVA_HOME"
Invoke-Native "$jdkHome\bin\java.exe" @('-version') | ForEach-Object { Info "  $_" }

# ------------------------------------------------------- 2. cmdline-tools ----
$sdk = Join-Path $ToolsRoot 'android-sdk'
$sdkManager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkManager)) {
  $zip = Get-File @(
    'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip',
    'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip',
    'https://mirrors.cloud.tencent.com/AndroidSDK/commandlinetools-win-13114758_latest.zip'
  ) (Join-Path $downloads 'commandlinetools-win-latest.zip')

  $stage = Join-Path $ToolsRoot 'clt-stage'
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'cmdline-tools') | Out-Null
  $dst = Join-Path $sdk 'cmdline-tools\latest'
  if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
  Move-Item (Join-Path $stage 'cmdline-tools') $dst
  Remove-Item -Recurse -Force $stage
}
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
Ok "ANDROID_HOME=$sdk"

# ------------------------------------------------------- 3. SDK packages ----
$yes = ("y`n" * 80)
$pkgs = @('platform-tools')
foreach ($s in $CompileSdks)      { $pkgs += "platforms;android-$s" }
foreach ($b in $BuildToolsVersions) { $pkgs += "build-tools;$b" }

Info "accepting licences ..."
Invoke-Native $sdkManager @("--sdk_root=$sdk", '--licenses') -Stdin $yes | Out-Null
Info "installing SDK packages: $($pkgs -join ', ')"
Invoke-Native $sdkManager (@("--sdk_root=$sdk") + $pkgs) -Stdin $yes | Select-Object -Last 8
if ($script:NativeExit -ne 0) { throw "sdkmanager failed ($script:NativeExit)" }
Invoke-Native $sdkManager @("--sdk_root=$sdk", '--licenses') -Stdin $yes | Out-Null

# ------------------------------------------------------------- 4. report ----
$adb = Join-Path $sdk 'platform-tools\adb.exe'
Ok "adb: $adb $(if (Test-Path $adb) {'(ok)'} else {'(MISSING)'})"
Get-ChildItem (Join-Path $sdk 'platforms')   -ErrorAction SilentlyContinue | ForEach-Object { Info "platform:    $($_.Name)" }
Get-ChildItem (Join-Path $sdk 'build-tools') -ErrorAction SilentlyContinue | ForEach-Object { Info "build-tools: $($_.Name)" }

@"
JAVA_HOME=$env:JAVA_HOME
ANDROID_HOME=$env:ANDROID_HOME
ANDROID_SDK_ROOT=$env:ANDROID_SDK_ROOT
TOOLS_ROOT=$ToolsRoot
"@ | Set-Content -Encoding ascii (Join-Path $ToolsRoot 'env.txt')
Ok "wrote $(Join-Path $ToolsRoot 'env.txt')"
Ok 'ANDROID TOOLCHAIN READY'
