@echo off
echo Liberando portas 81 e 3000 no Firewall do Windows para o Controle de Acesso...
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall add rule name="Controle Acesso Catraca (Porta 81)" dir=in action=allow protocol=TCP localport=81
netsh advfirewall firewall add rule name="Controle Acesso Catraca (Porta 3000)" dir=in action=allow protocol=TCP localport=3000
echo.
echo Portas liberadas com sucesso! Pode fechar esta janela.
pause
