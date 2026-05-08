# Monitor de bateria + watchdog de monitores de mercado
# Corre cada 5 minutos via Task Scheduler

$TG_TOKEN       = "8576934070:AAFrb--ocLPcFZh-mOzFDTc5ujYnouA3H3U"
$TG_CHAT_ID     = "6209263987"
$FLAG_20        = "$PSScriptRoot\bat_alerta20.flag"
$FLAG_10        = "$PSScriptRoot\bat_alerta10.flag"
$FLAG_WD_ARS    = "$PSScriptRoot\wd_ars.flag"
$FLAG_WD_USA    = "$PSScriptRoot\wd_usa.flag"

# ── Timezone helper (GMT-3 Argentina) ────────────────────────
# WSL corre en UTC, pero todas las ventanas horarias y timestamps
# deben usar hora ARG (GMT-3, sin horario de verano).
$ArgTz = [System.TimeZoneInfo]::FindSystemTimeZoneById('Argentina Standard Time')

function Get-ArgTime {
    # Devuelve [datetime] en hora ARG para cualquier operacion
    return [System.TimeZoneInfo]::ConvertTimeFromUtc([datetime]::UtcNow, $ArgTz)
}

function Get-ArgDateString([string]$Format = 'yyyy-MM-dd') {
    # Devuelve string con fecha/hora ARG
    $argNow = Get-ArgTime
    return $argNow.ToString($Format)
}

function Send-Telegram($msg) {
    $url  = "https://api.telegram.org/bot$TG_TOKEN/sendMessage"
    $body = @{ chat_id = $TG_CHAT_ID; text = $msg; parse_mode = "Markdown" } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType "application/json; charset=utf-8" | Out-Null
    } catch {}
}

