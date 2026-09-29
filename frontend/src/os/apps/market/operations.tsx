/** Public Market Operations trail. Manager actions need the DAO adapter and wallet review. */
import { useEffect, useState } from "react"
import { getCollectionCuration, getCurationState, listCurationApplications, listCurationManagers, type CurationApplication, type CurationReceipt, type CurationSeat, type CurationState } from "../../../lib/launchpadCuration"
import { readCurationDaoSnapshot, type CurationDaoProposal } from "../../../lib/launchpadCurationDao"
import { Empty, ErrorState, Loading, Pill } from "../../kit"
import type { OsSession } from "../../shell/useOsSession"
import CurationDiscussion from "./discussion"
import PublicCurationEvidence from "./evidence"

const PAGE_SIZE = 20

export default function MarketOperations({ rpcUrl, daoAvailable, session }: { rpcUrl: string; daoAvailable: boolean; session: OsSession }) {
    const [page, setPage] = useState(0)
    const [revision, setRevision] = useState(0)
    const [team, setTeam] = useState<{ state: CurationState; seats: CurationSeat[] } | null>(null)
    const [applications, setApplications] = useState<CurationApplication[]>([])
    const [hasMore, setHasMore] = useState(false)
    const [settled, setSettled] = useState({ page: -1, revision: -1, error: false })
    const [selected, setSelected] = useState<string | null>(null)
    const [receipt, setReceipt] = useState<{ id: string; value?: CurationReceipt; error?: boolean } | null>(null)
    const loading = settled.page !== page || settled.revision !== revision
    const error = !loading && settled.error

    useEffect(() => {
        let cancelled = false
        void Promise.all([
            getCurationState(rpcUrl), listCurationManagers(rpcUrl),
            listCurationApplications(rpcUrl, page, PAGE_SIZE),
        ]).then(([state, seats, next]) => {
            if (cancelled) return
            if (state.activeManagers !== seats.length) throw new Error("Curation roster changed during read")
            setTeam({ state, seats })
            setApplications((previous) => page === 0 ? next : [...previous, ...next])
            setHasMore(next.length === PAGE_SIZE)
            setSettled({ page, revision, error: false })
        }).catch(() => { if (!cancelled) setSettled({ page, revision, error: true }) })
        return () => { cancelled = true }
    }, [rpcUrl, page, revision])

    useEffect(() => {
        if (!selected) return
        let cancelled = false
        void getCollectionCuration(rpcUrl, selected).then((value) => {
            if (!cancelled) setReceipt({ id: selected, value })
        }).catch(() => { if (!cancelled) setReceipt({ id: selected, error: true }) })
        return () => { cancelled = true }
    }, [rpcUrl, selected])

    return <div className="os-stack os-market-operations">
        <header className="os-market-records-head"><div><h1>Market Operations</h1><p className="os-sub">A public trail of founder applications, community review seats and editorial decisions.</p></div><Pill tone="neutral">Public record</Pill></header>
        <div className="os-note" role="note">Application status and evidence hashes are public. Founder discussions require a connected founder or eligible manager wallet. Manager and DAO actions open after governance and wallet review are ready.</div>
        {loading && applications.length === 0 && <Loading label="Loading curation records…" />}
        {error && <ErrorState message="Could not verify curation records from this network." onRetry={() => setRevision((value) => value + 1)} />}
        {!error && team && !team.state.governed && <div className="os-note os-warn" role="note">The curation realm has not completed its DAO handoff.</div>}
        {!error && team && <section className="os-ops-team" aria-labelledby="os-ops-team-title">
            <div className="os-ops-section-head"><h2 id="os-ops-team-title">Community review team</h2><span>{team.state.activeManagers} of 5 active seats</span></div>
            {team.seats.length === 0 ? <p className="os-sub">The DAO has not appointed any active managers.</p> : <div className="os-ops-seats">{team.seats.map((seat) => <div className="os-ops-seat" key={seat.account}><Pill tone={seat.lead ? "ok" : "neutral"}>{seat.lead ? "Lead" : "Manager"}</Pill><code>{seat.account}</code><span>Term ends {formatTime(seat.until)}</span></div>)}</div>}
        </section>}
        {daoAvailable && <CurationGovernance rpcUrl={rpcUrl} />}
        <section className="os-stack" aria-labelledby="os-ops-applications-title">
            <div className="os-ops-section-head"><h2 id="os-ops-applications-title">Founder applications</h2><span>On-chain status and public evidence hashes</span></div>
            {!loading && !error && applications.length === 0 && <Empty title="No founder applications yet." />}
            {!error && applications.length > 0 && <div className="os-market-list" role="list">{applications.map((item) => <article className="os-market-record os-ops-record" role="listitem" key={item.collection}>
                <div className="os-market-record-core"><span className="os-market-token">{item.collection}</span><Pill tone={item.status === "recommended" ? "ok" : "neutral"}>{item.status.replaceAll("_", " ")}</Pill></div>
                <div className="os-market-record-meta"><span>Founder <code>{item.founder}</code></span><span>Revision {item.revision}</span><span>Updated {formatTime(item.updatedAt)}</span></div>
                <button type="button" className="os-btn os-quiet" aria-expanded={selected === item.collection} onClick={() => { setSelected((id) => id === item.collection ? null : item.collection); setReceipt(null) }}>{selected === item.collection ? "Hide record" : "View record"}</button>
                {selected === item.collection && <div className="os-market-terms">
                    <PublicCurationEvidence label="Application evidence" cid={item.statementCID} sha256={item.statementHash} />
                    {item.reviewer && <span>Reviewer <code>{item.reviewer}</code></span>}
                    {item.reasonHash && <PublicCurationEvidence label="Review reason" cid={item.reasonCID} sha256={item.reasonHash} />}
                    {!receipt || receipt.id !== item.collection || (!receipt.value && !receipt.error) ? <Loading label="Reading curation receipt…" /> : receipt.error ? <span role="alert">Could not verify this collection’s curation receipt.</span> : <ReceiptView value={receipt.value!} />}
                </div>}
                {selected === item.collection && <div className="os-curation-private-entry">
                    {session.status !== "member" || !session.layout.auth.token
                        ? <div className="os-note"><span>Connect a wallet to check whether you can join the private founder discussion.</span><button type="button" className="os-btn os-quiet" onClick={session.openConnect}>Connect wallet</button></div>
                        : <CurationDiscussion key={`${session.network.chainId}:${session.address}:${session.layout.auth.token.nonce}:${item.collection}`} collection={item.collection} account={session.address} chainId={session.network.chainId} token={session.layout.auth.token} />}
                </div>}
            </article>)}</div>}
            {loading && applications.length > 0 && <Loading label="Loading more applications…" />}
            {!error && !loading && hasMore && <button type="button" className="os-btn os-quiet" onClick={() => setPage((value) => value + 1)}>Load more applications</button>}
        </section>
    </div>
}

