import { useState } from "react"
import { accept, cancel, getActive, offer, type Game } from "../../lib/connect4"
import { ErrorToast } from "../../components/ui/ErrorToast"
import { fmtSeconds, formatGnot, useActive, useChainNow, useTx } from "./useConnect4"

const FEE_UGNOT = 100_000 // realm default; the form re-checks against each offer's own fee in the table

export function Lobby({ me, connected, onOpen }: { me: string; connected: boolean; onOpen: (id: number) => void }) {
    const { data, dataUpdatedAt } = useActive()
    const now = useChainNow(data?.now, dataUpdatedAt)
    const tx = useTx()
    const [stake, setStake] = useState("1")
    const [validFor, setValidFor] = useState("10")
    const [opponent, setOpponent] = useState("")
    const games = data?.games ?? []
    const offers = games.filter((g) => g.status === "open")
    const live = games.filter((g) => g.status === "playing")

    const stakeUgnot = Math.round(Number(stake) * 1_000_000)
    const minutes = Number(validFor)
    const formOk = Number.isSafeInteger(stakeUgnot) && stakeUgnot >= 1_000_000 && stakeUgnot > FEE_UGNOT
        && Number.isInteger(minutes) && minutes >= 1 && minutes <= 60
        && (opponent === "" || /^g1[02-9ac-hj-np-z]{38}$/.test(opponent))

    const post = () => tx.run(async () => {
        const commitment = await offer(me, { stakeUgnot, validFor: minutes, opponent })
        // ponytail: finds the new game in the first 100 active games; page if the lobby ever grows past that.
        for (let i = 0; i < 10; i++) {
            const found = (await getActive(0, 100))?.games.find((g) => g.creator === me && g.commitment === commitment)
            if (found) { onOpen(found.id); return }
            await new Promise((r) => setTimeout(r, 1_500))
        }
    })

    const canAccept = (g: Game) => connected && g.creator !== me && (g.opponent === "" || g.opponent === me) && now < g.expiresAt
    const canCancel = (g: Game) => connected && (g.creator === me || now >= g.expiresAt)

    return <div className="os-stack">
        <div>
            <h2>Connect 4</h2>
            <p className="os-sub">Both players stake the same GNOT; the winner takes the pot minus a {formatGnot(FEE_UGNOT)} fee. Each move has 90 seconds of chain time — run out and you forfeit.</p>
        </div>
        <ErrorToast message={tx.error} onDismiss={tx.clearError} />
        {!connected && <div className="os-note" role="status">Connect your wallet to play. You can watch games without one.</div>}

        <h3>Open offers</h3>
        <table><thead><tr><th>Game</th><th>Stake</th><th>Creator</th><th>Expires</th><th /></tr></thead><tbody>
            {offers.length === 0 && <tr><td colSpan={5}>No open offers.</td></tr>}
            {offers.map((g) => <tr key={g.id} aria-label={`#${g.id}`}>
                <td>#{g.id}{g.opponent && " · private"}</td>
                <td>{formatGnot(g.stake)}</td>
                <td>{g.creator === me ? "you" : g.creator}</td>
                <td>{now >= g.expiresAt ? "expired" : fmtSeconds(g.expiresAt - now)}</td>
                <td>
                    <button type="button" disabled={tx.pending || !canAccept(g)} onClick={() => tx.run(async () => { await accept(me, g); onOpen(g.id) })}>Accept</button>
                    {canCancel(g) && <button type="button" disabled={tx.pending} onClick={() => tx.run(() => cancel(me, g.id))}>Cancel</button>}
                </td>
            </tr>)}
        </tbody></table>

        <h3>Live games</h3>
        <table><thead><tr><th>Game</th><th>Pot</th><th>Turn</th></tr></thead><tbody>
            {live.length === 0 && <tr><td colSpan={3}>No live games.</td></tr>}
            {live.map((g) => <tr key={g.id} aria-label={`#${g.id}`} onClick={() => onOpen(g.id)} style={{ cursor: "pointer" }}>
                <td><button type="button" className="os-link" onClick={() => onOpen(g.id)}>#{g.id}</button>{(g.creator === me || g.acceptor === me) && " · yours"}</td>
                <td>{formatGnot(2 * g.stake)}</td>
                <td>{g.turn === 0 ? "awaiting reveal" : g.turnPlayer === me ? "you" : g.turnPlayer}</td>
            </tr>)}
        </tbody></table>

        {connected && <form className="os-stack" onSubmit={(e) => { e.preventDefault(); if (formOk) void post() }}>
            <h3>Post an offer</h3>
            <label>Stake (GNOT) <input type="number" min="1" step="0.1" value={stake} onChange={(e) => setStake(e.target.value)} /></label>
            <label>Valid for (minutes) <input type="number" min="1" max="60" value={validFor} onChange={(e) => setValidFor(e.target.value)} /></label>
            <label>Opponent address (optional) <input value={opponent} onChange={(e) => setOpponent(e.target.value.trim())} placeholder="g1…" /></label>
            <p className="os-sub">Winner receives {formOk ? formatGnot(2 * stakeUgnot - FEE_UGNOT) : "—"}. After someone accepts, this device must be open to reveal within 90 seconds — the reveal key is stored only in this browser. Missing it forfeits your stake.</p>
            <button type="submit" disabled={!formOk || tx.pending}>Post offer</button>
        </form>}
    </div>
}
