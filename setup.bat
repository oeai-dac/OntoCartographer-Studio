@echo off
REM Ontology Mapper – Start Script (Windows)
setlocal enabledelayedexpansion

echo.
echo ==========================================
echo ==        OntoCartographer Studio       ==
echo ==========================================
echo.

cd /d "%~dp0"

REM ── Python Check ─────────────────────────────────────────────────────────────
echo ^> Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo   x Python not found. Please install Python 3.10+
    pause & exit /b 1
)
for /f "tokens=*" %%i in ('python --version') do echo   + %%i

REM ── Virtual Environment ───────────────────────────────────────────────────────
echo ^> Setting up virtual environment...
if not exist "backend\.venv" (
    python -m venv backend\.venv
    echo   + .venv created
) else (
    echo   + .venv already exists
)

call backend\.venv\Scripts\activate.bat

echo ^> Installing Python dependencies...
pip install -q -r backend\requirements.txt
echo   + Done

REM ── Node Check ───────────────────────────────────────────────────────────────
echo ^> Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo   x Node not found. Please install Node.js 18+
    pause & exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do echo   + Node %%i

REM ── Frontend deps ────────────────────────────────────────────────────────────
echo ^> Installing frontend dependencies...
cd frontend
if not exist "node_modules" (
    call npm install --silent
    echo   + node_modules installed
) else (
    echo   + node_modules already exists
)
cd ..

echo.
echo ========================================
echo   + Setup complete!
echo   Double-click start.bat to launch the app.
echo ========================================
echo.
pause