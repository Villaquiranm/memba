import { useEffect, useState } from "react"
import { readActionTerms, type LaunchpadActionTerms } from "../../../lib/launchpadActionTerms"
import { CREATE_COLLECTION_GAS_WANTED, createCollectionScope, createStaticCollectionRequest,
    type StaticCollectionDraft } from "../../../lib/launchpadCollectionCreate"
import { clearGovernanceReceipt, readGovernanceReceipt } from "../../../lib/dao/governanceRecovery"
import { feeForGasWanted, networkGasPrice } from "../../../lib/grc20"
import { txExplorerUrl } from "../../../lib/txExplorerUrl"
import type { NativeViewProps } from "../../native/types"
import { useSigner } from "../../sign/signerContext"
import { ErrorState, Loading } from "../../kit"

export default function CreateLaunchpadCollection({ rpcUrl, session, available, toast }: {
    rpcUrl: string; session: NativeViewProps["session"]; available: boolean; toast: (message: string) => void
}) {
    const signer = useSigner()
    const [terms, setTerms] = useState<LaunchpadActionTerms | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)
    const [revision, setRevision] = useState(0)
    const [preparing, setPreparing] = useState(false)
    const [checkedOutcome, setCheckedOutcome] = useState(false)
    const [, refreshReceipt] = useState(0)
    const [name, setName] = useState("")
    const [symbol, setSymbol] = useState("")
    const [description, setDescription] = useState("")
    const [image, setImage] = useState("")
    const [banner, setBanner] = useState("")
    const [website, setWebsite] = useState("")
    const [mode, setMode] = useState<"open" | "soulbound">("open")
    const [revocable, setRevocable] = useState(false)
    const [supply, setSupply] = useState("")
    const [baseURI, setBaseURI] = useState("")
    useEffect(() => {
        if (!available) return
        let cancelled = false
        void readActionTerms(rpcUrl, "collection", "ugnot").then((value) => {
            if (!cancelled) { setTerms(value); setLoading(false); setError(false) }
        }).catch(() => { if (!cancelled) { setTerms(null); setLoading(false); setError(true) } })
        return () => { cancelled = true }
    }, [available, rpcUrl, revision])
    const refresh = () => { setLoading(true); setRevision((value) => value + 1) }
    if (!available) return <div className="os-note os-warn" role="note">Collection creation awaits the reviewed Launchpad ledger, drops, policy and fees realms on this network.</div>
    if (session.status !== "member") return <div className="os-stack"><p>Connect a wallet to create a Launchpad collection.</p><button type="button" className="os-btn" onClick={session.openConnect}>Connect wallet</button></div>
    const scope = createCollectionScope(session.network.chainId, session.address)
    const receipt = readGovernanceReceipt(scope)
    const draft = (): StaticCollectionDraft => {
        if (!/^(0|[1-9]\d*)$/.test(supply)) throw new Error("Enter a maximum supply, or 0 for an uncapped edition.")
        return { creator: session.address, name, symbol, description, image, banner, website,
            mode, revocable: mode === "soulbound" && revocable, maxSupply: BigInt(supply), baseURI }
    }
    return <section className="os-stack" aria-label="Create Launchpad collection">
        <div><h1>Create a collection</h1><p className="os-sub">Choose permanent ownership and metadata terms, then review the DAO fee before signing. This path uses fixed metadata and a native GNOT fee. It sets no creator royalties; they cannot be added later.</p></div>
        <div className="os-ops-section-head"><h2>Current creation policy</h2><button type="button" className="os-btn os-quiet" onClick={refresh}>Refresh</button></div>
        {loading && <Loading label="Reading creation policy…" />}
        {error && <ErrorState message="Could not verify creation policy from this network." onRetry={refresh} />}
        {!loading && terms && <div className="os-stack os-note">
            <strong>{terms.actionReady ? "Collection creation available" : "Collection creation is paused or unavailable"}</strong>
            <span>DAO creation fee: {terms.collectionFee >= 0n ? `${terms.collectionFee.toLocaleString()} ugnot` : "unavailable"} · Policy version {terms.version.toString()}</span>
            <span>DAO treasury <code>{terms.treasury}</code></span>
        </div>}
        <label>Collection name <input value={name} maxLength={32} onChange={(event) => setName(event.target.value)} placeholder="Civic Art" /></label>
        <label>Symbol <input value={symbol} maxLength={10} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="CIVIC" /></label>
        <label>Description <textarea value={description} maxLength={280} onChange={(event) => setDescription(event.target.value)} /></label>
        <label>Image URI <input value={image} onChange={(event) => setImage(event.target.value.trim())} placeholder="ipfs://…" /></label>
        <label>Banner URI <input value={banner} onChange={(event) => setBanner(event.target.value.trim())} placeholder="ipfs://…" /></label>
        <label>Website <input value={website} onChange={(event) => setWebsite(event.target.value.trim())} placeholder="https://…" /></label>
        <label>Ownership mode <select value={mode} onChange={(event) => { setMode(event.target.value as "open" | "soulbound"); setRevocable(false) }}>
            <option value="open">Open · holders can transfer and trade</option><option value="soulbound">Soulbound · holders cannot transfer or trade</option>
        </select></label>
        {mode === "soulbound" && <label className="os-ack"><input type="checkbox" checked={revocable} onChange={(event) => setRevocable(event.target.checked)} /> The creator may revoke issued tokens, with a recorded reason</label>}
        <label>Maximum supply <input value={supply} inputMode="numeric" onChange={(event) => setSupply(event.target.value.trim())} placeholder="100 (0 for uncapped)" /></label>
        <label>Permanent metadata base URI <input value={baseURI} onChange={(event) => setBaseURI(event.target.value.trim())} placeholder="ipfs://collection/" /></label>
        <p className="os-sub">Each token resolves under this base URI. Its content and accessibility need to be checked before creation; Memba has not independently verified your files.</p>
        {receipt ? <div className="os-stack os-note os-warn" role="status">
            <strong>Previous collection creation needs review</strong>
            <span>Check the transaction and collection list before another attempt.</span>
            {receipt.hash && (txExplorerUrl(receipt.hash, session.network.chainId)
                ? <a href={txExplorerUrl(receipt.hash, session.network.chainId)!} target="_blank" rel="noopener noreferrer">View transaction</a> : <code>{receipt.hash}</code>)}
            <label className="os-ack"><input type="checkbox" checked={checkedOutcome} onChange={(event) => setCheckedOutcome(event.target.checked)} /> I checked the chain and know whether this collection was created.</label>
            <button type="button" className="os-btn os-quiet" disabled={!checkedOutcome} onClick={() => {
                try { clearGovernanceReceipt(scope); setCheckedOutcome(false); refreshReceipt((value) => value + 1); refresh() }
                catch { /* in-flight wallet action remains locked */ }
            }}>Review a new creation</button>
        </div> : <button type="button" className="os-btn" disabled={preparing || loading || !terms?.actionReady} onClick={() => {
            setPreparing(true)
            void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => {
                if (!terms) throw new Error("Refresh the DAO creation policy.")
                const estimatedGasFeeUgnot = feeForGasWanted(CREATE_COLLECTION_GAS_WANTED, gasPrice)
                signer.sign(createStaticCollectionRequest({ draft: draft(), terms, rpcUrl, chainId: session.network.chainId,
                    estimatedGasFeeUgnot, onSettled: refresh }))
            }).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare collection creation."))
                .finally(() => setPreparing(false))
        }}>{preparing ? "Preparing review…" : "Review collection creation"}</button>}
    </section>
}
