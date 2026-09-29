import { useEffect, useRef, useState } from "react"
import type { Token } from "../../../gen/memba/v1/memba_pb"
import { clearGovernanceReceipt, readGovernanceReceipt } from "../../../lib/dao/governanceRecovery"
import { feeForGasWanted, networkGasPrice } from "../../../lib/grc20"
import { getCurationApplication, getCurationState, type CurationApplication, type CurationReceipt, type CurationState } from "../../../lib/launchpadCuration"
import { readCurationAccess } from "../../../lib/launchpadCurationInbox"
import { uploadCurationEvidence, type VerifiedCurationEvidence } from "../../../lib/launchpadCurationEvidence"
import { CURATION_ACTION_GAS_WANTED, curationActionScope, curationApplyRequest, curationReviewRequest, type CurationDecision } from "../../../lib/launchpadCurationActions"
import { editorialRequest, editorialScope, type EditorialAction } from "../../../lib/launchpadCurationEditorial"
import { getLaunchpadNftCollection, type LaunchpadNftCollection } from "../../../lib/launchpadNft"
import { txExplorerUrl } from "../../../lib/txExplorerUrl"
import { useSigner } from "../../sign/signerContext"
import type { OsSession } from "../../shell/useOsSession"
import { Loading } from "../../kit"

export function EvidenceComposer({ collection, account, chainId, token, label, onPrepared }: {
    collection: string; account: string; chainId: string; token: Token; label: string;
    onPrepared: (value: VerifiedCurationEvidence | null) => void
}) {
    const [text, setText] = useState("")
    const [publicAck, setPublicAck] = useState(false)
    const [uploading, setUploading] = useState(false)
    const [prepared, setPrepared] = useState<VerifiedCurationEvidence | null>(null)
    const [error, setError] = useState("")
    const generation = useRef(0)
    const pending = useRef<AbortController | null>(null)
    useEffect(() => () => { generation.current++; pending.current?.abort() }, [])
    const bytes = new TextEncoder().encode(text).length
    return <div className="os-curation-author-evidence">
        <label htmlFor={`${label}-${collection}`}>{label}</label>
        <textarea id={`${label}-${collection}`} rows={6} value={text} maxLength={16 * 1024}
            onChange={(event) => { generation.current++; pending.current?.abort(); setUploading(false); setText(event.target.value); setPrepared(null); onPrepared(null); setError("") }}
            placeholder="Describe the public facts, links and evidence the community should examine." />
        <span className={bytes > 16 * 1024 ? "os-warn" : "os-sub"}>{bytes.toLocaleString()} / 16,384 UTF-8 bytes</span>
        <label className="os-ack"><input type="checkbox" checked={publicAck} onChange={(event) => setPublicAck(event.target.checked)} /> Pinning publishes this text even if I later cancel the wallet action. I removed private or personal details.</label>
        <button type="button" className="os-btn os-quiet" disabled={uploading || !publicAck || !text.trim() || bytes > 16 * 1024} onClick={() => {
            const attempt = ++generation.current
            const controller = new AbortController()
            pending.current = controller
            setUploading(true); setError(""); setPrepared(null); onPrepared(null)
            void uploadCurationEvidence(collection, account, chainId, token, text, controller.signal).then((value) => {
                if (attempt === generation.current) { setPrepared(value); onPrepared(value) }
            }).catch((cause) => { if (attempt === generation.current) setError(cause instanceof Error ? cause.message : "Could not verify public evidence.") })
                .finally(() => { if (attempt === generation.current) { setUploading(false); pending.current = null } })
        }}>{uploading ? "Pinning and verifying…" : "Pin and verify public text"}</button>
        {error && <p role="alert" className="os-note os-warn">{error}</p>}
        {prepared && <div className="os-note os-curation-prepared" role="status"><strong>Public text verified</strong><span>IPFS <code>{prepared.cid}</code></span><span>SHA-256 <code>{prepared.sha256}</code></span></div>}
    </div>
}

function PriorAction({ scope, chainId, onClear }: { scope: ReturnType<typeof curationActionScope>; chainId: string; onClear: () => void }) {
    const receipt = readGovernanceReceipt(scope)
    const [checked, setChecked] = useState(false)
    if (!receipt) return null
    const link = receipt.hash ? txExplorerUrl(receipt.hash, chainId) : null
    return <div className="os-note os-warn os-stack" role="status">
        <strong>Previous curation action needs review</strong>
        <span>Check the transaction and current application before another wallet request.</span>
        {link && <a href={link} target="_blank" rel="noopener noreferrer">View transaction</a>}
        <label className="os-ack"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} /> I checked the chain and know whether this action took effect.</label>
        <button type="button" className="os-btn os-quiet" disabled={!checked} onClick={() => {
            try { clearGovernanceReceipt(scope); setChecked(false); onClear() } catch { /* in-flight action remains locked */ }
        }}>Review another action</button>
    </div>
}

