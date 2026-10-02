import { useEffect, useRef } from "react"
import { cancel, claimTimeout, play, resign, reveal, revealKey, type Game } from "../../lib/connect4"
import { Empty, Loading, Pill, type PillTone } from "../../os/kit"
import { Board } from "./Board"
import { TxError } from "./TxError"
import { fmtSeconds, formatGnot, shortAddr, useChainNow, useGame, useTx } from "./useConnect4"
import "./connect4.css"

const STATUS_TONE: Record<Game["status"], PillTone> = { open: "neutral", playing: "ok", won: "neutral", draw: "neutral", void: "neutral", cancelled: "neutral" }

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

    const back = <button type="button" className="os-btn os-quiet" onClick={onBack}>← Lobby</button>
    if (isLoading) return <Loading label={`Loading game #${id}…`} />
    if (!g) {
        if (data?.game === null) return <Empty title={`Game #${id} not found.`} action={back} />
        return <div className="os-stack">{isError ? <div className="os-note os-warn" role="status">Couldn't reach the network. Retrying…</div> : <Loading label={`Loading game #${id}…`} />}<div>{back}</div></div>
    }

    const myTurn = connected && g.status === "playing" && g.turnPlayer === me && !expired
    const clock = expired ? "clock ran out" : `${fmtSeconds(left)} left`
    const won = g.status === "won" && g.winner === me

    return <div className="os-stack c4">
        <div className="os-row c4-head">
            {back}
            <h2 className="os-grow">Game #{id}</h2>
            <Pill tone={STATUS_TONE[g.status]}>{g.status}</Pill>
            <span className="os-sub">pot {formatGnot(2 * g.stake)}</span>
        </div>
        <TxError message={tx.error} onDismiss={tx.clearError} />

        {g.status === "open" && <div className="os-note" role="status">Waiting for an opponent · offer {now >= g.expiresAt ? "expired" : `expires in ${fmtSeconds(g.expiresAt - now)}`}</div>}
        {needsReveal && <div className={expired ? "os-note os-warn" : "os-note"} role="status">Waiting for the creator to reveal · {expired ? "reveal clock ran out" : `${fmtSeconds(left)} left`}</div>}
        {g.status === "playing" && g.turn !== 0 && <div className={myTurn ? "os-note os-ok" : expired ? "os-note os-warn" : "os-note"} role="status">
            {myTurn ? "Your move" : isPlayer ? "Opponent's move" : `${shortAddr(g.turnPlayer)}'s move`} · {clock}
        </div>}
        {isCreator && needsReveal && !expired && !key && <div className="os-note os-err" role="alert">Your reveal key isn't on this device; you'll forfeit when the 90s runs out.</div>}
        {!["open", "playing"].includes(g.status) && <div className={won ? "os-note os-ok" : "os-note"} role="status">{result(g, me)}</div>}

        <div className="c4-play">
            <Board game={g} canPlay={myTurn && !tx.pending} onPlay={(c) => void tx.run(() => play(me, g.id, c))} />
            <dl className="c4-players">
                <dt><span className="c4-dot c4-p1" /> Creator</dt><dd>{g.creator === me ? "you" : shortAddr(g.creator)}</dd>
                <dt><span className="c4-dot c4-p2" /> Acceptor</dt><dd>{g.acceptor ? (g.acceptor === me ? "you" : shortAddr(g.acceptor)) : "—"}</dd>
                <dt>Stake each</dt><dd>{formatGnot(g.stake)}</dd>
                <dt>Moves</dt><dd>{g.moves}</dd>
            </dl>
        </div>

        <div className="os-row">
            {isCreator && needsReveal && key && <button type="button" className="os-btn" disabled={tx.pending} onClick={() => void tx.run(() => reveal(me, g.id, key))}>Reveal</button>}
            {expired && <button type="button" className="os-btn" disabled={tx.pending} onClick={() => void tx.run(() => claimTimeout(me, g.id))}>Claim timeout</button>}
            {connected && g.status === "open" && (isCreator || now >= g.expiresAt) && <button type="button" className="os-btn os-quiet" disabled={tx.pending} onClick={() => void tx.run(() => cancel(me, g.id))}>Cancel</button>}
            {isPlayer && g.status === "playing" && <button type="button" className="os-btn os-quiet" disabled={tx.pending} onClick={() => void tx.run(() => resign(me, g.id))}>Resign</button>}
        </div>
    </div>
}
