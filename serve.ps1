# serve.ps1 — zero-dependency static web server for Reader X.
# Used as a fallback by start.bat when Python is not installed.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765
$prefix = "http://localhost:$port/"

$mime = @{
  ".html" = "text/html; charset=utf-8";  ".htm"  = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"; ".mjs" = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8";    ".json" = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml";              ".png"  = "image/png"
  ".jpg"  = "image/jpeg";                 ".jpeg" = "image/jpeg"
  ".gif"  = "image/gif";                  ".webp" = "image/webp"
  ".ico"  = "image/x-icon";               ".wasm" = "application/wasm"
  ".woff" = "font/woff";                  ".woff2" = "font/woff2"
  ".ttf"  = "font/ttf";                   ".txt"  = "text/plain; charset=utf-8"
  ".map"  = "application/json";           ".epub" = "application/epub+zip"
  ".pdf"  = "application/pdf"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "  Could not start the server on $prefix" -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)"
  Write-Host ""
  Read-Host "  Press Enter to close"
  exit 1
}

Write-Host ""
Write-Host "  Reader X is running" -ForegroundColor Green
Write-Host "  $prefix" -ForegroundColor Cyan
Write-Host "  Close this window to stop the server."
Write-Host ""
Start-Process $prefix

$rootFull = [System.IO.Path]::GetFullPath($root)
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($rel)) { $rel = "index.html" }
      $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))

      if (-not $full.StartsWith($rootFull)) {
        $res.StatusCode = 403
      } elseif (Test-Path $full -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $ct = $mime[$ext]
        if (-not $ct) { $ct = "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $res.ContentType = $ct
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $res.StatusCode = 404
        $msg = [Text.Encoding]::UTF8.GetBytes("404 - Not Found")
        $res.OutputStream.Write($msg, 0, $msg.Length)
      }
    } catch {
      try { $res.StatusCode = 500 } catch {}
    } finally {
      try { $res.OutputStream.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
