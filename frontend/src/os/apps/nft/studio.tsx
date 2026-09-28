import { useEffect, useState } from "react"
import { readActionTerms, type LaunchpadActionTerms } from "../../../lib/launchpadActionTerms"
import { addFixedDropStageRequest, addFixedDropStageScope, editFixedStageRequest, editFixedStageScope,
    parseFreeOrGnotPrice, readFixedDropStages,
    ADD_FIXED_STAGE_GAS_WANTED, type FixedDropStage } from "../../../lib/launchpadDropStages"
import { formatGnotPrice } from "../../../lib/launchpadListing"
import { getLaunchpadNftCollection, type LaunchpadNftCollection } from "../../../lib/launchpadNft"
import { clearGovernanceReceipt, readGovernanceReceipt } from "../../../lib/dao/governanceRecovery"
import { feeForGasWanted, networkGasPrice } from "../../../lib/grc20"
import { txExplorerUrl } from "../../../lib/txExplorerUrl"
import type { NativeViewProps } from "../../native/types"
import { useSigner } from "../../sign/signerContext"
import { ErrorState, Loading } from "../../kit"
import RevealCollectionPanel from "./reveal"

interface StudioState { collection: LaunchpadNftCollection; stages: FixedDropStage[]; terms: LaunchpadActionTerms }

function utc(seconds: bigint): string {
    const date = new Date(Number(seconds) * 1000)
    return Number.isFinite(date.valueOf()) ? date.toISOString() : `${seconds.toString()} Unix seconds`
}

function localSeconds(text: string): bigint {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(text)) throw new Error("Choose a local start and end time.")
    const date = new Date(text)
    const timestamp = date.getTime()
    const pad = (value: number) => String(value).padStart(2, "0")
    const normalized = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
    if (!Number.isFinite(timestamp) || normalized !== text) throw new Error("Choose a valid local time outside daylight-saving gaps.")
    return BigInt(Math.floor(timestamp / 1000))
}

function whole(text: string, label: string): bigint {
    if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error(`Enter a whole-number ${label}.`)
    return BigInt(text)
}

