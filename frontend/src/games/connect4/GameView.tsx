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
    const won = g.status === "won" && g.winner === me
    const lost = g.status === "won" && isPlayer && g.winner !== me
    const piece = !connected ? undefined : g.creator === me ? "1" : g.acceptor === me ? "2" : undefined
    const live = g.status === "playing" && g.turn !== 0
    const turnText = myTurn ? "Your move!" : isPlayer ? "Opponent's move" : `${shortAddr(g.turnPlayer)}'s move`

    return <div className="os-stack c4">
        <div className="os-row c4-head">
            {back}
            <h2 className="os-grow">Game #{id}</h2>
            <Pill tone={STATUS_TONE[g.status]}>{g.status}</Pill>
            <span className="os-sub">pot {formatGnot(2 * g.stake)}</span>
        </div>
        <TxError message={tx.error} onDismiss={tx.clearError} />

        {!["open", "playing"].includes(g.status) && <div className="c4-banner" role="status" data-tone={won ? "win" : lost ? "lose" : undefined}>
            <span>{result(g, me)}{won && <small>The pot is on its way to your wallet.</small>}</span>
        </div>}
        {g.status === "open" && <div className="os-note" role="status">Waiting for an opponent · offer {now >= g.expiresAt ? "expired" : `expires in ${fmtSeconds(g.expiresAt - now)}`}</div>}
        {needsReveal && <div className={expired ? "os-note os-warn" : "os-note"} role="status">Waiting for the creator to reveal · {expired ? "reveal clock ran out" : `${fmtSeconds(left)} left`}</div>}
        {isCreator && needsReveal && !expired && !key && <div className="os-note os-err" role="alert">Your reveal key isn't on this device; you'll forfeit when the 90s runs out.</div>}

        <div className="c4-arena">
            <Board game={g} piece={piece} canPlay={myTurn && !tx.pending} onPlay={(c) => void tx.run(() => play(me, g.id, c))} />
            <div className="c4-side">
                {live && <div className="c4-turn" role="status" data-mine={myTurn}>{turnText}<small>{expired ? "clock ran out" : `${fmtSeconds(left)} left`}</small></div>}
                <PlayerCard colour="red" label="Creator" addr={g.creator} me={me} active={live && g.turn === 1} left={left} />
                <PlayerCard colour="yellow" label="Acceptor" addr={g.acceptor} me={me} active={live && g.turn === 2} left={left} />
                <dl className="c4-stats">
                    <dt>Stake each</dt><dd>{formatGnot(g.stake)}</dd>
                    <dt>Winner gets</dt><dd>{formatGnot(2 * g.stake - g.fee)}</dd>
                    <dt>Moves</dt><dd>{g.moves}</dd>
                </dl>
                <div className="os-row">
                    {isCreator && needsReveal && key && <button type="button" className="os-btn c4-cta" disabled={tx.pending} onClick={() => void tx.run(() => reveal(me, g.id, key))}>Reveal</button>}
                    {expired && <button type="button" className="os-btn c4-cta" disabled={tx.pending} onClick={() => void tx.run(() => claimTimeout(me, g.id))}>Claim timeout</button>}
                    {connected && g.status === "open" && (isCreator || now >= g.expiresAt) && <button type="button" className="os-btn os-quiet" disabled={tx.pending} onClick={() => void tx.run(() => cancel(me, g.id))}>Cancel</button>}
                    {isPlayer && g.status === "playing" && <button type="button" className="os-btn os-quiet" disabled={tx.pending} onClick={() => void tx.run(() => resign(me, g.id))}>Resign</button>}
                </div>
            </div>
        </div>
    </div>
}

const MOVE_SECONDS = 90
const RING = 2 * Math.PI * 18

function PlayerCard({ colour, label, addr, me, active, left }: { colour: "red" | "yellow"; label: string; addr: string; me: string; active: boolean; left: number }) {
    const secs = Math.max(0, Math.min(MOVE_SECONDS, left))
    const level = secs <= 15 ? "danger" : secs <= 30 ? "warn" : "ok"
    return <div className={`c4-player c4-${colour}-turn`} data-active={active}>
        <span className={`c4-player-disc c4-${colour}`} aria-hidden="true" />
        <span className="os-grow">
            <b>{addr ? (addr === me ? "You" : shortAddr(addr)) : "Waiting…"}</b>
            <small>{label}{active ? " · on turn" : ""}</small>
        </span>
        {active && <span className="c4-clock" data-level={level} aria-hidden="true">
            <svg viewBox="0 0 44 44"><circle className="c4-clock-track" cx="22" cy="22" r="18" /><circle className="c4-clock-fill" cx="22" cy="22" r="18" strokeDasharray={RING} strokeDashoffset={RING * (1 - secs / MOVE_SECONDS)} /></svg>
            <span>{secs}</span>
        </span>}
    </div>
}
