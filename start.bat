@echo off
setlocal enabledelayedexpansion

echo.
echo ==========================================
echo ==        OntoCartographer Studio       ==
echo ==========================================
echo.

cd /d "%~dp0"

REM ── Pre-flight Check ─────────────────────────────────────────────────────────
if not exist "backend\.venv" (
    echo   x Virtual environment not found!
    echo     Please run setup.bat first.
    echo.
    pause
    exit /b 1
)

if not exist "frontend\node_modules" (
    echo   x Frontend dependencies not found!
    echo     Please run setup.bat first.
    echo.
    pause
    exit /b 1
)

REM ── Launch ───────────────────────────────────────────────────────────────────
echo.
echo ^> Starting backend  -^>  http://localhost:8000
start "OntoCartographerStudio-Backend" cmd /k "cd /d "%~dp0backend" && call .venv\Scripts\activate.bat && uvicorn main:app --reload --port 8000"

timeout /t 2 /nobreak >nul

echo ^> Starting frontend -^>  http://localhost:3000
start "OntoCartographerStudio-Frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

echo.
echo ========================================
echo   App:     http://localhost:3000
echo   API:     http://localhost:8000/docs
echo   Stop:    Close the two terminal windows
echo ========================================
echo.
echo Opening browser...
timeout /t 3 /nobreak >nul
start http://localhost:3000

pause