param(
    [Parameter(Mandatory=$true)][string]$Ip,
    [string]$Destination = (Join-Path $PSScriptRoot '..\host-data')
)
$ErrorActionPreference = 'Stop'
$address = [System.Net.IPAddress]::Parse($Ip)
$dir = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath (Join-Path $dir 'host.pfx')) { throw 'Certificate already exists. Choose a new destination; never silently overwrite trust material.' }
New-Item -ItemType Directory -Path $dir -Force | Out-Null
# Do not persist a CA signing key: this CA signs this one host certificate only.
$caKey = [System.Security.Cryptography.RSA]::Create(3072)
$hostKey = [System.Security.Cryptography.RSA]::Create(3072)
try {
    $sha = [System.Security.Cryptography.HashAlgorithmName]::SHA256
    $pad = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    $caRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=OpenDisplay Local Trust', $caKey, $sha, $pad)
    $caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$true,0,$true))
    $caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign,$true))
    $ca = $caRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddYears(1))
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=OpenDisplay $Ip",$hostKey,$sha,$pad)
    $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress($address); $request.CertificateExtensions.Add($san.Build())
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
    $oids = [System.Security.Cryptography.OidCollection]::new()
    [void]$oids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$true))
    $serial = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
    $public = $request.Create($ca,[DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddMonths(3),$serial)
    $leaf = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($public,$hostKey)
    [System.IO.File]::WriteAllBytes((Join-Path $dir 'host.pfx'),$leaf.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
    [System.IO.File]::WriteAllBytes((Join-Path $dir 'ipad-trust.cer'),$ca.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    [System.IO.File]::WriteAllText((Join-Path $dir 'ipad-trust.pem'),$ca.ExportCertificatePem())
    # PFX contains the private key: restrict to this Windows user.
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
    Set-Acl -LiteralPath (Join-Path $dir 'host.pfx') -AclObject $acl
    Write-Output "Host certificate: $dir\host.pfx"
    Write-Output "iPad public trust certificate: $dir\ipad-trust.cer"
    Write-Output "SHA256 trust fingerprint: $($ca.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256))"
    Write-Output 'No certificate was installed into any trust store. Never share host.pfx.'
} finally { $caKey.Dispose(); $hostKey.Dispose() }
