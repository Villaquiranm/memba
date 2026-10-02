import { useEffect, useRef, useState } from "react"
import { accept, cancel, getActive, offer, type Game } from "../../lib/connect4"
import { Card, Gate, Loading, Pill, Table, Toggle, type Column } from "../../os/kit"
import { TxError } from "./TxError"
import { fmtSeconds, formatGnot, shortAddr, useActive, useChainNow, useTx } from "./useConnect4"
import "./connect4.css"

// The realm's default fee, used for the pre-sign estimate only; per-game results use g.fee.
const FEE_UGNOT = 100_000

export function Lobby({ me, connected, onOpen }: { me: string; connected: boolean; onOpen: (id: number) => void }) {
    const { data, dataUpdatedAt, isLoading } = useActive()
    const now = useChainNow(data?.now, dataUpdatedAt)
    const tx = useTx()
    const alive = useRef(true)
    useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    const [stake, setStake] = useState("1")
    const [validFor, setValidFor] = useState("10")
    const [opponent, setOpponent] = useState("")
    const [mineOnly, setMineOnly] = useState(false)
    const games = (data?.games ?? []).filter((g) => !mineOnly || g.creator === me || g.acceptor === me || g.opponent === me)
    const offers = games.filter((g) => g.status === "open")
    const live = games.filter((g) => g.status === "playing")

    // A creator whose offer was accepted must reveal: open that game so the reveal prompt/auto-reveal runs.
    const opened = useRef(new Set<number>())
    useEffect(() => {
        if (!connected) return
        for (const g of data?.games ?? []) {
            if (g.status === "playing" && g.turn === 0 && g.creator === me && !opened.current.has(g.id)) {
                opened.current.add(g.id)
                onOpen(g.id)
            }
        }
    }, [data, connected, me, onOpen])

    const stakeUgnot = Math.round(Number(stake) * 1_000_000)
    const minutes = Number(validFor)
    const formOk = Number.isSafeInteger(stakeUgnot) && stakeUgnot >= 1_000_000 && stakeUgnot > FEE_UGNOT
        && Number.isInteger(minutes) && minutes >= 1 && minutes <= 60
        && (opponent === "" || /^g1[02-9ac-hj-np-z]{38}$/.test(opponent))

    const post = () => tx.run(async () => {
        const commitment = await offer(me, { stakeUgnot, validFor: minutes, opponent })
        // ponytail: finds the new game in the first 100 active games; page if the lobby ever grows past that.
        for (let i = 0; i < 10; i++) {
            if (!alive.current) return
            const found = (await getActive(0, 100))?.games.find((g) => g.creator === me && g.commitment === commitment)
            if (!alive.current) return
            if (found) { onOpen(found.id); return }
            await new Promise((r) => setTimeout(r, 1_500))
        }
        if (alive.current) throw new Error("Your offer was posted but hasn't appeared yet — it will show in the lobby shortly.")
    })

    const canAccept = (g: Game) => connected && g.creator !== me && (g.opponent === "" || g.opponent === me) && now < g.expiresAt
    const canCancel = (g: Game) => connected && (g.creator === me || now >= g.expiresAt)
    const who = (a: string) => (a === me ? "you" : shortAddr(a))

    const offerColumns: Column<Game>[] = [
        { key: "game", label: "Game", render: (g) => <span className="os-row">#{g.id}{g.opponent && <Pill>private</Pill>}</span> },
        { key: "stake", label: "Stake", align: "end", render: (g) => formatGnot(g.stake), sort: (a, b) => a.stake - b.stake },
        { key: "creator", label: "Creator", render: (g) => who(g.creator) },
        { key: "expires", label: "Expires", render: (g) => (now >= g.expiresAt ? <Pill tone="warn">expired</Pill> : fmtSeconds(g.expiresAt - now)) },
        {
            key: "actions", label: "", align: "end", render: (g) => <span className="os-row c4-actions">
                <button type="button" className="os-btn" disabled={tx.pending || !canAccept(g)} onClick={() => tx.run(async () => { await accept(me, g); onOpen(g.id) })}>Accept</button>
                {canCancel(g) && <button type="button" className="os-btn os-quiet" disabled={tx.pending} onClick={() => tx.run(() => cancel(me, g.id))}>Cancel</button>}
            </span>,
        },
    ]
    const liveColumns: Column<Game>[] = [
        { key: "game", label: "Game", render: (g) => <span className="os-row">#{g.id}{(g.creator === me || g.acceptor === me) && <Pill tone="ok">yours</Pill>}</span> },
        { key: "pot", label: "Pot", align: "end", render: (g) => formatGnot(2 * g.stake) },
        { key: "turn", label: "Turn", render: (g) => (g.turn === 0 ? <Pill tone="warn">awaiting reveal</Pill> : g.turnPlayer === me ? <Pill tone="ok">your move</Pill> : shortAddr(g.turnPlayer)) },
    ]

    return <div className="os-stack c4">
        <div className="os-row c4-head">
            <div className="os-grow">
                <h2>Connect 4</h2>
                <p className="os-sub">Both players stake the same GNOT; the winner takes the pot minus a {formatGnot(FEE_UGNOT)} fee. Each move has 90 seconds of chain time — run out and you forfeit.</p>
            </div>
            {connected && <span className="os-row"><span id="c4-mine" className="os-sub">Only my games</span><Toggle checked={mineOnly} onChange={setMineOnly} labelledBy="c4-mine" /></span>}
        </div>
        <TxError message={tx.error} onDismiss={tx.clearError} />
        {!connected && <Gate text="Connect your wallet to play. You can watch games without one." />}

        {isLoading ? <Loading label="Loading games…" /> : <>
            <section className="os-stack os-tight">
                <h3>Open offers</h3>
                <Table columns={offerColumns} rows={offers} rowKey={(g) => String(g.id)} empty="No open offers." />
            </section>
            <section className="os-stack os-tight">
                <h3>Live games</h3>
                <Table columns={liveColumns} rows={live} rowKey={(g) => String(g.id)} empty="No live games."
                    onRowClick={(g) => onOpen(g.id)} rowLabel={(g) => `Open game #${g.id}`} />
            </section>
        </>}

        {connected && <Card>
            <form className="os-stack os-tight c4-form os-grow" onSubmit={(e) => { e.preventDefault(); if (formOk) void post() }}>
                <h3>Post an offer</h3>
                <div className="c4-fields">
                    <label>Stake (GNOT)<input type="number" min="1" step="0.1" value={stake} onChange={(e) => setStake(e.target.value)} /></label>
                    <label>Valid for (minutes)<input type="number" min="1" max="60" value={validFor} onChange={(e) => setValidFor(e.target.value)} /></label>
                    <label>Opponent address (optional)<input value={opponent} onChange={(e) => setOpponent(e.target.value.trim())} placeholder="g1…" /></label>
                </div>
                <p className="os-sub">Winner receives <b>{formOk ? formatGnot(2 * stakeUgnot - FEE_UGNOT) : "—"}</b>.</p>
                <div className="os-note os-warn">After someone accepts, you must reveal within 90 seconds — keep this tab open until the game starts. The reveal key is stored only in this browser; missing it forfeits your stake.</div>
                <div><button type="submit" className="os-btn" disabled={!formOk || tx.pending}>Post offer</button></div>
            </form>
        </Card>}
    </div>
}
