# bump-version.ps1
# Uso: .\bump-version.ps1 1.5.1
# Actualiza la version en los 3 archivos y compila el exe.

param(
    [Parameter(Mandatory=$true)]
    [string]$Version
)

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "Formato invalido. Usa X.X.X (ej: 1.5.1)"
    exit 1
}

$Root = $PSScriptRoot

# 1. Actualizar versiones en los 3 archivos
$pkg = Get-Content "$Root\package.json" -Raw
$pkg = $pkg -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$Version`""
Set-Content "$Root\package.json" $pkg -NoNewline
Write-Host "package.json          -> $Version" -ForegroundColor Green

$conf = Get-Content "$Root\src-tauri\tauri.conf.json" -Raw
$conf = $conf -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$Version`""
Set-Content "$Root\src-tauri\tauri.conf.json" $conf -NoNewline
Write-Host "tauri.conf.json       -> $Version" -ForegroundColor Green

$cargo = Get-Content "$Root\src-tauri\Cargo.toml" -Raw
$cargo = $cargo -replace '^version\s*=\s*"[^"]*"', "version = `"$Version`""
Set-Content "$Root\src-tauri\Cargo.toml" $cargo -NoNewline
Write-Host "src-tauri\Cargo.toml  -> $Version" -ForegroundColor Green

Write-Host ""

# 2. Compilar
Write-Host "Compilando v$Version..." -ForegroundColor Cyan
npm run tauri build -- --no-bundle
if ($LASTEXITCODE -ne 0) {
    Write-Error "La compilacion fallo."
    exit 1
}

Write-Host ""
Write-Host "Listo. Exe en: src-tauri\target\release\pdftool.exe" -ForegroundColor Green
