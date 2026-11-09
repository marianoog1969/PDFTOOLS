# bump-version.ps1
# Uso: .\bump-version.ps1 1.5.1
# Actualiza la version (package.json, package-lock.json, tauri.conf.json, Cargo.toml),
# comprueba el codigo (tsc, ESLint, pruebas) y compila el exe.

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

$lock = Get-Content "$Root\package-lock.json" -Raw
$lock = [regex]::Replace($lock, '("name"\s*:\s*"pdftool",\s*"version"\s*:\s*)"[^"]*"', "`$1`"$Version`"")
Set-Content "$Root\package-lock.json" $lock -NoNewline
Write-Host "package-lock.json     -> $Version" -ForegroundColor Green

Write-Host ""

# 2. Comprobaciones: tipos, ESLint y pruebas. Si alguna falla, no se compila.
Write-Host "Comprobando tipos (tsc)..." -ForegroundColor Cyan
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) { Write-Error "Errores de TypeScript."; exit 1 }

Write-Host "Revisando el codigo (ESLint)..." -ForegroundColor Cyan
npm run lint
if ($LASTEXITCODE -ne 0) { Write-Error "ESLint encontro problemas."; exit 1 }

Write-Host "Ejecutando pruebas..." -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) { Write-Error "Alguna prueba fallo."; exit 1 }

Write-Host ""

# 3. Compilar
Write-Host "Compilando v$Version..." -ForegroundColor Cyan
npm run tauri build -- --no-bundle
if ($LASTEXITCODE -ne 0) {
    Write-Error "La compilacion fallo."
    exit 1
}

Write-Host ""
Write-Host "Listo. Exe en: src-tauri\target\release\pdftool.exe" -ForegroundColor Green
