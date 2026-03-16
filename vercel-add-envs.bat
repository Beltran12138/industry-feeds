@echo off
REM Alpha Radar - Add Missing Vercel Environment Variables
REM This script adds only the missing environment variables

echo ===========================================================
echo Adding Missing Vercel Environment Variables
echo ===========================================================
echo.

cd /d "%~dp0"

echo The following environment variables will be added:
echo   - NOTION_API_KEY
echo   - NOTION_DATABASE_ID
echo   - GITHUB_TOKEN
echo   - GITHUB_REPO
echo   - FEISHU_WEBHOOK_URL
echo   - TELEGRAM_BOT_TOKEN
echo   - OPENROUTER_API_KEY (optional)
echo   - OPENAI_API_KEY (optional)
echo.
echo You will be prompted to enter each value.
echo ===========================================================
echo.

REM NOTION Integration
set /p "NOTION_KEY=Enter NOTION_API_KEY (secret_xxx): "
if not "!NOTION_KEY!"=="" (
    echo Adding NOTION_API_KEY...
    vercel env add NOTION_API_KEY !NOTION_KEY!
)

set /p "NOTION_DB=Enter NOTION_DATABASE_ID (32-character hex string): "
if not "!NOTION_DB!"=="" (
    echo Adding NOTION_DATABASE_ID...
    vercel env add NOTION_DATABASE_ID !NOTION_DB!
)

echo.

REM GitHub Integration
set /p "GITHUB=Enter GITHUB_TOKEN (ghp_xxx): "
if not "!GITHUB!"=="" (
    echo Adding GITHUB_TOKEN...
    vercel env add GITHUB_TOKEN !GITHUB!
)

set /p "GITHUB_REPO=Enter GITHUB_REPO (username/repo-name): "
if not "!GITHUB_REPO!"=="" (
    echo Adding GITHUB_REPO...
    vercel env add GITHUB_REPO !GITHUB_REPO!
)

echo.

REM Feishu
set /p "FEISHU=Enter FEISHU_WEBHOOK_URL (https://open.feishu.cn/...): "
if not "!FEISHU!"=="" (
    echo Adding FEISHU_WEBHOOK_URL...
    vercel env add FEISHU_WEBHOOK_URL !FEISHU!
)

echo.

REM Telegram
set /p "TELEGRAM=Enter TELEGRAM_BOT_TOKEN (format: xxx:xxx): "
if not "!TELEGRAM!"=="" (
    echo Adding TELEGRAM_BOT_TOKEN...
    vercel env add TELEGRAM_BOT_TOKEN !TELEGRAM!
)

echo.

REM Optional AI Providers
set /p "OPENROUTER=Enter OPENROUTER_API_KEY (or press Enter to skip): "
if not "!OPENROUTER!"=="" (
    echo Adding OPENROUTER_API_KEY...
    vercel env add OPENROUTER_API_KEY !OPENROUTER!
)

set /p "OPENAI=Enter OPENAI_API_KEY (or press Enter to skip): "
if not "!OPENAI!"=="" (
    echo Adding OPENAI_API_KEY...
    vercel env add OPENAI_API_KEY !OPENAI!
)

echo.
echo ===========================================================
echo All environment variables have been added!
echo Deploying to production...
echo ===========================================================
echo.

vercel --prod

echo.
echo Done! Your deployment is updating.
echo Wait 2-5 minutes, then test:
echo   curl https://alpha-radar.vercel.app/api/health/sources
echo.
pause
