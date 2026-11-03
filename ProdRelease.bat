@echo off
setlocal EnableExtensions DisableDelayedExpansion

:: Fratoo production release (release standard v2, see Mira AI Department's
:: ProjectDocs/RELEASE-SYSTEM.md section 5). Run from the repo root on the
:: server (D:\apps\Fratoo), by double-click or by the Telegram /release
:: runner. See ProjectDocs/DEPLOYMENT.md "Routine deploys".
::
:: Exit codes: 0 released, 1 failed ([ERROR]), 2 run it again (loop guard,
::             see below).
::
:: It runs from a temporary copy of itself: cmd reads a .bat line by line
:: from disk, so step 3's update rewriting this file mid-run would make cmd
:: execute garbage. If the update changed this script, the copy starts the
:: new version in place (same log, no second backup; migrations and build
:: as usual) and exits with its exit code. If that new version sees the
:: script change once more, it stops with exit 2 instead (loop guard).
:: Nothing here depends on what changed (step 4 re-applies every idempotent
:: migration on each run), so there is no .last_release_commit marker.
::
:: Hand-over interface -- an old copy must be able to start a new version,
:: so keep these exactly as they are:
::   ProdRelease.bat --from-copy <root folder>
::     runs the release itself from a temporary copy; <root folder> ends
::     with a backslash. Its exit code is the release's exit code.
::   PRODRELEASE_UNATTENDED=1    started by the Telegram runner: no pause
::   PRODRELEASE_RELAUNCHED=1    the new version, started after a
::                               self-update: skips the backups (steps 1-2)
::   PRODRELEASE_LOGFILE=<path>  with RELAUNCHED: the log to append to

:: --- Self-elevate to Administrator if not already running elevated ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrative privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: --- Run from a temporary copy of this script (see the header). A new
::     name every time: a fixed one would let a relaunched new version
::     overwrite the copy that is still running. Everything up to the exit
::     stays inside this one (...) block, so cmd has read all of it before
::     step 3 can change this file. Run by hand, the window waits for a key
::     once, here at the very end; the copy itself never pauses. "call set"
::     reads the copy's exit code when the line runs (a plain %ERRORLEVEL%
::     in a block is read when the block is parsed). Delayed expansion
::     stays off for the release itself (it would strip the "!" from the
::     success line the Telegram runner looks for) and is switched on only
::     for the last line, after the copy is gone. ---
set "SELF_COPY=%TEMP%\fratoo_prodrelease_%RANDOM%%RANDOM%.bat"
if /i not "%~1"=="--from-copy" (
    copy /y "%~f0" "%SELF_COPY%" >nul || (
        echo [ERROR] Could not copy ProdRelease.bat to the TEMP folder.
        if not "%PRODRELEASE_UNATTENDED%"=="1" pause
        exit /b 1
    )
    call "%SELF_COPY%" --from-copy "%~dp0"
    call set "RC=%%ERRORLEVEL%%"
    del "%SELF_COPY%" >nul 2>&1
    if not "%PRODRELEASE_UNATTENDED%"=="1" pause
    setlocal EnableDelayedExpansion
    exit /b !RC!
)
set "ROOT=%~2"
set "LOGFILE="

:: --- Always operate from the project root (where the original script
::     lives), regardless of the working directory it was launched from
::     (double-click, shortcut, Task Scheduler, etc.). It sits next to
::     docker-compose.yml, fratoo-bridge\, fratoo-web\, ProjectDocs\. ---
cd /d "%ROOT%"

:: --- Timestamped log file, saved next to this script. Only the fast
::     steps (backups, git update, final container check) are logged here --
::     the Docker build prints live to the console instead so it's obvious
::     the script is still alive during that multi-minute step, not frozen.
::     A relaunched new version appends to the first run's log. ---
for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%T"
if not "%PRODRELEASE_RELAUNCHED%"=="1" goto :new_log
if not defined PRODRELEASE_LOGFILE goto :new_log
set "LOGFILE=%PRODRELEASE_LOGFILE%"
echo --- New version of ProdRelease.bat started --- >> "%LOGFILE%"
goto :log_ready
:new_log
set "LOGFILE=%ROOT%deploy_log_%TS%.txt"
echo Log file: %LOGFILE% > "%LOGFILE%"
:log_ready
echo Log file: %LOGFILE%

echo ==========================================
if "%PRODRELEASE_RELAUNCHED%"=="1" (
    echo Starting Fratoo Production Release - new version of ProdRelease.bat...
) else (
    echo Starting Fratoo Production Release...
)
echo ==========================================

:: A relaunched new version skips steps 1 and 2: the first run took both
:: backups a moment ago, and nothing has been rebuilt since.
if not "%PRODRELEASE_RELAUNCHED%"=="1" goto :backups
echo [1/6] Database backup already taken by the first run -- skipped.
echo [2/6] .env backup already taken by the first run -- skipped.
goto :backups_done
:backups

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
    goto :fail
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
:backups_done

