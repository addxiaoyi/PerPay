param(
  [Parameter(Mandatory=$true)][string]$ArchivePath,
  [Parameter(Mandatory=$true)][string]$MasterKeyArchivePath,
  [Parameter(Mandatory=$true)][string]$RecoveryKeyPath,
  [switch]$RehearseOrders
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$secret=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $RecoveryKeyPath).Path),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$rsa=[Security.Cryptography.RSA]::Create()
try {
  $consumed=0
  $rsa.ImportPkcs8PrivateKey($secret,[ref]$consumed)
  if($consumed -ne $secret.Length){throw 'Invalid recovery key'}
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=(Get-Command node).Source
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.RedirectStandardInput=$true
  $start.RedirectStandardOutput=$true
  $start.RedirectStandardError=$true
  foreach($arg in @('--experimental-strip-types',(Join-Path $PSScriptRoot 'verify-candidate-recovery.ts'),(Resolve-Path -LiteralPath $ArchivePath).Path,(Resolve-Path -LiteralPath $MasterKeyArchivePath).Path)){$start.ArgumentList.Add($arg)}
  if($RehearseOrders){$start.ArgumentList.Add('--rehearse-orders')}
  $proc=[Diagnostics.Process]::Start($start)
  $proc.StandardInput.Write($rsa.ExportPkcs8PrivateKeyPem())
  $proc.StandardInput.Close()
  $stdout=$proc.StandardOutput.ReadToEndAsync()
  $stderr=$proc.StandardError.ReadToEndAsync()
  $proc.WaitForExit()
  if($proc.ExitCode -ne 0){throw 'Candidate encrypted recovery verification failed'}
  Write-Output $stdout.Result
} finally {
  [Array]::Clear($secret,0,$secret.Length)
  $rsa.Dispose()
  if($proc){$proc.Dispose()}
}
