import { useEffect, useState } from "react"
import { readActionTerms, type LaunchpadActionTerms } from "../../../lib/launchpadActionTerms"
import { CREATE_COLLECTION_GAS_WANTED, createCollectionScope } from "../../../lib/launchpadCollectionCreate"
import { createCollectionVariantRequest, type CollectionCreationDraft } from "../../../lib/launchpadCollectionVariants"
import { baseURICommitment, provenanceManifestCommitment } from "../../../lib/launchpadCommitments"
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
    const [metadataMode, setMetadataMode] = useState<"static" | "reveal">("static")
    const [baseURI, setBaseURI] = useState("")
    const [placeholderURI, setPlaceholderURI] = useState("")
    const [futureBaseURI, setFutureBaseURI] = useState("")
    const [baseHash, setBaseHash] = useState("")
    const [provenanceHash, setProvenanceHash] = useState("")
    const [manifestName, setManifestName] = useState("")
    const [hashingBase, setHashingBase] = useState(false)
    const [hashingManifest, setHashingManifest] = useState(false)
    const [royaltyRows, setRoyaltyRows] = useState<Array<{ account: string; bps: string }>>([])
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
    const draft = (): CollectionCreationDraft => {
        if (!/^(0|[1-9]\d*)$/.test(supply)) throw new Error("Enter a maximum supply, or 0 for an uncapped edition.")
        const royalties = royaltyRows.map((row) => {
            if (!/^[1-9]\d*$/.test(row.bps)) throw new Error("Enter a positive whole-number basis-point share for every royalty receiver.")
            return { account: row.account, bps: BigInt(row.bps) }
        })
        const core = { creator: session.address, name, symbol, description, image, banner, website,
            mode, revocable: mode === "soulbound" && revocable, maxSupply: BigInt(supply), royalties }
        return metadataMode === "static" ? { ...core, metadataMode, baseURI } :
            { ...core, metadataMode, placeholderURI, committedBaseURIHash: baseHash, provenanceHash }
    }
    return <section className="os-stack" aria-label="Create Launchpad collection">
        <div><h1>Create a collection</h1><p className="os-sub">Choose permanent ownership, metadata and royalty terms, then review the DAO fee before signing. The fee is paid in native GNOT.</p></div>
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
        <label>Ownership mode <select value={mode} onChange={(event) => { setMode(event.target.value as "open" | "soulbound"); setRevocable(false); setRoyaltyRows([]) }}>
            <option value="open">Open · holders can transfer and trade</option><option value="soulbound">Soulbound · holders cannot transfer or trade</option>
        </select></label>
        {mode === "soulbound" && <label className="os-ack"><input type="checkbox" checked={revocable} onChange={(event) => setRevocable(event.target.checked)} /> The creator may revoke issued tokens, with a recorded reason</label>}
        <label>Maximum supply <input value={supply} inputMode="numeric" onChange={(event) => setSupply(event.target.value.trim())} placeholder="100 (0 for uncapped)" /></label>
        <label>Metadata plan <select value={metadataMode} onChange={(event) => setMetadataMode(event.target.value as "static" | "reveal")}>
            <option value="static">Static · metadata frozen at creation</option>
            <option value="reveal">Reveal later · commit URI and provenance now</option>
        </select></label>
        {metadataMode === "static" ? <label>Permanent metadata base URI <input value={baseURI} onChange={(event) => setBaseURI(event.target.value.trim())} placeholder="ipfs://collection/" /></label> : <div className="os-stack os-note">
            <label>Placeholder JSON URI <input value={placeholderURI} onChange={(event) => setPlaceholderURI(event.target.value.trim())} placeholder="ipfs://collection/placeholder.json" /></label>
            <label>Future base URI · hashed locally, not sent on-chain <input value={futureBaseURI} disabled={hashingBase} onChange={(event) => { setFutureBaseURI(event.target.value.trim()); setBaseHash("") }} placeholder="ipfs://collection/" /></label>
            <button type="button" className="os-btn os-quiet" disabled={hashingBase || !futureBaseURI} onClick={() => {
                setHashingBase(true)
                void baseURICommitment(futureBaseURI).then(setBaseHash)
                    .catch((cause) => toast(cause instanceof Error ? cause.message : "Could not hash the future base URI."))
                    .finally(() => setHashingBase(false))
            }}>{hashingBase ? "Computing SHA-256…" : "Compute base URI commitment"}</button>
            <label>Base URI SHA-256 commitment <input value={baseHash} readOnly={futureBaseURI !== ""}
                onChange={(event) => setBaseHash(event.target.value.trim())} placeholder="64 lowercase hex characters" /></label>
            <label>Provenance manifest file · hashed locally <input type="file" disabled={hashingManifest} onChange={(event) => {
                const file = event.target.files?.[0]
                setManifestName(file?.name ?? ""); setProvenanceHash("")
                if (!file) return
                setHashingManifest(true)
                void provenanceManifestCommitment(file).then(setProvenanceHash)
                    .catch((cause) => { setManifestName(""); toast(cause instanceof Error ? cause.message : "Could not hash the provenance manifest.") })
                    .finally(() => setHashingManifest(false))
            }} /></label>
            {manifestName && <span className="os-sub">Local manifest: {manifestName}</span>}
            <label>Provenance manifest SHA-256 <input value={provenanceHash} readOnly={manifestName !== ""}
                onChange={(event) => setProvenanceHash(event.target.value.trim())} placeholder="64 lowercase hex characters" /></label>
            <p className="os-sub">Keep the exact future base URI and manifest. The realm checks the base URI hash at reveal; it cannot prove the files or manifest are correct.</p>
        </div>}
        <p className="os-sub">Check the metadata files and their availability before creation. Memba has not independently verified their content or provenance.</p>
        {mode === "open" && <fieldset className="os-stack os-note"><legend>Creator royalties · optional and permanent</legend>
            <p className="os-sub">Up to ten receivers, with a total of at most 1,000 basis points (10%). The native marketplace pays these shares on its settlements; off-market transfers may not.</p>
            {royaltyRows.map((row, index) => <div className="os-stack os-tight" key={index}>
                <label>Royalty receiver {index + 1} <input value={row.account} onChange={(event) => setRoyaltyRows((previous) =>
                    previous.map((value, position) => position === index ? { ...value, account: event.target.value.trim() } : value))} placeholder="g1…" /></label>
                <label>Receiver {index + 1} basis points <input value={row.bps} inputMode="numeric" onChange={(event) => setRoyaltyRows((previous) =>
                    previous.map((value, position) => position === index ? { ...value, bps: event.target.value.trim() } : value))} placeholder="500 = 5%" /></label>
                <button type="button" className="os-btn os-quiet" onClick={() => setRoyaltyRows((previous) => previous.filter((_, position) => position !== index))}>Remove receiver {index + 1}</button>
            </div>)}
            <button type="button" className="os-btn os-quiet" disabled={royaltyRows.length >= 10} onClick={() => setRoyaltyRows((previous) => [...previous, { account: "", bps: "" }])}>Add royalty receiver</button>
            <span>{royaltyRows.reduce((sum, row) => sum + (/^(0|[1-9]\d*)$/.test(row.bps) ? BigInt(row.bps) : 0n), 0n).toString()} of 1,000 basis points assigned</span>
        </fieldset>}
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
        </div> : <button type="button" className="os-btn" disabled={preparing || hashingBase || hashingManifest || loading || !terms?.actionReady} onClick={() => {
            setPreparing(true)
            void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => {
                if (!terms) throw new Error("Refresh the DAO creation policy.")
                const estimatedGasFeeUgnot = feeForGasWanted(CREATE_COLLECTION_GAS_WANTED, gasPrice)
                signer.sign(createCollectionVariantRequest({ draft: draft(), terms, rpcUrl, chainId: session.network.chainId,
                    estimatedGasFeeUgnot, onSettled: refresh }))
            }).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare collection creation."))
                .finally(() => setPreparing(false))
        }}>{preparing ? "Preparing review…" : "Review collection creation"}</button>}
    </section>
}