function Write-Log($msg) {
    $logFile = "$PSScriptRoot\monitor_dashboard.log"
    $timestamp = Get-ArgDateString "yyyy-MM-dd HH:mm:ss"
    "$timestamp $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

# ── Watchdog monitores de mercado ─────────────────────────
# Corre siempre (independiente del estado de la bateria)

$SB_URL     = "https://endymbpdayeidromxayb.supabase.co"
$SB_KEY     = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVuZHltYnBkYXllaWRyb214YXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MzU4NTAsImV4cCI6MjA4OTExMTg1MH0.BCZRvE9F1g_w2ffwj6NA6vyCYab2XcHDgmZir3CkeOk"
$SB_HEADERS = @{ apikey = $SB_KEY; Authorization = "Bearer $SB_KEY" }
$STALE_SECS = 7 * 60   # 7 min sin datos = monitor caido

function Get-StaleSeconds($table) {
    try {
        $url = "$SB_URL/rest/v1/${table}?select=updated_at&order=updated_at.desc.nullslast&limit=1"
        $r = Invoke-RestMethod -Uri $url -Headers $SB_HEADERS -ErrorAction Stop
        if (-not $r -or -not $r[0].updated_at) { return 9999 }
        $updAt = [datetime]::Parse($r[0].updated_at).ToUniversalTime()
        return ([datetime]::UtcNow - $updAt).TotalSeconds
    } catch { return 9999 }
}

# ── Calcular hora ARG una sola vez al inicio del ciclo ─────
# Todas las ventanas horarias comparan contra esta variable.
$argNow_ = Get-ArgTime
$hNow = $argNow_.TimeOfDay

function Watch-Monitor($taskPath, $label, $table, $flagFile, $startTime, $endTime) {
    $dow = $argNow_.DayOfWeek
    if ($dow -eq 'Saturday' -or $dow -eq 'Sunday') {
        Remove-Item $flagFile -ErrorAction SilentlyContinue
        return
    }
    if ($hNow -lt [TimeSpan]$startTime -or $hNow -ge [TimeSpan]$endTime) {
        # Fuera de horario: limpiar flag para el proximo ciclo
        Remove-Item $flagFile -ErrorAction SilentlyContinue
        return
    }

    $stale = Get-StaleSeconds $table

    if ($stale -le $STALE_SECS) {
        # Datos frescos: si habia un flag de alerta, avisar que se recupero
        if (Test-Path $flagFile) {
            Remove-Item $flagFile -ErrorAction SilentlyContinue
            Send-Telegram "[Watchdog] *$label recuperado*`nDatos actualizados correctamente."
        }
        return
    }

    # Datos viejos: solo actuar si no se notific'o antes en este episodio
    if (-not (Test-Path $flagFile)) {
        New-Item $flagFile -ItemType File -Force | Out-Null
        schtasks /end /tn $taskPath 2>$null | Out-Null
        Start-Sleep -Seconds 2
        schtasks /run /tn $taskPath | Out-Null
        Send-Telegram "[Watchdog] *$label reiniciado*`nDatos sin actualizar hace $([int]($stale/60))m. Reiniciando..."
    }
    # Si el flag ya existe: ya se reinicio, esperar a que levante sin hacer nada mas
}

# Monitor ARS (tabla mercado): activo 10:30-16:59, chequear desde 10:40
Watch-Monitor "\Dashboard"     "Monitor ARS" "mercado"     $FLAG_WD_ARS "10:40:00" "16:59:00"

# Monitor USA (tabla mercado_usa): activo 08:00-20:30, chequear desde 08:10
Watch-Monitor "\Dashboard USA" "Monitor USA" "mercado_usa" $FLAG_WD_USA "08:10:00" "20:30:00"

# ── Captura diaria al cierre (17:05–17:59 ARG) ────────────
# Guarda dólar oficial, MEP y CCL en mep_historico y dolar_historico
if ($hNow -ge [TimeSpan]"17:01:00" -and $hNow -lt [TimeSpan]"17:59:00") {
    $hoy = Get-ArgDateString "yyyy-MM-dd"
    $postH  = $SB_HEADERS.Clone()
    $postH["Content-Type"] = "application/json"
    $postH["Prefer"]       = "resolution=merge-duplicates,return=minimal"

    try {
        # ── MEP: AL30/AL30D desde tabla mercado ──
        $check = Invoke-RestMethod -Uri "$SB_URL/rest/v1/mep_historico?fecha=eq.$hoy&select=fecha" -Headers $SB_HEADERS -ErrorAction Stop
        if ($check.Count -eq 0) {
            # ── MEP: AL30/AL30D desde Rava (edge function) ──
            $edgeUrl = "$SB_URL/functions/v1/yahoo-prices"
            $edgeBody = @{ mode="rava-series"; symbols=@("AL30","AL30D") } | ConvertTo-Json
            $edgeH = @{"Content-Type"="application/json"; "Authorization"="Bearer $SB_KEY"; "apikey"=$SB_KEY}
            $series = Invoke-RestMethod -Uri $edgeUrl -Method Post -Headers $edgeH -Body $edgeBody -ErrorAction Stop

            $al30px = $null; $al30dpx = $null
            foreach ($r in $series.AL30) {
                if ($r.fecha -eq $hoy -and $r.cierre -gt 0) {
                    if (-not $al30px -or $r.especie -like "*CT*") { $al30px = [double]$r.cierre }
                }
            }
            foreach ($r in $series.AL30D) {
                if ($r.fecha -eq $hoy -and $r.cierre -gt 0) {
                    if (-not $al30dpx -or $r.especie -like "*CT*") { $al30dpx = [double]$r.cierre }
                }
            }

            if ($al30px -gt 0 -and $al30dpx -gt 0) {
                $mep = [math]::Round($al30px / $al30dpx, 2)
                $row = @{ fecha=$hoy; mep=$mep; al30_ars=$al30px; al30d_usd=$al30dpx; fuente="rava" } | ConvertTo-Json
                Invoke-RestMethod -Uri "$SB_URL/rest/v1/mep_historico" -Method Post -Headers $postH -Body $row | Out-Null

                # ── También guardar MEP en dolar_historico ──
                $row2 = @{ fecha=$hoy; tipo="mep"; close=$mep; fuente="rava" } | ConvertTo-Json
                Invoke-RestMethod -Uri "$SB_URL/rest/v1/dolar_historico" -Method Post -Headers $postH -Body $row2 | Out-Null
            }
        }
    } catch { Write-Log "ERROR mep: $($_ | Out-String)" }

    try {
        # ── Dólar oficial: ArgentinaDatos API ──
        $checkDh = Invoke-RestMethod -Uri "$SB_URL/rest/v1/dolar_historico?fecha=eq.$hoy&tipo=eq.oficial&select=fecha" -Headers $SB_HEADERS -ErrorAction Stop
        if ($checkDh.Count -eq 0) {
            $ofUrl = "https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial"
            $oficialRetries = 2
            $oficialLoaded = $false
            for ($ofTry = 0; $ofTry -le $oficialRetries; $ofTry++) {
                try {
                    $ofResp = Invoke-RestMethod -Uri $ofUrl -Headers @{"User-Agent"="Mozilla/5.0"} -ErrorAction Stop
                    $lastOf = $ofResp | Where-Object { $_.fecha -eq $hoy } | Select-Object -Last 1
                    if ($lastOf -and $lastOf.venta -gt 0) {
                        $row = @{ fecha=$hoy; tipo="oficial"; close=[math]::Round($lastOf.venta,2); fuente="argentinadatos" } | ConvertTo-Json
                        Invoke-RestMethod -Uri "$SB_URL/rest/v1/dolar_historico" -Method Post -Headers $postH -Body $row | Out-Null
                        $oficialLoaded = $true
                        break
                    }
                } catch { Write-Log "WARN oficial (intento $($ofTry+1)): $($_ | Out-String)" }
                if ($ofTry -lt $oficialRetries) { Start-Sleep -Seconds 5 }
            }
            if (-not $oficialLoaded) {
                Write-Log "WARN oficial: no se pudo obtener cotización del día $hoy después de $($oficialRetries+1) intentos"
            }
        }
    } catch { Write-Log "ERROR oficial: $($_ | Out-String)" }

    try {
        # ── CCL: AL30C/AL30 desde Rava (edge function) ──
        $checkDh = Invoke-RestMethod -Uri "$SB_URL/rest/v1/dolar_historico?fecha=eq.$hoy&tipo=eq.ccl&select=fecha" -Headers $SB_HEADERS -ErrorAction Stop
        if ($checkDh.Count -eq 0) {
            $edgeUrl = "$SB_URL/functions/v1/yahoo-prices"
            $edgeBody = @{ mode="rava-series"; symbols=@("AL30","AL30C") } | ConvertTo-Json
            $edgeH = @{"Content-Type"="application/json"; "Authorization"="Bearer $SB_KEY"; "apikey"=$SB_KEY}
            $cclRetries = 2
            $cclLoaded = $false
            for ($cclTry = 0; $cclTry -le $cclRetries; $cclTry++) {
                try {
                    $series = Invoke-RestMethod -Uri $edgeUrl -Method Post -Headers $edgeH -Body $edgeBody -ErrorAction Stop

                    # Buscar cierre de AL30 y AL30C para hoy
                    $al30px = $null; $al30cpx = $null
                    foreach ($r in $series.AL30) {
                        if ($r.fecha -eq $hoy -and $r.cierre -gt 0) {
                            if (-not $al30px -or $r.especie -like "*CT*") { $al30px = [double]$r.cierre }
                        }
                    }
                    foreach ($r in $series.AL30C) {
                        if ($r.fecha -eq $hoy -and $r.cierre -gt 0) {
                            if (-not $al30cpx -or $r.especie -like "*CT*") { $al30cpx = [double]$r.cierre }
                        }
                    }

                    if ($al30px -gt 0 -and $al30cpx -gt 0) {
                        $ccl = [math]::Round($al30px / $al30cpx, 2)
                        $row = @{ fecha=$hoy; tipo="ccl"; close=$ccl; fuente="rava" } | ConvertTo-Json
                        Invoke-RestMethod -Uri "$SB_URL/rest/v1/dolar_historico" -Method Post -Headers $postH -Body $row | Out-Null
                        $cclLoaded = $true
                        break
                    }
                } catch { Write-Log "WARN ccl (intento $($cclTry+1)): $($_ | Out-String)" }
                if ($cclTry -lt $cclRetries) { Start-Sleep -Seconds 5 }
            }
            if (-not $cclLoaded) {
                Write-Log "WARN ccl: no se pudo obtener cotización del día $hoy después de $($cclRetries+1) intentos"
            }
        }
    } catch { Write-Log "ERROR ccl: $($_ | Out-String)"  }
    # ── Resumen diario dolar ──────────────────────────────────
    try {
        $mepRow = Invoke-RestMethod -Uri "$SB_URL/rest/v1/mep_historico?fecha=eq.$hoy&select=mep" -Headers $SB_HEADERS -ErrorAction Stop
        $ofRow  = Invoke-RestMethod -Uri "$SB_URL/rest/v1/dolar_historico?fecha=eq.$hoy&tipo=eq.oficial&select=close" -Headers $SB_HEADERS -ErrorAction Stop
        $cclRow = Invoke-RestMethod -Uri "$SB_URL/rest/v1/dolar_historico?fecha=eq.$hoy&tipo=eq.ccl&select=close" -Headers $SB_HEADERS -ErrorAction Stop
        $mepVal = if ($mepRow.Count -gt 0) { [math]::Round([double]$mepRow[0].mep,2) } else { "N/A" }
        $ofVal  = if ($ofRow.Count -gt 0)  { [math]::Round([double]$ofRow[0].close,2) } else { "N/A" }
        $cclVal = if ($cclRow.Count -gt 0) { [math]::Round([double]$cclRow[0].close,2) } else { "N/A" }

        # Detectar faltantes y reportarlos
        $faltantes = @()
        if ($ofVal -eq "N/A")  { $faltantes += "Oficial" }
        if ($mepVal -eq "N/A") { $faltantes += "MEP" }
        if ($cclVal -eq "N/A") { $faltantes += "CCL" }

        $msg = "[Dolar $hoy]`nOficial: $ofVal`nMEP: $mepVal`nCCL: $cclVal"
        if ($faltantes.Count -gt 0) {
            $msg += "`n`n⚠️ *Faltante(s):* $($faltantes -join ', ')"
            Write-Log "WARN resumen: faltan $($faltantes -join ', ')"
        }
        Send-Telegram $msg
    } catch { Write-Log "ERROR resumen dolar: $($_ | Out-String)" }
}

# ── Snapshot diario P&L portafolio (17:06–17:59 ARG) ─────
# Itera todos los usuarios con posiciones activas y guarda en pnl_diario
if ($hNow -ge [TimeSpan]"17:06:00" -and $hNow -lt [TimeSpan]"17:59:00") {
    $hoy = Get-ArgDateString "yyyy-MM-dd"
    try {
        Write-Log "INFO PnL: iniciando snapshot diario para $hoy"
        # MEP del cierre de hoy (compartido para todos los usuarios)
        $mepRow = Invoke-RestMethod -Uri "$SB_URL/rest/v1/mep_historico?fecha=eq.$hoy&select=mep" -Headers $SB_HEADERS -ErrorAction Stop
        if ($mepRow.Count -eq 0) { throw "sin MEP hoy — PnL no puede calcularse" }
        $mepHoy = [double]$mepRow[0].mep
        if ($mepHoy -le 0) { throw "MEP inválido: $mepHoy" }
        Write-Log "INFO PnL: MEP = $mepHoy"
        $BONOS  = @('BONO_SOBERANO','DOLAR_LINKED','BONO_CER','BONO_DUAL')
        $postH  = $SB_HEADERS.Clone()
        $postH["Content-Type"] = "application/json"
        $postH["Prefer"]       = "resolution=merge-duplicates,return=minimal"

        # Verificar frescura de precios en mercado
        try {
            $merUrl = "$SB_URL/rest/v1/mercado?select=updated_at&order=updated_at.desc.nullslast&limit=1"
            $mu = Invoke-RestMethod -Uri $merUrl -Headers $SB_HEADERS -ErrorAction Stop
            if ($mu -and $mu[0].updated_at) {
                $merUpd = [datetime]::Parse($mu[0].updated_at).ToUniversalTime()
                $merAge = ([datetime]::UtcNow - $merUpd).TotalMinutes
                if ($merAge -gt 60) {
                    Write-Log "WARN PnL: precios mercado tienen $([int]$merAge) minutos — pueden ser del día anterior"
                }
            }
        } catch { Write-Log "WARN PnL: no se pudo verificar frescura de mercado: $($_ | Out-String)" }

        # Obtener todos los usuarios con posiciones activas
        $usuarios = Invoke-RestMethod -Uri "$SB_URL/rest/v1/portafolio?activo=eq.true&tipo=neq.OPCION&select=user_email" -Headers $SB_HEADERS -ErrorAction Stop |
                    Select-Object -ExpandProperty user_email -Unique
        Write-Log "INFO PnL: $($usuarios.Count) usuarios con posiciones activas"

        $pnlCount = 0
        foreach ($email in $usuarios) {
            try {
                $emailEnc = [uri]::EscapeDataString($email)

                # Saltar si ya existe el snapshot de hoy para este usuario
                $chk = Invoke-RestMethod -Uri "$SB_URL/rest/v1/pnl_diario?user_email=eq.$emailEnc&fecha=eq.$hoy&select=fecha" -Headers $SB_HEADERS -ErrorAction Stop
                if ($chk.Count -gt 0) { $pnlCount++; continue }

                # Posiciones de este usuario
                $posAll   = Invoke-RestMethod -Uri "$SB_URL/rest/v1/portafolio?activo=eq.true&tipo=neq.OPCION&user_email=eq.$emailEnc&select=ticker_ars,tipo,cantidad,fecha_compra" -Headers $SB_HEADERS -ErrorAction Stop
                if (-not $posAll -or $posAll.Count -eq 0) { continue }
                $posExist = $posAll | Where-Object { $_.fecha_compra -and $_.fecha_compra -lt $hoy }

                # Precios ARS actuales para los tickers de este usuario
                $tks = ($posAll | Select-Object -ExpandProperty ticker_ars -Unique) -join '","'
                $pxR = Invoke-RestMethod -Uri "$SB_URL/rest/v1/mercado?symbol=in.(`"$tks`")&settlement=eq.24hs&select=symbol,last" -Headers $SB_HEADERS -ErrorAction Stop
                $px  = @{}; $pxR | ForEach-Object { $px[$_.symbol] = [double]$_.last }

                # valor_usd = patrimonio total
                $totalUsd = 0
                foreach ($p in $posAll) {
                    $precio = $px[$p.ticker_ars]; if (-not $precio) { continue }
                    $factor = if ($BONOS -contains $p.tipo) { 100 } else { 1 }
                    $totalUsd += ([double]$p.cantidad * $precio) / ($factor * $mepHoy)
                }
                $totalUsd = [math]::Round($totalUsd, 2)

                # existingUsd = solo posiciones que ya existían ayer (pnl sin capital nuevo)
                $existingUsd = 0
                foreach ($p in $posExist) {
                    $precio = $px[$p.ticker_ars]; if (-not $precio) { continue }
                    $factor = if ($BONOS -contains $p.tipo) { 100 } else { 1 }
                    $existingUsd += ([double]$p.cantidad * $precio) / ($factor * $mepHoy)
                }
                $existingUsd = [math]::Round($existingUsd, 2)

                # P&L vs día anterior de este usuario
                $ayerR  = Invoke-RestMethod -Uri "$SB_URL/rest/v1/pnl_diario?user_email=eq.$emailEnc&fecha=lt.$hoy&order=fecha.desc&limit=1&select=valor_usd" -Headers $SB_HEADERS -ErrorAction Stop
                $pnlUsd = $null; $pnlPct = $null
                if ($ayerR.Count -gt 0 -and [double]$ayerR[0].valor_usd -gt 0) {
                    $v0     = [double]$ayerR[0].valor_usd
                    $pnlUsd = [math]::Round($existingUsd - $v0, 2)
                    $pnlPct = [math]::Round(($existingUsd - $v0) / $v0 * 100, 4)
                }

                $row = @{ user_email=$email; fecha=$hoy; valor_usd=$totalUsd; pnl_usd=$pnlUsd; pnl_pct=$pnlPct } | ConvertTo-Json
                Invoke-RestMethod -Uri "$SB_URL/rest/v1/pnl_diario" -Method Post -Headers $postH -Body $row | Out-Null
                $pnlCount++
                Write-Log "INFO PnL: $email — valor_usd=$totalUsd, pnl_usd=$pnlUsd"
            } catch { Write-Log "ERROR PnL usuario ${email}: $($_ | Out-String)" }
        }
        Write-Log "INFO PnL: $pnlCount/$($usuarios.Count) usuarios procesados para $hoy"
    } catch { Write-Log "ERROR PnL snapshot: $($_ | Out-String)" }
}

# ── Earnings alerts (una vez por día, horario libre) ──────
# Chequea próximos earnings de los ADRs del portafolio y avisa 3 y 1 día antes
$TODAY_STR  = Get-ArgDateString "yyyy-MM-dd"
$FLAG_EARN  = "$PSScriptRoot\earnings_chk_$TODAY_STR.flag"

if (-not (Test-Path $FLAG_EARN)) {
    New-Item $FLAG_EARN -ItemType File -Force | Out-Null
    # Limpiar flags de días anteriores
    Get-ChildItem "$PSScriptRoot\earnings_chk_*.flag" |
        Where-Object { $_.Name -notmatch $TODAY_STR } |
        Remove-Item -ErrorAction SilentlyContinue

    try {
        # Obtener tickers ADR del portafolio (activos, con ticker_adr definido)
        $posUrl = "$SB_URL/rest/v1/portafolio?activo=eq.true&select=ticker_adr&ticker_adr=not.is.null"
        $posR   = Invoke-RestMethod -Uri $posUrl -Headers $SB_HEADERS -ErrorAction Stop
        $adrs   = @($posR | Where-Object { $_.ticker_adr } | ForEach-Object { $_.ticker_adr } | Select-Object -Unique)

        if ($adrs.Count -gt 0) {
            $edgeUrl = "https://endymbpdayeidromxayb.supabase.co/functions/v1/yahoo-prices"
            $edgeH   = @{
                apikey        = $SB_KEY
                Authorization = "Bearer $SB_KEY"
                "Content-Type"= "application/json"
            }
            $edgeBody = @{ mode="earnings"; symbols=$adrs } | ConvertTo-Json
            $earningsData = Invoke-RestMethod -Uri $edgeUrl -Method Post -Headers $edgeH -Body $edgeBody -ErrorAction Stop

            foreach ($item in $earningsData) {
                $sym   = $item.symbol
                $eDate = $item.earningsDate
                if (-not $eDate) { continue }

                $daysUntil = ([datetime]$eDate - [datetime]$TODAY_STR).Days
                if ($daysUntil -lt 0 -or $daysUntil -gt 5) { continue }

                # Flag por ticker+fecha para no repetir el mismo earnings
                $flagKey = "$PSScriptRoot\earnings_${sym}_${eDate}.flag"
                if (Test-Path $flagKey) { continue }
                New-Item $flagKey -ItemType File -Force | Out-Null
                # Limpiar flags viejos de este ticker
                Get-ChildItem "$PSScriptRoot\earnings_${sym}_*.flag" |
                    Where-Object { $_.Name -notmatch $eDate } |
                    Remove-Item -ErrorAction SilentlyContinue

                $cuando = if ($daysUntil -eq 0) { "HOY" } elseif ($daysUntil -eq 1) { "mañana" } else { "en $daysUntil días" }
                Send-Telegram "[Earnings] *${sym}* reporta *$cuando* ($eDate)`nRevisá posición antes del anuncio."
            }
        }
    } catch {}
}

# ── Monitor de bateria ─────────────────────────────────────
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
if (-not $bat) { exit }   # no hay bateria (PC de escritorio)

$pct    = $bat.EstimatedChargeRemaining
$status = $bat.BatteryStatus
# BatteryStatus 1 = descargando, resto = conectado/cargando

$descargando = ($status -eq 1)

if (-not $descargando) {
    # Esta cargando — resetear flags para la proxima vez
    Remove-Item $FLAG_20 -ErrorAction SilentlyContinue
    Remove-Item $FLAG_10 -ErrorAction SilentlyContinue
    exit
}

# Nivel critico: 10%
if ($pct -le 10 -and -not (Test-Path $FLAG_10)) {
    Send-Telegram "[CRITICO] *BATERIA CRITICA - $pct%*`nConecta el cargador YA o la notebook se apaga."
    New-Item $FLAG_10 -ItemType File -Force | Out-Null
    New-Item $FLAG_20 -ItemType File -Force | Out-Null
    exit
}

# Nivel bajo: 20%
if ($pct -le 20 -and -not (Test-Path $FLAG_20)) {
    Send-Telegram "[AVISO] *Bateria baja - $pct%*`nConecta el cargador cuando puedas."
    New-Item $FLAG_20 -ItemType File -Force | Out-Null
}
