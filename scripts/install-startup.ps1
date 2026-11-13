$ErrorActionPreference = 'Stop'
$script = (Resolve-Path (Join-Path $PSScriptRoot 'start-windows.mjs')).Path
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute (Get-Command node.exe).Source -Argument ('"' + $script + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'LINE-AgentFlow' -Action $action -Trigger @($trigger,$watchdog) -Principal $principal -Settings $settings -Description '登入後與每五分鐘檢查 Docker 與工作流程服務；不會自動購買資源。' -Force | Out-Null
Write-Output '已設定 Windows 登入後恢復服務；Docker Desktop 沒有執行時會自動啟動。無人值守的主機請另外設定 Windows 自動登入。'
