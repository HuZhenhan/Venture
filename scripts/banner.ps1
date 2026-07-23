param(
    [string]$Command = ""
)

function Show-Banner {
    Write-Host "`n" -ForegroundColor Green
    Write-Host "  __   __   ______     __   __     ______   __  __     ______     ______    " -ForegroundColor Green
    Write-Host " /\ \ / /  /\  ___\   /\ `"-.\ \   /\__  _\ /\ \/\ \   /\  == \   /\  ___\   " -ForegroundColor Green
    Write-Host " \ \ \'/   \ \  __\   \ \ \-.  \  \/_/\ \/ \ \ \_\ \  \ \  __<   \ \  __\   " -ForegroundColor Green
    Write-Host "  \ \__|    \ \_____\  \ \_\`"\_\    \ \_\  \ \_____\  \ \_\ \_\  \ \_____\ " -ForegroundColor Green
    Write-Host "   \/_/      \/_____/   \/_/ \/_/     \/_/   \/_____/   \/_/ /_/   \/_____/ " -ForegroundColor Green
    Write-Host "                                                                            `n" -ForegroundColor Green
}

if ($Command -eq "") {
    Show-Banner
} else {
    Show-Banner
    Invoke-Expression $Command
}
