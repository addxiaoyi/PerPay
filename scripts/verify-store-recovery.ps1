param([Parameter(Mandatory=$true)][string]$ArchivePath, [Parameter(Mandatory=$true)][string]$KeyPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$secret=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($KeyPath),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$rsa=[Security.Cryptography.RSA]::Create()
try {
  $consumed=0
  $rsa.ImportPkcs8PrivateKey($secret,[ref]$consumed)
  if ($consumed -ne $secret.Length) { throw 'Invalid recovery key' }
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=(Get-Command node).Source
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.RedirectStandardInput=$true
  $start.RedirectStandardOutput=$true
  $start.RedirectStandardError=$true
  $start.ArgumentList.Add('--experimental-strip-types')
  $start.ArgumentList.Add((Join-Path $PSScriptRoot 'verify-store-recovery.ts'))
  $start.ArgumentList.Add((Resolve-Path -LiteralPath $ArchivePath).Path)
  $proc=[Diagnostics.Process]::Start($start)
  $proc.StandardInput.Write($rsa.ExportPkcs8PrivateKeyPem())
  $proc.StandardInput.Close()
  $stdout=$proc.StandardOutput.ReadToEndAsync()
  $stderr=$proc.StandardError.ReadToEndAsync()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { throw 'Encrypted store recovery verification failed' }
  Write-Output $stdout.Result
} finally {
  [Array]::Clear($secret,0,$secret.Length)
  $rsa.Dispose()
  if ($proc) { $proc.Dispose() }
}