export function FounderApplicationDesk({ rpcUrl, session, onChanged, toast }: {
    rpcUrl: string; session: OsSession; onChanged: () => void; toast: (message: string) => void
}) {
    const signer = useSigner()
    const [collectionID, setCollectionID] = useState("")
    const [selected, setSelected] = useState("")
    const [revision, setRevision] = useState(0)
    const [loaded, setLoaded] = useState<{ collection: LaunchpadNftCollection; application: CurationApplication | null; state: CurationState } | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")
    const [evidence, setEvidence] = useState<VerifiedCurationEvidence | null>(null)
    const [preparing, setPreparing] = useState(false)

    useEffect(() => {
        if (!selected) return
        let cancelled = false
        void Promise.all([getLaunchpadNftCollection(rpcUrl, selected), getCurationApplication(rpcUrl, selected), getCurationState(rpcUrl)])
            .then(([collection, application, state]) => { if (!cancelled) { setLoaded({ collection, application, state }); setLoading(false); setError("") } })
            .catch(() => { if (!cancelled) { setLoaded(null); setLoading(false); setError("Could not verify this collection and application.") } })
        return () => { cancelled = true }
    }, [rpcUrl, selected, revision, signer.version])

    if (session.status !== "member" || !session.layout.auth.token) return null
    const current = selected === collectionID ? loaded : null
    const eligible = current?.state.governed && current.collection.creator === session.address &&
        (!current.application || current.application.status === "changes_requested" || current.application.status === "declined")
    const scope = selected ? curationActionScope(session.network.chainId, selected, session.address, "apply") : null
    const receipt = scope ? readGovernanceReceipt(scope) : null
    return <section className="os-curation-author" aria-labelledby="os-curation-apply-title">
        <div><h2 id="os-curation-apply-title">Bring a collection to review</h2><p className="os-sub">The creator submits public evidence first. The appointed review team can then discuss details privately and publish a decision.</p></div>
        <div className="os-curation-lookup"><label htmlFor="os-curation-collection">Collection ID</label><input id="os-curation-collection" value={collectionID} onChange={(event) => { setCollectionID(event.target.value.trim()); setEvidence(null) }} placeholder="C1" />
            <button type="button" className="os-btn os-quiet" disabled={!/^C[1-9][0-9]{0,17}$/.test(collectionID) || loading} onClick={() => {
                setSelected(collectionID); setLoaded(null); setError(""); setEvidence(null); setLoading(true); setRevision((value) => value + 1)
            }}>Check collection</button></div>
        {loading && <Loading label="Checking creator and application…" />}
        {error && <p role="alert" className="os-note os-warn">{error}</p>}
        {current && <div className="os-curation-author-body">
            <div className="os-curation-discussion-context"><strong>{current.collection.name}</strong><span>Creator <code>{current.collection.creator}</code></span><span>{current.application ? `Application: ${current.application.status.replaceAll("_", " ")}` : "No application yet"}</span></div>
            {!current.state.governed && <p className="os-note os-warn">The curation team has not completed its DAO handoff.</p>}
            {current.collection.creator !== session.address && <p className="os-note os-warn">Connect the wallet that created this collection to apply.</p>}
            {current.application && !eligible && current.collection.creator === session.address && <p className="os-note">This application is already under review or recommended. Use its founder discussion to follow up.</p>}
            {eligible && <>
                <EvidenceComposer key={`${selected}:${current.application?.revision ?? "0"}`} collection={selected} account={session.address} chainId={session.network.chainId} token={session.layout.auth.token} label="Public application evidence" onPrepared={setEvidence} />
                {scope && <PriorAction scope={scope} chainId={session.network.chainId} onClear={() => { setRevision((value) => value + 1); onChanged() }} />}
                <button type="button" className="os-btn" disabled={!evidence || preparing || !!receipt} onClick={() => {
                    if (!evidence) return
                    setPreparing(true)
                    void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => signer.sign(curationApplyRequest({
                        collection: current.collection, prior: current.application, state: current.state,
                        caller: session.address, evidence, rpcUrl, chainId: session.network.chainId,
                        estimatedGasFeeUgnot: feeForGasWanted(CURATION_ACTION_GAS_WANTED, gasPrice),
                        onSettled: () => { setRevision((value) => value + 1); onChanged() },
                    }))).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare application review."))
                        .finally(() => setPreparing(false))
                }}>{preparing ? "Preparing wallet review…" : "Review application in wallet"}</button>
            </>}
        </div>}
    </section>
}

