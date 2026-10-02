import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { QUICKPLAY_DURATIONS, endQuickPlay, forgetQuickPlay, quickPlayStatus, startQuickPlay, type QuickPlayDuration } from "../../lib/quickPlay"
import { TxError } from "./TxError"

const LABEL: Record<QuickPlayDuration, string> = { 3600: "1h", 14400: "4h", 86400: "24h" }

export function QuickPlay({ me, connected }: { me: string; connected: boolean }) {
    const client = useQueryClient()
    const { data: status, isError } = useQuery({ queryKey: ["quickplay", me], queryFn: () => quickPlayStatus(me), enabled: connected && !!me, refetchInterval: 30_000 })
    // Wall-clock seconds in state (ticks each second): Date.now() in render is impure.
    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
    useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000); return () => clearInterval(t) }, [])
    const [open, setOpen] = useState(false)
    const [duration, setDuration] = useState<QuickPlayDuration>(14400)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    if (!connected || !me) return null

    const act = async (fn: () => Promise<unknown>) => {
        setBusy(true); setError(null)
        try { await fn(); setOpen(false) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { setBusy(false); await client.invalidateQueries({ queryKey: ["quickplay", me] }) }
    }

    if (isError) return <div className="c4-qp"><span className="os-note os-warn" role="status">Couldn't read Quick play status</span></div>

    if (status) {
        const left = Math.max(0, Math.floor(status.expiresAt - now))
        const budget = (status.spendLimitUgnot - status.spendUsedUgnot) / 1_000_000
        return <div className="c4-qp" data-on="true">
            <span className="c4-qp-pill">⚡ Quick play · {Math.floor(left / 3600)}h {Math.floor((left % 3600) / 60)}m left · {budget.toFixed(2)} GNOT budget</span>
            <button type="button" className="os-btn os-quiet" disabled={busy} onClick={() => act(() => endQuickPlay(me))}>End session</button>
            <button type="button" className="os-btn os-quiet" disabled={busy} onClick={() => { forgetQuickPlay(me); void client.invalidateQueries({ queryKey: ["quickplay", me] }) }}>Forget on this device</button>
            <TxError message={error} onDismiss={() => setError(null)} />
        </div>
    }

    return <div className="c4-qp">
        <button type="button" className="os-btn c4-qp-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>⚡ Quick play</button>
        {open && <div className="c4-qp-panel">
            <div className="c4-quick" role="group" aria-label="Quick play duration">
                {QUICKPLAY_DURATIONS.map((d) => <button key={d} type="button" aria-pressed={d === duration} onClick={() => setDuration(d)}>{LABEL[d]}</button>)}
            </div>
            <p className="os-sub">Moves sign automatically. Stakes still ask your wallet. Up to 1 GNOT/day of gas.</p>
            <button type="button" className="os-btn c4-cta" disabled={busy} onClick={() => act(() => startQuickPlay(me, duration))}>Start · 1 wallet approval</button>
            <TxError message={error} onDismiss={() => setError(null)} />
        </div>}
    </div>
}
