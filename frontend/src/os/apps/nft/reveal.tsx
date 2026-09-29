import { useState } from "react"
import { clearGovernanceReceipt, readGovernanceReceipt, type GovernanceScope } from "../../../lib/dao/governanceRecovery"
import { feeForGasWanted, networkGasPrice } from "../../../lib/grc20"
import type { LaunchpadNftCollection } from "../../../lib/launchpadNft"
import { freezeMetadataRequest, freezeMetadataScope, prepareRevealMetadataRequest, revealMetadataScope,
    NFT_METADATA_GAS_WANTED } from "../../../lib/launchpadNftReveal"
import { txExplorerUrl } from "../../../lib/txExplorerUrl"
import { useSigner } from "../../sign/signerContext"

function PendingAction({ scope, label, chainId, onClear }: { scope: GovernanceScope; label: string;
    chainId: string; onClear: () => void }) {
    const [checked, setChecked] = useState(false)
    const receipt = readGovernanceReceipt(scope)
    if (!receipt) return null
    const explorer = receipt.hash ? txExplorerUrl(receipt.hash, chainId) : null
    return <div className="os-stack os-note os-warn" role="status">
        <strong>{label} needs chain review</strong>
        <span>Check the transaction and collection record before another attempt.</span>
        {receipt.hash && (explorer ? <a href={explorer} target="_blank" rel="noopener noreferrer">View transaction</a> : <code>{receipt.hash}</code>)}
        <label className="os-ack"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} /> I checked the chain and know whether this action succeeded.</label>
        <button type="button" className="os-btn os-quiet" disabled={!checked} onClick={() => {
            try { clearGovernanceReceipt(scope); setChecked(false); onClear() }
            catch { /* in-flight wallet action remains locked */ }
        }}>Review another metadata action</button>
    </div>
}

export default function RevealCollectionPanel({ collection, creator, rpcUrl, chainId, toast, refresh }: {
    collection: LaunchpadNftCollection; creator: string; rpcUrl: string; chainId: string;
    toast: (message: string) => void; refresh: () => void
}) {
    const signer = useSigner()
    const [baseURI, setBaseURI] = useState("")
    const [preparing, setPreparing] = useState(false)
    const [, redraw] = useState(0)
    if (collection.metadataMode !== "reveal_base" || collection.creator !== creator) return null
    const revealScope = revealMetadataScope(chainId, collection)
    const freezeScope = freezeMetadataScope(chainId, collection)
    const revealPending = readGovernanceReceipt(revealScope) !== null
    const freezePending = readGovernanceReceipt(freezeScope) !== null
    return <section className="os-stack os-note" aria-label="Collection metadata reveal">
        <h2>Metadata commitment</h2>
        <span>Committed base URI SHA-256 <code style={{ overflowWrap: "anywhere" }}>{collection.baseURICommitment}</code></span>
        <span>Provenance manifest SHA-256 <code style={{ overflowWrap: "anywhere" }}>{collection.provenanceHash}</code></span>
        <p className="os-sub">The realm verifies the exact future IPFS base URI, not the contents of the files or provenance manifest. Check that each numbered JSON file is available and correct.</p>
        <PendingAction scope={revealScope} label="Previous reveal" chainId={chainId} onClear={() => { redraw((value) => value + 1); refresh() }} />
        <PendingAction scope={freezeScope} label="Previous freeze" chainId={chainId} onClear={() => { redraw((value) => value + 1); refresh() }} />
        {!collection.revealed ? <>
            <label>Committed IPFS base URI <input value={baseURI} onChange={(event) => setBaseURI(event.target.value.trim())} placeholder="ipfs://collection/" /></label>
            {baseURI && <span className="os-sub">First token will use <code style={{ overflowWrap: "anywhere" }}>{baseURI}1.json</code></span>}
            <button type="button" className="os-btn" disabled={preparing || revealPending || !baseURI} onClick={() => {
                setPreparing(true)
                void networkGasPrice(chainId, [rpcUrl]).then((gasPrice) => prepareRevealMetadataRequest({
                    collection, creator, baseURI, rpcUrl, chainId,
                    estimatedGasFeeUgnot: feeForGasWanted(NFT_METADATA_GAS_WANTED, gasPrice), onSettled: refresh,
                })).then((request) => signer.sign(request))
                    .catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare metadata reveal."))
                    .finally(() => setPreparing(false))
            }}>{preparing ? "Checking commitment…" : "Review metadata reveal"}</button>
        </> : collection.metadataFrozen ? <p>Metadata revealed and frozen.</p> : <>
            <span>Revealed base URI <code style={{ overflowWrap: "anywhere" }}>{collection.baseURI}</code></span>
            <p className="os-sub">Reveal enables minting. After checking the full collection, record finalization with a separate wallet action.</p>
            <button type="button" className="os-btn" disabled={preparing || revealPending || freezePending} onClick={() => {
                setPreparing(true)
                void networkGasPrice(chainId, [rpcUrl]).then((gasPrice) => signer.sign(freezeMetadataRequest({
                    collection, creator, rpcUrl, chainId,
                    estimatedGasFeeUgnot: feeForGasWanted(NFT_METADATA_GAS_WANTED, gasPrice), onSettled: refresh,
                }))).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare metadata freeze."))
                    .finally(() => setPreparing(false))
            }}>{preparing ? "Preparing review…" : "Review metadata freeze"}</button>
        </>}
    </section>
}