function localInput(seconds: bigint): string {
    const date = new Date(Number(seconds) * 1000)
    if (!Number.isFinite(date.valueOf())) return ""
    const pad = (value: number) => String(value).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function LaunchpadCreatorStudio({ rpcUrl, session, available, toast }: {
    rpcUrl: string; session: NativeViewProps["session"]; available: boolean; toast: (message: string) => void
}) {
    const signer = useSigner()
    const [collectionID, setCollectionID] = useState("")
    const [selected, setSelected] = useState("")
    const [revision, setRevision] = useState(0)
    const [loaded, setLoaded] = useState<StudioState | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(false)
    const [preparing, setPreparing] = useState(false)
    const [checkedOutcome, setCheckedOutcome] = useState(false)
    const [, refreshReceipt] = useState(0)
    const [start, setStart] = useState("")
    const [end, setEnd] = useState("")
    const [price, setPrice] = useState("")
    const [supplyCap, setSupplyCap] = useState("")
    const [perWallet, setPerWallet] = useState("")
    const [editingIndex, setEditingIndex] = useState<number | null>(null)
    const [editingAllowed, setEditingAllowed] = useState(false)
    useEffect(() => {
        if (!available || !/^C[1-9]\d*$/.test(selected)) return
        let cancelled = false
        void Promise.all([getLaunchpadNftCollection(rpcUrl, selected), readFixedDropStages(rpcUrl, selected),
            readActionTerms(rpcUrl, "drops", "ugnot")]).then(([collection, stages, terms]) => {
            if (!cancelled) { setLoaded({ collection, stages, terms }); setLoading(false); setError(false) }
        }).catch(() => { if (!cancelled) { setLoaded(null); setLoading(false); setError(true) } })
        return () => { cancelled = true }
    }, [available, rpcUrl, selected, revision])
    const refresh = () => { setLoading(true); setRevision((value) => value + 1) }
    if (!available) return <div className="os-note os-warn" role="note">Creator Studio awaits the reviewed NFT, drops, policy and fees realms on this network.</div>
    if (session.status !== "member") return <div className="os-stack"><p>Connect a wallet to manage your Launchpad drops.</p><button type="button" className="os-btn" onClick={session.openConnect}>Connect wallet</button></div>
    const current = selected === collectionID && loaded?.collection.id === selected ? loaded : null
    const isCreator = current?.collection.creator === session.address
    const draft = () => ({ collection: selected, creator: session.address, start: localSeconds(start), end: localSeconds(end),
        price: price === "0" ? 0n : parseFreeOrGnotPrice(price), supplyCap: whole(supplyCap, "stage supply cap"),
        perWallet: whole(perWallet, "per-wallet limit") })
    const emptyDraft = { collection: selected, creator: session.address, start: 0n, end: 0n, price: 0n, supplyCap: 0n, perWallet: 1n }
    const scope = editingIndex === null ? addFixedDropStageScope(session.network.chainId, emptyDraft) :
        editFixedStageScope(session.network.chainId, emptyDraft, editingIndex)
    const receipt = current && isCreator ? readGovernanceReceipt(scope) : null
    return <section className="os-stack" aria-label="Launchpad Creator Studio">
        <div><h1>Creator Studio</h1><p className="os-sub">Schedule a fixed-price primary drop for a collection you created. Dates are entered in your local time and reviewed in UTC before signing.</p></div>
        <label>Collection ID <input value={collectionID} onChange={(event) => setCollectionID(event.target.value.trim())} placeholder="C1" /></label>
        <button type="button" className="os-btn os-quiet" disabled={!/^C[1-9]\d*$/.test(collectionID) || loading} onClick={() => {
            setLoaded(null); setError(false); setLoading(true); setEditingIndex(null); setEditingAllowed(false);
            setSelected(collectionID); setRevision((value) => value + 1)
        }}>Load collection and stages</button>
        {loading && <Loading label="Reading collection and drop policy…" />}
        {error && <ErrorState message="Could not verify this collection, its stages or drop policy." onRetry={refresh} />}
        {current && <div className="os-stack os-note">
            <strong>{current.collection.name} · {current.collection.id}</strong>
            <span>Creator <code>{current.collection.creator}</code></span>
            <span>{current.collection.mode === "soulbound" ? "Soulbound · recipients claim their own tokens" : "Open · minted tokens may transfer"} · {current.collection.minted.toString()} minted</span>
            <span>{current.collection.maxSupply === 0n ? "Uncapped collection" : `${(current.collection.maxSupply - current.collection.minted).toString()} mints remain in the collection`}</span>
            <span>DAO primary fee {current.terms.primaryFeeBPS.toString()} bps · treasury <code>{current.terms.treasury}</code></span>
            <span>{current.terms.actionReady ? "Native primary drops available" : "Native primary drops paused or unavailable"}</span>
        </div>}
        {current && <div className="os-stack"><h2>Scheduled stages</h2>
            {current.stages.length === 0 && <p className="os-sub">No fixed-price stages yet.</p>}
            {current.stages.map((stage) => <div className="os-note os-stack" key={stage.index}>
                <strong>Stage {stage.index + 1} · {stage.currency === "ugnot" ? stage.price === 0n ? "Free" : formatGnotPrice(stage.price) : `${stage.price.toString()} ${stage.currency}`}</strong>
                <span>{utc(stage.start)} → {utc(stage.end)}</span>
                <span>{stage.minted.toString()} minted · {stage.supplyCap === 0n ? "collection supply cap" : `${stage.supplyCap.toString()} stage cap`} · {stage.perWallet.toString()} per wallet</span>
                {isCreator && stage.currency === "ugnot" &&
                    <button type="button" className="os-btn os-quiet" onClick={() => {
                        setEditingAllowed(stage.start > BigInt(Math.floor(Date.now() / 1000)) && stage.minted === 0n)
                        setEditingIndex(stage.index); setStart(localInput(stage.start)); setEnd(localInput(stage.end))
                        setPrice(formatGnotPrice(stage.price).replaceAll(",", "").replace(" GNOT", ""))
                        setSupplyCap(stage.supplyCap.toString()); setPerWallet(stage.perWallet.toString())
                        setCheckedOutcome(false)
                    }}>Review or edit stage {stage.index + 1}</button>}
            </div>)}
        </div>}
        {current && !isCreator && <p className="os-note os-warn" role="note">This wallet is not the on-chain creator. Connect the creator wallet to schedule stages.</p>}
        {current && isCreator && <RevealCollectionPanel collection={current.collection} creator={session.address}
            rpcUrl={rpcUrl} chainId={session.network.chainId} toast={toast} refresh={refresh} />}
        {current && isCreator && <div className="os-stack"><h2>{editingIndex === null ? "Schedule a fixed-price stage" : `Edit scheduled stage ${editingIndex + 1}`}</h2>
            <p className="os-sub">Up to ten stages can be scheduled. Windows cannot overlap. A stage can be edited only before it begins.</p>
            {editingIndex !== null && !editingAllowed && <p className="os-note os-warn" role="note">This stage has started or minted. Its terms can no longer be edited; a pending edit can still be reviewed below.</p>}
            {editingIndex !== null && <button type="button" className="os-btn os-quiet" onClick={() => {
                setEditingIndex(null); setEditingAllowed(false); setStart(""); setEnd(""); setPrice(""); setSupplyCap(""); setPerWallet(""); setCheckedOutcome(false)
            }}>Add a new stage instead</button>}
            <label>Start · local time <input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label>
            <label>End · local time <input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
            <label>Mint price in GNOT <input value={price} inputMode="decimal" onChange={(event) => setPrice(event.target.value.trim())} placeholder="0 for free; 1.25 for paid" /></label>
            <label>Stage supply cap <input value={supplyCap} inputMode="numeric" onChange={(event) => setSupplyCap(event.target.value.trim())} placeholder="0 uses collection cap" /></label>
            <label>Per-wallet limit <input value={perWallet} inputMode="numeric" onChange={(event) => setPerWallet(event.target.value.trim())} placeholder="1" /></label>
            {receipt ? <div className="os-stack os-note os-warn" role="status"><strong>Previous stage action needs review</strong>
                <span>Check the transaction and stage list before another attempt.</span>
                {receipt.hash && (txExplorerUrl(receipt.hash, session.network.chainId) ?
                    <a href={txExplorerUrl(receipt.hash, session.network.chainId)!} target="_blank" rel="noopener noreferrer">View transaction</a> : <code>{receipt.hash}</code>)}
                <label className="os-ack"><input type="checkbox" checked={checkedOutcome} onChange={(event) => setCheckedOutcome(event.target.checked)} /> I checked the chain and know whether this stage was added.</label>
                <button type="button" className="os-btn os-quiet" disabled={!checkedOutcome} onClick={() => {
                    try { clearGovernanceReceipt(scope); setCheckedOutcome(false); refreshReceipt((value) => value + 1); refresh() }
                    catch { /* in-flight wallet action remains locked */ }
                }}>Review another stage action</button>
            </div> : <button type="button" className="os-btn" disabled={preparing || loading || !current.terms.actionReady ||
                (editingIndex !== null && !editingAllowed) ||
                (editingIndex === null && current.stages.length >= 10)} onClick={() => {
                setPreparing(true)
                void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => {
                    const common = { draft: draft(), terms: current.terms, collection: current.collection, stages: current.stages,
                        rpcUrl, chainId: session.network.chainId,
                        estimatedGasFeeUgnot: feeForGasWanted(ADD_FIXED_STAGE_GAS_WANTED, gasPrice), onSettled: refresh }
                    signer.sign(editingIndex === null ? addFixedDropStageRequest(common) :
                        editFixedStageRequest({ ...common, index: editingIndex }))
                }).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare drop stage."))
                    .finally(() => setPreparing(false))
            }}>{preparing ? "Preparing review…" : editingIndex === null ? "Review fixed-price stage" : "Review stage changes"}</button>}
        </div>}
    </section>
}
