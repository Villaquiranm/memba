/** Current-role manager lookup for discovery holds on any NFT collection. */
import { useEffect, useState } from "react"
import { getCollectionCuration, getCurationApplication, getCurationState,
    type CurationApplication, type CurationReceipt, type CurationState } from "../../../lib/launchpadCuration"
import { readCurationEditorialAccess } from "../../../lib/launchpadCurationInbox"
import { CURATION_ACTION_GAS_WANTED } from "../../../lib/launchpadCurationActions"
import { editorialRequest, editorialScope, type EditorialAction } from "../../../lib/launchpadCurationEditorial"
import { type VerifiedCurationEvidence } from "../../../lib/launchpadCurationEvidence"
import { getLaunchpadNftCollection, type LaunchpadNftCollection } from "../../../lib/launchpadNft"
import { feeForGasWanted, networkGasPrice } from "../../../lib/grc20"
import { readGovernanceReceipt } from "../../../lib/dao/governanceRecovery"
import { useSigner } from "../../sign/signerContext"
import type { OsSession } from "../../shell/useOsSession"
import { Loading } from "../../kit"
import { EvidenceComposer, PriorAction } from "./curationActions"
import PublicCurationEvidence from "./evidence"

type Loaded = { collection: LaunchpadNftCollection; application: CurationApplication | null;
    receipt: CurationReceipt; state: CurationState; isManager: boolean }