function CurationGovernance({ rpcUrl }: { rpcUrl: string }) {
    const [before, setBefore] = useState("0")
    const [revision, setRevision] = useState(0)
    const [entries, setEntries] = useState<CurationDaoProposal[]>([])
    const [state, setState] = useState<{ loading: boolean; error: boolean; next: string | null; total: string; successor: string }>({ loading: true, error: false, next: null, total: "0", successor: "" })

    useEffect(() => {
        let cancelled = false
        void readCurationDaoSnapshot(rpcUrl, before).then((result) => {
            if (cancelled) return
            setEntries((previous) => before === "0" ? result.proposals : [...previous, ...result.proposals])
            setState({ loading: false, error: false, next: result.nextBefore, total: result.total, successor: result.successor })
        }).catch(() => { if (!cancelled) setState((previous) => ({ ...previous, loading: false, error: true })) })
        return () => { cancelled = true }
    }, [rpcUrl, before, revision])

    return <section className="os-stack" aria-labelledby="os-ops-governance-title">
        <div className="os-ops-section-head"><h2 id="os-ops-governance-title">DAO curation proposals</h2><span>{state.total} total DAO proposals</span></div>
        <p className="os-sub">Read-only decisions from the separate weighted curation DAO. Existing Memba DAO policies remain in their published realm.</p>
        {state.successor && <p className="os-sub">Authority return destination: <code>{state.successor}</code></p>}
        {state.loading && <Loading label="Loading DAO decisions…" />}
        {state.error && <ErrorState message="Could not verify curation DAO decisions from this network." onRetry={() => { setState((previous) => ({ ...previous, loading: true, error: false })); setRevision((value) => value + 1) }} />}
        {!state.error && !state.loading && entries.length === 0 && <Empty title="No curation proposals yet." />}
        {!state.error && entries.length > 0 && <div className="os-market-list" role="list">{entries.map((item) => <article className="os-market-record os-ops-record" role="listitem" key={item.id}>
            <div className="os-market-record-core"><span className="os-market-token">Proposal {item.id}</span><Pill tone={item.status === "EXECUTED" ? "ok" : "neutral"}>{item.status.toLowerCase()}</Pill><strong>{curationActionLabel(item)}</strong></div>
            <div className="os-market-record-meta"><span>Proposed by <code>{item.proposer}</code></span><span>Voting ends {new Date(item.votingDeadline).toLocaleString()}</span>{item.action.collection && <span>Collection <code>{item.action.collection}</code></span>}{item.action.manager && <span>Manager <code>{item.action.manager}</code></span>}</div>
            {item.action.reasonHash && <span className="os-sub">Reason hash <code>{item.action.reasonHash}</code></span>}
            {item.status === "INVALIDATED" && <span className="os-sub">Invalidated before execution.</span>}
        </article>)}</div>}
        {!state.error && !state.loading && state.next && <button type="button" className="os-btn os-quiet" onClick={() => { setBefore(state.next!); setState((previous) => ({ ...previous, loading: true })) }}>Load older decisions</button>}
    </section>
}

