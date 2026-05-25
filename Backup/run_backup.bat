@echo off
setlocal

set LOG=%~dp0backup.log

echo. >> "%LOG%"
echo ================================================================ >> "%LOG%"
echo  Dashboard Financiero - Backup SQL >> "%LOG%"
echo  Iniciado: %DATE% %TIME% >> "%LOG%"
echo ================================================================ >> "%LOG%"

wsl python3 /mnt/c/Dashboard/Github/Backup/backup.py >> "%LOG%" 2>&1

echo  Finalizado: %DATE% %TIME% >> "%LOG%"
echo ================================================================ >> "%LOG%"

endlocal
