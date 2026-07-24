@echo off
REM Venture GUI - Quick Command Runner with ASCII Banner

setlocal enabledelayedexpansion

REM Display ASCII Banner in green
powershell -NoProfile -Command "Write-Host \"`n\" -ForegroundColor Green; Write-Host \"  __   __   ______     __   __     ______   __  __     ______     ______    \" -ForegroundColor Green; Write-Host \" /\ \ / /  /\  ___\   /\ `\"-.\ \   /\__  _\ /\ \/\ \   /\  == \   /\  ___\   \" -ForegroundColor Green; Write-Host \" \ \ \'/   \ \  __\   \ \ \-.  \  \/_/\ \/ \ \ \_\ \  \ \  __<   \ \  __\   \" -ForegroundColor Green; Write-Host \"  \ \__|    \ \_____\  \ \_\\\`\"\_\    \ \_\  \ \_____\  \ \_\ \_\  \ \_____\ \" -ForegroundColor Green; Write-Host \"   \/_/      \/_____/   \/_/ \/_/     \/_/   \/_____/   \/_/ /_/   \/_____/ \" -ForegroundColor Green; Write-Host \"                                                                            `n\" -ForegroundColor Green"

if "%1"=="" (
    echo Usage: venture.bat [command]
    echo.
    echo Examples:
    echo   venture.bat npm run dev
    echo   venture.bat npm run build
    echo   venture.bat npm run dev:backend
    exit /b 0
)

REM Execute the command passed as arguments
%*
