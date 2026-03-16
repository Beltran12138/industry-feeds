@echo off
REM Alpha Radar Vercel Environment Variables Setup Script
REM Run this script to add all required environment variables to Vercel

echo ===========================================================
echo Alpha Radar Vercel Environment Variables Setup
echo ===========================================================
echo.
echo This script will add the following environment variables:
echo   - DEEPSEEK_API_KEY
echo   - WECOM_WEBHOOK_URL
echo   - NOTION_API_KEY
echo   - NOTION_DATABASE_ID
echo   - GITHUB_TOKEN
echo   - FEISHU_WEBHOOK_URL
echo   - TELEGRAM_BOT_TOKEN
echo.
echo IMPORTANT: You will be prompted to enter each value.
echo If you want to skip a variable, press Enter without entering a value.
echo.
pause

cd /d "%~dp0"

REM Function to add environment variable
:add_env
setlocal enabledelayedexpansion
if not "%~2"=="" (
    echo Adding %1...
    vercel env add %1 %2
) else (
    echo Skipping %1 (no value provided)
)
endlocal
goto :eof

echo ===========================================================
echo Step 1: Adding AI Configuration
echo ===========================================================
echo.

set /p DEEPSEEK="Enter DEEPSEEK_API_KEY (sk-...): "
if not "!DEEPSEEK!"=="" vercel env add DEEPSEEK_API_KEY !DEEPSEEK!

set /p OPENROUTER="Enter OPENROUTER_API_KEY (sk-or-v1-..., or press Enter to skip): "
if not "!OPENROUTER!"=="" vercel env add OPENROUTER_API_KEY !OPENROUTER!

set /p OPENAI="Enter OPENAI_API_KEY (sk-proj-..., or press Enter to skip): "
if not "!OPENAI!"=="" vercel env add OPENAI_API_KEY !OPENAI!

echo.
echo ===========================================================
echo Step 2: Adding Push Channels
echo ===========================================================
echo.

set /p WECOM="Enter WECOM_WEBHOOK_URL (https://qyapi.weixin.qq.com/...): "
if not "!WECOM!"=="" vercel env add WECOM_WEBHOOK_URL !WECOM!

set /p FEISHU="Enter FEISHU_WEBHOOK_URL (https://open.feishu.cn/..., or press Enter to skip): "
if not "!FEISHU!"=="" vercel env add FEISHU_WEBHOOK_URL !FEISHU!

set /p TELEGRAM="Enter TELEGRAM_BOT_TOKEN (...:... format, or press Enter to skip): "
if not "!TELEGRAM!"=="" vercel env add TELEGRAM_BOT_TOKEN !TELEGRAM!

set /p SLACK="Enter SLACK_WEBHOOK_URL (https://hooks.slack.com/..., or press Enter to skip): "
if not "!SLACK!"=="" vercel env add SLACK_WEBHOOK_URL !SLACK!

echo.
echo ===========================================================
echo Step 3: Adding Integrations
echo ===========================================================
echo.

set /p NOTION_KEY="Enter NOTION_API_KEY (secret_..., or press Enter to skip): "
if not "!NOTION_KEY!"=="" vercel env add NOTION_API_KEY !NOTION_KEY!

set /p NOTION_DB="Enter NOTION_DATABASE_ID (32-char hex, or press Enter to skip): "
if not "!NOTION_DB!"=="" vercel env add NOTION_DATABASE_ID !NOTION_DB!

set /p GITHUB="Enter GITHUB_TOKEN (ghp_..., or press Enter to skip): "
if not "!GITHUB!"=="" vercel env add GITHUB_TOKEN !GITHUB!

set /p GITHUB_REPO="Enter GITHUB_REPO (username/repo, or press Enter to skip): "
if not "!GITHUB_REPO!"=="" vercel env add GITHUB_REPO !GITHUB_REPO!

echo.
echo ===========================================================
echo Step 4: Adding Optional Configuration
echo ===========================================================
echo.

set /p SUPABASE_URL="Enter SUPABASE_URL (https://...supabase.co, or press Enter to skip): "
if not "!SUPABASE_URL!"=="" vercel env add SUPABASE_URL !SUPABASE_URL!

set /p SUPABASE_KEY="Enter SUPABASE_KEY (sb_publishable_..., or press Enter to skip): "
if not "!SUPABASE_KEY!"=="" vercel env add SUPABASE_KEY !SUPABASE_KEY!

set /p API_SECRET="Enter API_SECRET (your-secret-key, or press Enter to skip): "
if not "!API_SECRET!"=="" vercel env add API_SECRET !API_SECRET!

echo.
echo ===========================================================
echo Step 5: Deploying to Production
echo ===========================================================
echo.
echo All environment variables have been added!
echo Now deploying to production...
echo.

vercel --prod

echo.
echo ===========================================================
echo Setup Complete!
echo ===========================================================
echo.
echo Next steps:
echo 1. Wait for deployment to complete (2-5 minutes)
echo 2. Test your deployment:
echo    curl https://alpha-radar.vercel.app/api/health/sources
echo 3. Enable GitHub Actions for scheduled tasks
echo    Visit: https://github.com/Beltran12138/industry-feeds/actions
echo.
pause