export function ManagerReviewDesk({ application, rpcUrl, session, onChanged, toast }: {
    application: CurationApplication; rpcUrl: string; session: OsSession; onChanged: () => void; toast: (message: string) => void
}) {
    const signer = useSigner()
    const [allowed, setAllowed] = useState(false)
    const [checked, setChecked] = useState(false)
    const [collection, setCollection] = useState<LaunchpadNftCollection | null>(null)
    const [state, setState] = useState<CurationState | null>(null)
    const [decision, setDecision] = useState<CurationDecision>("changes_requested")
    const [evidence, setEvidence] = useState<VerifiedCurationEvidence | null>(null)
    const [preparing, setPreparing] = useState(false)
    const [revision, setRevision] = useState(0)
    const token = session.layout.auth.token

    useEffect(() => {
        if (session.status !== "member" || !token) return
        let cancelled = false
        void Promise.all([readCurationAccess(application.collection, session.address, session.network.chainId, token),
            getLaunchpadNftCollection(rpcUrl, application.collection), getCurationState(rpcUrl)]).then(([access, nft, team]) => {
            if (!cancelled) { setAllowed(access.canReview && access.revision === application.revision && team.governed); setCollection(nft); setState(team); setChecked(true) }
        }).catch(() => { if (!cancelled) { setAllowed(false); setCollection(null); setState(null); setChecked(true) } })
        return () => { cancelled = true }
    }, [application.collection, application.revision, rpcUrl, session.address, session.network.chainId, session.status, token, revision, signer.version])

    if (session.status !== "member" || !token || !checked || !allowed || !collection || !state || collection.creator !== application.founder) return null
    const scope = curationActionScope(session.network.chainId, application.collection, session.address, "review")
    const receipt = readGovernanceReceipt(scope)
    return <div className="os-curation-author os-curation-review">
        <div><h3>Manager decision</h3><p className="os-sub">Read the verified application evidence and private founder discussion before publishing a public reason.</p></div>
        <label htmlFor={`curation-decision-${application.collection}`}>Decision</label>
        <select id={`curation-decision-${application.collection}`} value={decision} onChange={(event) => { setDecision(event.target.value as CurationDecision); setEvidence(null) }}>
            <option value="changes_requested">Request changes</option><option value="recommended">Recommend for DAO consideration</option><option value="declined">Decline</option>
        </select>
        <EvidenceComposer key={`${application.collection}:${decision}:${application.revision}`} collection={application.collection} account={session.address} chainId={session.network.chainId} token={token} label="Public review reason" onPrepared={setEvidence} />
        <PriorAction scope={scope} chainId={session.network.chainId} onClear={() => { setRevision((value) => value + 1); onChanged() }} />
        <button type="button" className="os-btn" disabled={!evidence || preparing || !!receipt} onClick={() => {
            if (!evidence) return
            setPreparing(true)
            void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => signer.sign(curationReviewRequest({
                application, collection, state, caller: session.address, token, status: decision, evidence, rpcUrl,
                chainId: session.network.chainId, estimatedGasFeeUgnot: feeForGasWanted(CURATION_ACTION_GAS_WANTED, gasPrice),
                onSettled: () => { setRevision((value) => value + 1); onChanged() },
            }))).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare manager review."))
                .finally(() => setPreparing(false))
        }}>{preparing ? "Preparing wallet review…" : "Review decision in wallet"}</button>
    </div>
}