export default function EmergencyHoldDesk({ rpcUrl, session, toast, onChanged }: {
    rpcUrl: string; session: OsSession; toast: (message: string) => void; onChanged: () => void
}) {
    const signer = useSigner()
    const [input, setInput] = useState("")
    const [selected, setSelected] = useState("")
    const [revision, setRevision] = useState(0)
    const [loaded, setLoaded] = useState<Loaded | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")
    const [evidence, setEvidence] = useState<{ action: EditorialAction; value: VerifiedCurationEvidence } | null>(null)
    const [reviewed, setReviewed] = useState<{ cid: string; sha256: string } | null>(null)
    const [preparing, setPreparing] = useState(false)
    const [now, setNow] = useState(0)
    const token = session.layout?.auth?.token

    useEffect(() => {
        const refresh = () => setNow(Math.floor(Date.now() / 1000))
        refresh()
        const timer = window.setInterval(refresh, 30_000)
        return () => window.clearInterval(timer)
    }, [])

    useEffect(() => {
        if (!selected || session.status !== "member" || !token) return
        let cancelled = false
        void Promise.all([getLaunchpadNftCollection(rpcUrl, selected), getCurationApplication(rpcUrl, selected),
            getCollectionCuration(rpcUrl, selected), getCurationState(rpcUrl),
            readCurationEditorialAccess(selected, session.address, session.network.chainId, token)])
            .then(([collection, application, receipt, state, access]) => {
                if (cancelled) return
                if (collection.id !== selected || receipt.collection !== selected ||
                    (application && (application.collection !== selected || application.founder !== collection.creator)) ||
                    access.creator !== collection.creator || !state.governed) throw new Error("Curation authority changed")
                setLoaded({ collection, application, receipt, state, isManager: access.isManager })
                setLoading(false); setError("")
            }).catch(() => { if (!cancelled) { setLoaded(null); setLoading(false); setError("Could not verify this collection and current manager authority.") } })
        return () => { cancelled = true }
    }, [rpcUrl, selected, revision, session.status, session.address, session.network.chainId, token, signer.version])

    if (session.status !== "member" || !token) return null
    const current = input === selected && loaded?.collection.id === selected ? loaded : null
    const hold = current?.receipt.hold
    const action: EditorialAction | null = !current?.isManager || !now ? null : !hold ? "hide-start" :
        hold.confirmer === "" && hold.actor !== session.address && Number(hold.until) > now ? "hide-confirm" : null
    const scope = action ? editorialScope(session.network.chainId, selected, session.address, action) : null
    const prior = scope ? readGovernanceReceipt(scope) : null
    const needsReason = action === "hide-start"
    const reasonReviewed = action !== "hide-confirm" || (!!hold && reviewed?.cid === hold.reasonCID && reviewed.sha256 === hold.reasonHash)
    return <section className="os-curation-author" aria-labelledby="os-curation-emergency-title">
        <div><h2 id="os-curation-emergency-title">Urgent discovery hold</h2><p className="os-sub">Appointed managers can act on any collection, including one without a founder application. A hold affects discovery for up to 24 hours; it does not block trading, refunds or claims.</p></div>
        <div className="os-curation-lookup"><label htmlFor="os-curation-emergency-collection">Collection ID</label>
            <input id="os-curation-emergency-collection" value={input} onChange={(event) => {
                setInput(event.target.value.trim()); setSelected(""); setLoaded(null); setLoading(false)
                setEvidence(null); setReviewed(null); setError("")
            }} placeholder="C1" />
            <button type="button" className="os-btn os-quiet" disabled={!/^C[1-9][0-9]{0,17}$/.test(input) || loading} onClick={() => {
                setSelected(input); setLoaded(null); setEvidence(null); setReviewed(null); setError(""); setLoading(true); setRevision((value) => value + 1)
            }}>Check collection</button></div>
        {loading && <Loading label="Checking collection and manager authority…" />}
        {error && <p role="alert" className="os-note os-warn">{error}</p>}
        {current && !current.isManager && <p className="os-note">This wallet is not an active, unconflicted manager for this collection.</p>}
        {current?.isManager && !action && <p className="os-note">There is no available manager action for this hold. An existing hold may need DAO clearance, or a second manager may need to confirm it.</p>}
        {current && action && <div className="os-curation-author-body">
            <div className="os-curation-discussion-context"><strong>{current.collection.name}</strong>
                <span>Creator <code>{current.collection.creator}</code></span>
                <span>{current.application ? `Application: ${current.application.status.replaceAll("_", " ")}` : "No founder application"}</span></div>
            {action === "hide-confirm" && hold && <><p className="os-note">The existing hold was started by <code>{hold.actor}</code>. Confirm it only after reviewing its public reason.</p>
                <PublicCurationEvidence key={`${hold.reasonCID}:${hold.reasonHash}`} label="Existing hold reason" cid={hold.reasonCID} sha256={hold.reasonHash}
                    onVerified={(value) => setReviewed(value ? { cid: value.cid, sha256: value.sha256 } : null)} /></>}
            {needsReason && <EvidenceComposer key={`${selected}:${revision}`} collection={selected} account={session.address}
                chainId={session.network.chainId} token={token} label="Public emergency hold reason"
                onPrepared={(value) => setEvidence(value ? { action, value } : null)} />}
            {scope && <PriorAction scope={scope} chainId={session.network.chainId} onClear={() => { setRevision((value) => value + 1); onChanged() }} />}
            <button type="button" className="os-btn" disabled={(needsReason && evidence?.action !== action) || !reasonReviewed || preparing || !!prior} onClick={() => {
                if ((needsReason && evidence?.action !== action) || !reasonReviewed) return
                setPreparing(true)
                void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => signer.sign(editorialRequest({
                    action, application: current.application, collection: current.collection, receipt: current.receipt,
                    state: current.state, caller: session.address, token, evidence: needsReason ? evidence?.value : undefined,
                    rpcUrl, chainId: session.network.chainId,
                    estimatedGasFeeUgnot: feeForGasWanted(CURATION_ACTION_GAS_WANTED, gasPrice),
                    onSettled: () => { setRevision((value) => value + 1); onChanged() },
                }))).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare discovery hold."))
                    .finally(() => setPreparing(false))
            }}>{preparing ? "Preparing wallet review…" : action === "hide-start" ? "Review discovery hold in wallet" : "Review hold confirmation in wallet"}</button>
        </div>}
    </section>
}
