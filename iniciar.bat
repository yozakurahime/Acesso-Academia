@echo off
cd /d "%~dp0"
echo Atualizando codigo (se houver internet)...
git pull --ff-only origin main || echo Aviso: nao foi possivel atualizar via git pull.
echo Iniciando Sincronizador com Auto-Atualizacao...
call npm run runner
if errorlevel 1 pause
