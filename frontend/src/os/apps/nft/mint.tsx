import { useEffect, useState } from "react"
import { clearGovernanceReceipt, readGovernanceReceipt } from "../../../lib/dao/governanceRecovery"
import { feeForGasWanted, networkGasPrice } from "../../../lib/grc20"
import { formatGnotPrice } from "../../../lib/launchpadListing"
import { mintFixedRequest, mintFixedScope, primaryMintSplit, readNativeMintReadiness, validateNativeMint,
    MINT_FIXED_GAS_WANTED, type NativeMintReadiness } from "../../../lib/launchpadPrimaryMint"
import { txExplorerUrl } from "../../../lib/txExplorerUrl"
import type { NativeViewProps } from "../../native/types"
import { useSigner } from "../../sign/signerContext"
import { ErrorState, Loading } from "../../kit"

function utc(seconds: bigint): string {
    const date = new Date(Number(seconds) * 1000)
    return Number.isFinite(date.valueOf()) ? date.toISOString() : `${seconds.toString()} Unix seconds`
}

export default function MintLaunchpadNFT({ rpcUrl, session, available, toast }: {
    rpcUrl: string; session: NativeViewProps["session"]; available: boolean; toast: (message: string) => void
}) {
    const signer = useSigner()
    const [collectionID, setCollectionID] = useState("")
    const [stageNumber, setStageNumber] = useState("")
    const [selected, setSelected] = useState<{ collection: string; index: number } | null>(null)
    const [revision, setRevision] = useState(0)
    const [readiness, setReadiness] = useState<NativeMintReadiness | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(false)
    const [preparing, setPreparing] = useState(false)
    const [checkedOutcome, setCheckedOutcome] = useState(false)
    const [, refreshReceipt] = useState(0)
    const buyer = session.status === "member" ? session.address : ""
    useEffect(() => {
        if (!available || !selected || !buyer) return
        let cancelled = false
        void readNativeMintReadiness(rpcUrl, selected.collection, selected.index, buyer).then((value) => {
            if (!cancelled) { setReadiness(value); setLoading(false); setError(false) }
        }).catch(() => { if (!cancelled) { setReadiness(null); setLoading(false); setError(true) } })
        return () => { cancelled = true }
    }, [available, rpcUrl, selected, revision, buyer])
    const refresh = () => { setLoading(true); setRevision((value) => value + 1) }
    if (!available) return <div className="os-note os-warn" role="note">Primary minting awaits the reviewed NFT, drops, policy and fees realms on this network.</div>
    if (session.status !== "member") return <div className="os-stack"><p>Connect a wallet to check mint eligibility and claim an NFT.</p><button type="button" className="os-btn" onClick={session.openConnect}>Connect wallet</button></div>
    const chosenIndex = /^[1-9]\d*$/.test(stageNumber) ? Number(stageNumber) - 1 : -1
    const current = selected?.collection === collectionID && selected.index === chosenIndex ? readiness : null
    let unavailable = ""
    if (current) { try { validateNativeMint(current) } catch (cause) { unavailable = cause instanceof Error ? cause.message : "Mint unavailable" } }
    const split = current ? primaryMintSplit(current.stage.price, current.terms.primaryFeeBPS) : null
    const receipt = current ? readGovernanceReceipt(mintFixedScope(session.network.chainId, current)) : null
    return <section className="os-stack" aria-label="Mint Launchpad NFT">
        <div><h1>Mint from a drop</h1><p className="os-sub">Check a collection and stage directly on chain. One mint creates one token for your connected wallet, including Soulbound claims.</p></div>
        <label>Collection ID <input value={collectionID} onChange={(event) => setCollectionID(event.target.value.trim())} placeholder="C1" /></label>
        <label>Stage number <input value={stageNumber} inputMode="numeric" onChange={(event) => setStageNumber(event.target.value.trim())} placeholder="1" /></label>
        <button type="button" className="os-btn os-quiet" disabled={!/^C[1-9]\d*$/.test(collectionID) || chosenIndex < 0 || chosenIndex >= 10 || loading} onClick={() => {
            setReadiness(null); setError(false); setLoading(true); setSelected({ collection: collectionID, index: chosenIndex }); setRevision((value) => value + 1)
        }}>Check mint eligibility</button>
        {loading && <Loading label="Checking collection, stage and DAO policy…" />}
        {error && <ErrorState message="Could not verify this mint from chain." onRetry={refresh} />}
        {current && split && <div className="os-stack os-note">
            <strong>{current.collection.name} · {current.collection.id} · stage {current.stage.index + 1}</strong>
            <span>Creator <code>{current.collection.creator}</code></span>
            <span>{current.collection.mode === "soulbound" ? "Soulbound · your wallet claims; no transfer or trading" : "Open · transferable after mint"}</span>
            <span>Window {utc(current.stage.start)} → {utc(current.stage.end)}</span>
            <span>Price {current.stage.price === 0n ? "Free" : formatGnotPrice(current.stage.price)} + network gas</span>
            <span>Creator credit {formatGnotPrice(split.creator)} · DAO fee {formatGnotPrice(split.protocol)} ({current.terms.primaryFeeBPS.toString()} bps)</span>
            <span>DAO treasury <code>{current.terms.treasury}</code></span>
            <span>Your mints: {current.claimed.toString()} of {current.stage.perWallet.toString()} · stage minted: {current.stage.minted.toString()}{current.stage.supplyCap === 0n ? "" : ` of ${current.stage.supplyCap.toString()}`}</span>
            {unavailable && <span className="os-warn" role="status">{unavailable}</span>}
            <p className="os-sub">Collection media and provenance are creator-supplied. Check the issuer and collection ID before minting.</p>
        </div>}
        {current && (receipt ? <div className="os-stack os-note os-warn" role="status"><strong>Previous mint needs review</strong>
            <span>Check the transaction and token before another attempt.</span>
            {receipt.hash && (txExplorerUrl(receipt.hash, session.network.chainId) ?
                <a href={txExplorerUrl(receipt.hash, session.network.chainId)!} target="_blank" rel="noopener noreferrer">View transaction</a> : <code>{receipt.hash}</code>)}
            <label className="os-ack"><input type="checkbox" checked={checkedOutcome} onChange={(event) => setCheckedOutcome(event.target.checked)} /> I checked the chain and know whether this mint succeeded.</label>
            <button type="button" className="os-btn os-quiet" disabled={!checkedOutcome} onClick={() => {
                try { clearGovernanceReceipt(mintFixedScope(session.network.chainId, current)); setCheckedOutcome(false);
                    refreshReceipt((value) => value + 1); refresh() }
                catch { /* in-flight wallet action remains locked */ }
            }}>Review another mint</button>
        </div> : <button type="button" className="os-btn" disabled={preparing || loading || unavailable !== ""} onClick={() => {
            setPreparing(true)
            void networkGasPrice(session.network.chainId, [rpcUrl]).then((gasPrice) => {
                signer.sign(mintFixedRequest({ readiness: current, rpcUrl, chainId: session.network.chainId,
                    estimatedGasFeeUgnot: feeForGasWanted(MINT_FIXED_GAS_WANTED, gasPrice), onSettled: refresh }))
            }).catch((cause) => toast(cause instanceof Error ? cause.message : "Could not prepare primary mint."))
                .finally(() => setPreparing(false))
        }}>{preparing ? "Preparing review…" : current.collection.mode === "soulbound" ? "Review Soulbound claim" : "Review primary mint"}</button>)}
    </section>
}