function curationActionLabel(item: CurationDaoProposal): string {
    const labels: Record<CurationDaoProposal["action"]["operation"], string> = {
        "accept-admin": "Accept curation administration", "return-admin": "Stage authority return", "abort-return": "Cancel authority return",
        "appoint-manager": "Appoint manager", "remove-manager": "Remove manager", "mark-conflict": "Mark conflict",
        "set-verification": item.action.verified ? "Verify collection" : "Remove verification", "clear-feature": "Clear featured placement", "clear-hide": "Clear discovery hold",
    }
    return labels[item.action.operation]
}

function ReceiptView({ value }: { value: CurationReceipt }) {
    return <div className="os-ops-receipt">
        <span>DAO verification: <strong>{value.verification?.verified ? "Verified" : "Not verified"}</strong>{value.verification && <> · Reason <code>{value.verification.reasonHash}</code></>}</span>
        <span>Editorial placement: <strong>{value.featured ? "Featured" : "Not featured"}</strong>{value.feature && <> · Through {formatTime(value.feature.until)} · Reason <code>{value.feature.reasonHash}</code></>}</span>
        <span>Discovery hold: <strong>{value.hidden ? "Active" : "None"}</strong>{value.hold && <> · Through {formatTime(value.hold.until)} · Reason <code>{value.hold.reasonHash}</code></>}</span>
        <span className="os-sub">Verification identifies a DAO authenticity decision. It does not promise price performance or endorse a trade.</span>
    </div>
}

function formatTime(seconds: string): string {
    const date = new Date(Number(seconds) * 1000)
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : `${seconds} Unix seconds`
}
