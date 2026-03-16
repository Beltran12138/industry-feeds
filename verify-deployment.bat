@echo off
REM Alpha Radar - Verify Vercel Deployment and Configuration
echo ===========================================================
echo Alpha Radar Deployment Verification
echo ===========================================================
echo.

echo [1/5] Testing Vercel deployment...
curl -s https://alpha-radar-eight.vercel.app/api/health/sources > nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ Vercel deployment is accessible
) else (
    echo ✗ Vercel deployment is not accessible
)
echo.

echo [2/5] Testing health monitoring API...
curl -s https://alpha-radar-eight.vercel.app/api/health/sources | findstr "success" > nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ Health monitoring API is working
) else (
    echo ✗ Health monitoring API failed
)
echo.

echo [3/5] Testing integrations status API...
curl -s https://alpha-radar-eight.vercel.app/api/integrations/status | findstr "notion" > nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ Integrations API is working
) else (
    echo ✗ Integrations API failed
)
echo.

echo [4/5] Checking GitHub repository...
curl -s https://github.com/Beltran12138/industry-feeds | findstr "repository" > nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ GitHub repository is accessible
) else (
    echo ✗ GitHub repository check failed
)
echo.

echo [5/5] Verifying environment variables configuration...
if exist ".env" (
    echo ✓ Local .env file exists
) else (
    echo ! Local .env file not found (optional)
)
echo.

echo ===========================================================
echo Verification Complete!
echo ===========================================================
echo.
echo Next Steps:
echo 1. Enable GitHub Actions (MUST DO MANUALLY)
echo    Visit: https://github.com/Beltran12138/industry-feeds/actions
echo.
echo 2. Add GitHub Secrets (MUST DO MANUALLY)
echo    Visit: https://github.com/Beltran12138/industry-feeds/settings/secrets/actions
echo    Refer to: GITHUB_SECRETS_SETUP.txt
echo.
echo 3. Access your deployed application:
echo    Dashboard: https://alpha-radar-eight.vercel.app
echo    Health Monitor: https://alpha-radar-eight.vercel.app/health-monitor
echo.
pause
