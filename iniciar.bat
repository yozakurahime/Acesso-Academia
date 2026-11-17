@echo off
cd /d "%~dp0"
echo Atualizando codigo (se houver internet)...
git pull --ff-only origin main 2>nul
echo Iniciando Sistema de Controle de Acesso...
set "OXIGENIO_ABRIR_TELAS=1"
npm start