:: Step 3: Get the latest code from GitHub. Fetch + forced checkout rather
:: than git pull: the server never commits, so origin/main is always the
:: truth, and this keeps working even if the GitHub history is replaced
:: (a fresh, unrelated history makes git pull refuse to merge). Tracked
:: files are overwritten; untracked and gitignored ones (.env, DB_Backup\,
:: ConfigBackup\, logs) are left alone. The git output goes to a temp file
:: first, then to the screen and the log (a relaunched new version's log
:: already holds the first run's lines, so the log isn't shown whole).
echo [3/6] Getting latest code from Git...
set "OLD_COMMIT="
set "NEW_COMMIT="
for /f %%C in ('git rev-parse --short HEAD') do set "OLD_COMMIT=%%C"
set "GIT_OUT=%TEMP%\fratoo_git_%RANDOM%%RANDOM%.txt"
git fetch origin +main:refs/remotes/origin/main > "%GIT_OUT%" 2>&1
if errorlevel 1 goto :git_failed
git checkout -f -B main origin/main >> "%GIT_OUT%" 2>&1
if errorlevel 1 goto :git_failed
for /f %%C in ('git rev-parse --short HEAD') do set "NEW_COMMIT=%%C"
echo Code: %OLD_COMMIT% -^> %NEW_COMMIT% >> "%GIT_OUT%"
type "%GIT_OUT%"
type "%GIT_OUT%" >> "%LOGFILE%"
del "%GIT_OUT%" >nul 2>&1

:: The update changed this script: start the new version in place. This
:: copy is not touched by the update, so it can safely wait for it here.
fc /b "%~f0" "%ROOT%ProdRelease.bat" >nul 2>&1
if not errorlevel 1 goto :script_current
if "%PRODRELEASE_RELAUNCHED%"=="1" goto :rerun
echo The update changed ProdRelease.bat itself -- starting the new version...
echo ProdRelease.bat changed by update -- starting the new version. >> "%LOGFILE%"
set "NEW_COPY=%TEMP%\fratoo_prodrelease_%RANDOM%%RANDOM%.bat"
copy /y "%ROOT%ProdRelease.bat" "%NEW_COPY%" >nul
if errorlevel 1 (
    echo [ERROR] Could not copy the new ProdRelease.bat to the TEMP folder.
    goto :fail
)
set "PRODRELEASE_RELAUNCHED=1"
set "PRODRELEASE_LOGFILE=%LOGFILE%"
call "%NEW_COPY%" --from-copy "%ROOT%"
set "RC=%ERRORLEVEL%"
del "%NEW_COPY%" >nul 2>&1
endlocal & exit /b %RC%

:script_current

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
            goto :fail
        )
    )
)
:migrations_done

:: Step 5: Rebuild and restart the full stack (postgres + api + web + pdf)
:: from the repo-root docker-compose.yml.
::
:: The two app images are built one at a time, then started: building them
:: in parallel (plain "up -d --build") once crashed the server's Docker VM,
:: which is short on RAM. "up -d" then pulls the Gotenberg image if missing.
::
:: Not redirected to the log file -- this step can take a few minutes on
:: the first run (pulling postgres/nginx/gotenberg images, building two app
:: images) and hiding its output would make the window look frozen with
:: nothing on screen to prove otherwise.
:: GIT_COMMIT is read by docker-compose.yml as a build arg for both images,
:: so GET /api/version and the dashboard footer show exactly which commit
:: is running (see CHANGELOG.md "Versioning").
for /f %%C in ('git rev-parse --short HEAD') do set "GIT_COMMIT=%%C"
echo [5/6] Rebuilding and restarting the stack ^(postgres + api + web + pdf^) at commit %GIT_COMMIT%...
echo Building commit %GIT_COMMIT% >> "%LOGFILE%"
docker compose build api
if errorlevel 1 (
    echo [ERROR] Building the api image failed!
    goto :fail
)
docker compose build web
if errorlevel 1 (
    echo [ERROR] Building the web image failed!
    goto :fail
)
docker compose up -d
if errorlevel 1 (
    echo [ERROR] Docker compose failed!
    goto :fail
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
echo Release successful at %GIT_COMMIT%. >> "%LOGFILE%"
set "RC=0"
goto :end

:git_failed
type "%GIT_OUT%"
type "%GIT_OUT%" >> "%LOGFILE%"
del "%GIT_OUT%" >nul 2>&1
echo [ERROR] Getting the code from Git failed! See log: %LOGFILE%
goto :fail

:fail
if defined LOGFILE echo Release FAILED. >> "%LOGFILE%"
echo === Release FAILED -- see the [ERROR] above. ===
set "RC=1"
goto :end

:rerun
echo [STOP] ProdRelease.bat changed again while its new version was starting.
echo        Nothing has been rebuilt. Run ProdRelease.bat again.
echo Loop guard: ProdRelease.bat changed again -- stopped. >> "%LOGFILE%"
set "RC=2"

:end
endlocal & exit /b %RC%
