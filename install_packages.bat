@echo off
title Flux - Install
npm ci
if errorlevel 1 (
  echo Installation failed.
  pause
  exit /b 1
)
npm run check
if errorlevel 1 (
  echo Source validation failed.
  pause
  exit /b 1
)
npm test
if errorlevel 1 (
  echo Tests failed.
  pause
  exit /b 1
)
echo.
echo Installation and validation finished.
pause
