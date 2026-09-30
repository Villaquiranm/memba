import { useEffect, useRef } from "react"
import { cancel, claimTimeout, play, resign, reveal, revealKey, type Game } from "../../lib/connect4"
import { ErrorToast } from "../../components/ui/ErrorToast"
import { Board } from "./Board"
import { fmtSeconds, formatGnot, useChainNow, useGame, useTx } from "./useConnect4"

function result(g: Game, me: string): string {
    const pot = 2 * g.stake - g.fee
    if (g.status === "won") return g.winner === me ? `You won ${formatGnot(pot)}.` : `${g.winner === g.creator ? "Creator" : "Acceptor"} won ${formatGnot(pot)}.`
    if (g.status === "draw") return `Draw — each player got ${formatGnot(g.stake)} back.`
    if (g.status === "void") return "Void — no one moved in time; both stakes were refunded."
    return "Offer cancelled; the stake was refunded."
}

export function GameView({ id, me, connected, onBack }: { id: number; me: string; connected: boolean; onBack: () => void }) {
    const { data, dataUpdatedAt, isLoading, isError } = useGame(id)
    const now = useChainNow(data?.now, dataUpdatedAt)
    const tx = useTx()
    const g = data?.game ?? null
    const isCreator = connected && g?.creator === me
    const isPlayer = connected && (g?.creator === me || g?.acceptor === me)
    const needsReveal = g?.status === "playing" && g.turn === 0
    const left = g ? g.deadline - now : 0
    const expired = g?.status === "playing" && left <= 0
    const key = isCreator && needsReveal && !expired && g ? revealKey(me, g.commitment) : null
    const autoRevealed = useRef(false)

    useEffect(() => {
        if (!key || !g || autoRevealed.current) return
        autoRevealed.current = true
        void tx.run(() => reveal(me, g.id, key))
    }, [key, g, me, tx])

    if (isLoading) return <p className="os-sub">Loading game #{id}…</p>
    if (!g) {
        const notFound = data?.game === null
        return <div className="os-stack"><p>{notFound ? `Game #${id} not found.` : isError ? "Couldn't reach the network. Retrying…" : `Loading game #${id}…`}</p><button type="button" onClick={onBack}>Back to lobby</button></div>
    }

    const myTurn = connected && g.status === "playing" && g.turnPlayer === me && !expired

    return <div className="os-stack">
        <button type="button" className="os-link" onClick={onBack}>← Lobby</button>
        <h2>Game #{id} · pot {formatGnot(2 * g.stake)}</h2>
        <ErrorToast message={tx.error} onDismiss={tx.clearError} />

        {g.status === "open" && <p role="status">Waiting for an opponent · offer {now >= g.expiresAt ? "expired" : `expires in ${fmtSeconds(g.expiresAt - now)}`}</p>}
        {needsReveal && <p role="status">Waiting for the creator to reveal · {expired ? "reveal clock ran out" : `${fmtSeconds(left)} left`}</p>}
        {g.status === "playing" && g.turn !== 0 && <p role="status">
            {myTurn ? "Your move" : isPlayer ? "Opponent's move" : `${g.turnPlayer}'s move`} · {expired ? "clock ran out" : `${fmtSeconds(left)} left`}
        </p>}
        {isCreator && needsReveal && !expired && !key && <div className="os-note" role="alert">Your reveal key isn't on this device; you'll forfeit when the 90s runs out.</div>}
        {!["open", "playing"].includes(g.status) && <div className="os-note" role="status">{result(g, me)}</div>}

        <Board game={g} canPlay={myTurn && !tx.pending} onPlay={(c) => void tx.run(() => play(me, g.id, c))} />

        <div className="os-row">
            {isCreator && needsReveal && key && <button type="button" disabled={tx.pending} onClick={() => void tx.run(() => reveal(me, g.id, key))}>Reveal</button>}
            {isPlayer && g.status === "playing" && <button type="button" disabled={tx.pending} onClick={() => void tx.run(() => resign(me, g.id))}>Resign</button>}
            {connected && g.status === "open" && (isCreator || now >= g.expiresAt) && <button type="button" disabled={tx.pending} onClick={() => void tx.run(() => cancel(me, g.id))}>Cancel</button>}
            {expired && <button type="button" disabled={tx.pending} onClick={() => void tx.run(() => claimTimeout(me, g.id))}>Claim timeout</button>}
        </div>
    </div>
}