export function ManagerEditorialDesk({ application, receipt, rpcUrl, session, onChanged, toast }: {
    application: CurationApplication; receipt: CurationReceipt; rpcUrl: string; session: OsSession;
    onChanged: () => void; toast: (message: string) => void
}) {
    const signer = useSigner()
    const [eligible, setEligible] = useState(false)
    const [checked, setChecked] = useState(false)
    const [collection, setCollection] = useState<LaunchpadNftCollection | null>(null)
    const [state, setState] = useState<CurationState | null>(null)
    const [action, setAction] = useState<EditorialAction>("feature-propose")
    const [days, setDays] = useState(7)
    const [evidence, setEvidence] = useState<{ action: EditorialAction; value: VerifiedCurationEvidence } | null>(null)
    const [preparing, setPreparing] = useState(false)
    const [revision, setRevision] = useState(0)
    const [now, setNow] = useState(0)
    const token = session.layout.auth.token

    useEffect(() => {
        const refresh = () => setNow(Math.floor(Date.now() / 1000))
        refresh()
        const timer = window.setInterval(refresh, 30_000)
        return () => window.clearInterval(timer)
    }, [])

    useEffect(() => {
        if (session.status !== "member" || !token) return
        let cancelled = false
        void Promise.all([readCurationAccess(application.collection, session.address, session.network.chainId, token),
            getLaunchpadNftCollection(rpcUrl, application.collection), getCurationState(rpcUrl)]).then(([access, nft, team]) => {
            if (!cancelled) { setEligible(access.isManager && access.revision === application.revision && team.governed);
                setCollection(nft); setState(team); setChecked(true) }
        }).catch(() => { if (!cancelled) { setEligible(false); setCollection(null); setState(null); setChecked(true) } })
        return () => { cancelled = true }
    }, [application.collection, application.revision, rpcUrl, session.address, session.network.chainId, session.status, token, revision, signer.version])

    if (session.status !== "member" || !token || !checked || !eligible || !collection || !state || !now ||
        collection.creator !== application.founder || receipt.collection !== application.collection) return null
    const options: { value: EditorialAction; label: string }[] = []
    if (!receipt.feature || Number(receipt.feature.until) <= now) options.push({ value: "feature-propose", label: "Propose feature slot" })
    if (receipt.feature && receipt.feature.approver === "" && receipt.feature.proposer !== session.address && Number(receipt.feature.until) > now)
        options.push({ value: "feature-approve", label: "Approve feature slot" })
    if (!receipt.hold) options.push({ value: "hide-start", label: "Start 24-hour discovery hold" })
    if (receipt.hold && receipt.hold.confirmer === "" && receipt.hold.actor !== session.address && Number(receipt.hold.until) > now)
        options.push({ value: "hide-confirm", label: "Confirm discovery hold" })
    const selected = options.some((option) => option.value === action) ? action : options[0]?.value
    if (!selected) return null
    const needsReason = selected === "feature-propose" || selected === "hide-start"
    const scope = editorialScope(session.network.chainId, application.collection, session.address, selected)
    const prior = readGovernanceReceipt(scope)
    return <div className="os-curation-author os-curation-review">
        <div><h3>Editorial controls</h3><p className="os-sub">Feature slots and discovery holds need a public reason. A second unconflicted manager confirms each decision. Holds affect discovery only; trading and claims remain available.</p></div>
        <label htmlFor={`curation-editorial-${application.collection}`}>Action</label>
        <select id={`curation-editorial-${application.collection}`} value={selected} onChange={(event) => { setAction(event.target.value as EditorialAction); setEvidence(null) }}>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {selected === "feature-propose" && <><label htmlFor={`curation-feature-days-${application.collection}`}>Feature duration</label>
            <select id={`curation-feature-days-${application.collection}`} value={days} onChange={(event) => setDays(Number(event.target.value))}>
                <option value={1}>1 day</option><option value={3}>3 days</option><option value={7}>7 days</option><option value={13}>13 days</option>
            </select></>}
        {needsReason && <EvidenceComposer key={`${application.collection}:${selected}`} collection={application.collection}
            account={session.address} chainId={session.network.chainId} token={token} label="Public editorial reason"
            onPrepared={(value) => setEvidence(value ? { action: selected, value } : null)} />}
        {!needsReason && <p className="os-note">Review the existing public reason and current receipt above before confirming this action.</p>}
        <PriorAction scope={scope} chainId={session.network.chainId} onClear={() => { setRevision((value) => value + 1); onChanged() }} />
        <button type="button" className="os-btn" disabled={(needsReason && evidence?.action !== selected) || preparing || !!prior} onClick={() => {
            if (needsReason && evidence?.action !== selected) return
            const until = selected === "feature-propose" ? String(Math.floor(Date.now() / 1000) + days * 86400) : undefined
            setPreparing(true)
            void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => signer.sign(editorialRequest({
                action: selected, application, collection, receipt, state, caller: session.address, token,
                evidence: needsReason ? evidence?.value : undefined, until, rpcUrl, chainId: session.network.chainId,
                estimatedGasFeeUgnot: feeForGasWanted(CURATION_ACTION_GAS_WANTED, gasPrice),
                onSettled: () => { setRevision((value) => value + 1); onChanged() },
            }))).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare editorial action."))
                .finally(() => setPreparing(false))
        }}>{preparing ? "Preparing wallet review…" : "Review editorial action in wallet"}</button>
    </div>
}
