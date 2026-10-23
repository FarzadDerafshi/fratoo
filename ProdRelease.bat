@echo off
setlocal

:: --- Self-elevate to Administrator if not already running elevated ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrative privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: --- Run from a temporary copy of this script. cmd reads a running .bat
::     line by line from disk, so step 3's update replacing this very
::     file mid-run would make it execute garbled lines. The original hands
::     over to the copy (no CALL, outside any (...) block, so control never
::     comes back to the original) and passes its own folder along. Step 3
::     then stops if the update changed this script, so the new version runs
::     from its first line on the next attempt. ---
if /i "%~1"=="--from-copy" goto :running_from_copy
copy /y "%~f0" "%TEMP%\fratoo_prodrelease.bat" >nul
"%TEMP%\fratoo_prodrelease.bat" --from-copy "%~dp0"
:running_from_copy
set "ROOT=%~2"
set "SELF_COPY=%~f0"

:: --- Always operate from the project root (where the original script
::     lives), regardless of the working directory it was launched from
::     (double-click, shortcut, Task Scheduler, etc.). It sits next to
::     docker-compose.yml, fratoo-bridge\, fratoo-web\, ProjectDocs\. ---
cd /d "%ROOT%"

:: --- Timestamped log file, saved next to this script. Only the fast
::     steps (backups, git update, final container check) are logged here --
::     the Docker build prints live to the console instead so it's obvious
::     the script is still alive during that multi-minute step, not frozen. ---
for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%T"
set "LOGFILE=%ROOT%deploy_log_%TS%.txt"
echo Log file: %LOGFILE%
echo Log file: %LOGFILE% > "%LOGFILE%"

echo ==========================================
echo Starting Fratoo Production Release...
echo ==========================================

:: Step 1: Back up the Postgres database, if it's already running. Skipped
:: (not failed) on a brand-new deployment where the fratoo-postgres
:: container doesn't exist yet -- there's nothing to back up on a first run.
:: DB_USERNAME/DB_NAME are hardcoded to the .env.example defaults ("fratoo"
:: / "fratoo") -- update these two lines if you've customized them.
echo [1/6] Backing up Postgres database...
:: BACKUP_FILE is set here, outside any parenthesized block -- setting and
:: using %VAR% in the same (...) block reads its stale pre-block value
:: under normal (non-delayed) expansion, which this script doesn't enable.
if not exist "%ROOT%DB_Backup" mkdir "%ROOT%DB_Backup"
set "BACKUP_FILE=%ROOT%DB_Backup\fratoo_%TS%.sql"

:: The pg_dump result is checked with "if errorlevel 1" outside any (...)
:: block: a %errorlevel% inside the block it's set in is read when the
:: block is parsed, so a failed dump used to pass as "Backup saved".
docker ps --filter "name=fratoo-postgres" --format "{{.Names}}" | findstr /i "fratoo-postgres" >nul
if errorlevel 1 goto :no_db_backup
docker exec fratoo-postgres pg_dump -U fratoo -d fratoo > "%BACKUP_FILE%"
if errorlevel 1 (
    echo [ERROR] Database backup failed! Aborting before touching any code or containers.
    pause
    exit /b 1
)
echo Backup saved: %BACKUP_FILE%
goto :db_backup_done
:no_db_backup
echo fratoo-postgres is not running yet -- nothing to back up ^(first deploy^).
:db_backup_done

:: Step 2: Back up the root .env (and fratoo-bridge\.env, if you also run
:: the bridge outside Docker) before touching anything else. Both are
:: gitignored, so the git update can't touch them, but JWT_SECRET /
:: ADMIN_PASSWORD_HASH / WP_APP_PASSWORD can't be reconstructed if lost,
:: only regenerated. This costs nothing and removes any doubt.
echo [2/6] Backing up .env file(s)...
if not exist "%ROOT%ConfigBackup" mkdir "%ROOT%ConfigBackup"
if exist "%ROOT%.env" (
    copy /y "%ROOT%.env" "%ROOT%ConfigBackup\env_%TS%.bak" >nul
    echo Backup saved: ConfigBackup\env_%TS%.bak
) else (
    echo [WARNING] .env not found in the project root -- nothing to back up.
    echo Is this script actually sitting in the project root?
)
if exist "%ROOT%fratoo-bridge\.env" (
    copy /y "%ROOT%fratoo-bridge\.env" "%ROOT%ConfigBackup\fratoo-bridge-env_%TS%.bak" >nul
    echo Backup saved: ConfigBackup\fratoo-bridge-env_%TS%.bak
)

