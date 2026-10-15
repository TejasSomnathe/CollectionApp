$ErrorActionPreference = 'Stop'

$required = @('SUPABASE_DB_URL', 'AWS_BACKUP_BUCKET', 'AWS_BACKUP_REGION', 'AWS_KMS_KEY_ARN')
foreach ($name in $required) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "Required backup environment variable is missing: $name"
  }
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$workDirectory = Join-Path $tempRoot ("daily-collection-backup-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDirectory | Out-Null

$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$appDump = Join-Path $workDirectory "application-$stamp.dump"
$authDump = Join-Path $workDirectory "auth-users-$stamp.sql"
$prefix = "daily-collection/$stamp"

try {
  & pg_dump --format=custom --no-owner --no-acl --schema=public --file=$appDump $env:SUPABASE_DB_URL
  if ($LASTEXITCODE -ne 0) { throw 'Application database dump failed.' }

  & pg_dump --data-only --column-inserts --no-owner --no-acl --table=auth.users --table=auth.identities --file=$authDump $env:SUPABASE_DB_URL
  if ($LASTEXITCODE -ne 0) { throw 'Auth user/identity export failed.' }

  $toc = & pg_restore --list $appDump
  if ($LASTEXITCODE -ne 0 -or -not ($toc -match 'TABLE DATA public[ .]collection_entries')) {
    throw 'Application dump verification failed or the collection ledger table is absent.'
  }

  foreach ($file in @($appDump, $authDump)) {
    $hash = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
    $key = "$prefix/$([IO.Path]::GetFileName($file))"
    & aws s3 cp $file "s3://$env:AWS_BACKUP_BUCKET/$key" --region $env:AWS_BACKUP_REGION --sse aws:kms --sse-kms-key-id $env:AWS_KMS_KEY_ARN --metadata "sha256=$hash" --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Encrypted upload failed.' }

    $checksumFile = "$file.sha256"
    Set-Content -Path $checksumFile -Value "$hash  $([IO.Path]::GetFileName($file))" -NoNewline -Encoding ascii
    & aws s3 cp $checksumFile "s3://$env:AWS_BACKUP_BUCKET/$key.sha256" --region $env:AWS_BACKUP_REGION --sse aws:kms --sse-kms-key-id $env:AWS_KMS_KEY_ARN --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Checksum upload failed.' }
  }

  Write-Output "Encrypted backup uploaded under s3://$env:AWS_BACKUP_BUCKET/$prefix/"
}
finally {
  Remove-Item -LiteralPath $workDirectory -Recurse -Force -ErrorAction SilentlyContinue
}