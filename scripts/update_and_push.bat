@echo off
setlocal
cd /d "E:\2026\ranobe-tracker"

set LOG=scripts\update.log

echo. >> "%LOG%"
echo ---------------------------------------------------------------- >> "%LOG%"
echo Run: %date% %time% >> "%LOG%"
echo ---------------------------------------------------------------- >> "%LOG%"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node not found >> "%LOG%"
    exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] git not found >> "%LOG%"
    exit /b 1
)

echo [pull] >> "%LOG%"
git pull --rebase origin main >> "%LOG%" 2>&1

echo [run check_release.js] >> "%LOG%"
node scripts\check_release.js >> "%LOG%" 2>&1
if errorlevel 1 (
    echo [ERROR] check_release.js failed >> "%LOG%"
    exit /b 1
)

git diff --quiet release_info.json
if errorlevel 1 (
    echo [commit and push] >> "%LOG%"
    git add release_info.json
    git commit -m "chore: update release_info.json (from local PC)" >> "%LOG%" 2>&1
    git push >> "%LOG%" 2>&1
    echo [done] release_info.json updated and pushed >> "%LOG%"
) else (
    echo [no change] release_info.json up to date >> "%LOG%"
)

endlocal
exit /b 0