:: Step 3: Get the latest code from GitHub. Fetch + forced checkout rather
:: than git pull: the server never commits, so origin/main is always the
:: truth, and this keeps working even if the GitHub history is replaced
:: (a fresh, unrelated history makes git pull refuse to merge). Tracked
:: files are overwritten; untracked and gitignored ones (.env, DB_Backup\,
:: ConfigBackup\, logs) are left alone.
echo [3/6] Getting latest code from Git...
for /f %%C in ('git rev-parse --short HEAD') do set "OLD_COMMIT=%%C"
git fetch origin +main:refs/remotes/origin/main >> "%LOGFILE%" 2>&1
if errorlevel 1 goto :git_failed
git checkout -f -B main origin/main >> "%LOGFILE%" 2>&1
if errorlevel 1 goto :git_failed
for /f %%C in ('git rev-parse --short HEAD') do set "NEW_COMMIT=%%C"
echo Code: %OLD_COMMIT% -^> %NEW_COMMIT% >> "%LOGFILE%"
type "%LOGFILE%"
goto :git_done
:git_failed
type "%LOGFILE%"
echo [ERROR] Getting the code from Git failed! See log: %LOGFILE%
pause
exit /b 1
:git_done
fc /b "%SELF_COPY%" "%ROOT%ProdRelease.bat" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [STOP] This update changed ProdRelease.bat itself. Nothing has been
    echo        rebuilt yet -- just run ProdRelease.bat again so the new
    echo        version runs from the start. ^(Backups above are kept.^)
    echo ProdRelease.bat changed by update -- stopped for re-run. >> "%LOGFILE%"
    pause
    exit /b 0
)

:: Step 4: Apply database migrations. Postgres only runs db\init\*.sql by
:: itself on a brand-new empty volume -- an existing volume already has data, so
:: every migration after 001 is applied here, BEFORE the new api image
:: starts (new code expecting a missing column would fail on every batch
:: request). Every file from 002 on is written to be idempotent (IF NOT
:: EXISTS everywhere), so re-applying all of them on each deploy is a
:: no-op for the ones already in. 001 is skipped: it's plain CREATE TABLE,
:: and it's what the volume was created with. On a first deploy (no
:: fratoo-postgres yet) this step is skipped -- the image runs all of
:: db\init itself when it creates the volume.
:: DB_USERNAME/DB_NAME hardcoded the same way as Step 1.
echo [4/6] Applying database migrations...
docker ps --filter "name=fratoo-postgres" --format "{{.Names}}" | findstr /i "fratoo-postgres" >nul
if %errorlevel% neq 0 (
    echo fratoo-postgres is not running yet -- the image applies db\init itself on first start.
    goto :migrations_done
)
for %%F in ("%ROOT%fratoo-bridge\db\init\*.sql") do (
    if /i not "%%~nxF"=="001_init_fratoo.sql" (
        echo   %%~nxF
        docker exec -i fratoo-postgres psql -U fratoo -d fratoo -v ON_ERROR_STOP=1 -q < "%%F" >> "%LOGFILE%" 2>&1 || (
            echo [ERROR] Migration %%~nxF failed! See log: %LOGFILE%
            echo The database backup from step 1 is in DB_Backup\ if anything needs restoring.
            pause
            exit /b 1
        )
    )
)
:migrations_done

:: Step 5: Rebuild and restart the full stack (postgres + api + web) from
:: the repo-root docker-compose.yml.
::
:: Not redirected to the log file -- this step can take a few minutes on
:: the first run (pulling postgres/nginx base images, building two app
:: images) and hiding its output would make the window look frozen with
:: nothing on screen to prove otherwise.
:: GIT_COMMIT is read by docker-compose.yml as a build arg for both images,
:: so GET /api/version and the dashboard footer show exactly which commit
:: is running (see CHANGELOG.md "Versioning").
for /f %%C in ('git rev-parse --short HEAD') do set "GIT_COMMIT=%%C"
echo [5/6] Rebuilding and restarting the stack ^(postgres + api + web^) at commit %GIT_COMMIT%...
echo Building commit %GIT_COMMIT% >> "%LOGFILE%"
docker compose up -d --build
set "BUILD_RESULT=%errorlevel%"
if %BUILD_RESULT% neq 0 (
    echo [ERROR] Docker compose failed!
    pause
    exit /b %BUILD_RESULT%
)

:: Step 6: Show the running containers and confirm port 1234 is actually
:: bound by Docker, so you don't have to go check manually.
echo [6/6] Verifying containers and port 1234...
docker compose ps >> "%LOGFILE%" 2>&1
docker compose ps
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 1234 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize"
:: Ask the new API which build it is (through nginx, like the browser does).
:: Retries for up to a minute while the api container starts. A mismatch or
:: no answer is a warning, not a failure -- the stack is already up.
echo Checking the running version...
powershell -NoProfile -Command "$log='%LOGFILE%'; for ($i = 0; $i -lt 20; $i++) { try { $v = Invoke-RestMethod 'http://localhost:8086/api/version' -TimeoutSec 3; $m = 'Running: v' + $v.version + ' (' + $v.commit + ')'; if ($v.commit -ne '%GIT_COMMIT%') { $m += ' [WARNING] expected commit %GIT_COMMIT%' }; Write-Host $m; Add-Content -Path $log -Value $m -Encoding ascii; exit 0 } catch { Start-Sleep -Seconds 3 } }; $m = '[WARNING] /api/version did not answer within 60s'; Write-Host $m; Add-Content -Path $log -Value $m -Encoding ascii"

echo ==========================================
echo Fratoo Production Release Successful!
echo Log saved to: %LOGFILE%
echo Dashboard:    http://localhost:8086  ^(or the server's LAN IP^)
echo Reminder: the Airlock reconnects on its own ~4m47s wake cycle --
echo give it a few minutes, then "docker compose logs -f api" if you
echo want to confirm live telemetry resumed.
echo ==========================================
pause
endlocal
